/**
 * Main extension entrypoint.
 *
 * Owns remote compaction and Responses payload history replay. It deliberately
 * does not register providers or choose HTTP versus WebSocket transport.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  applyRemoteHistoryPayloadPatch,
  extractRemoteCompactionTextConfig,
  extractResponsesReasoningConfig,
  extractResponsesServiceTier,
  isRecord,
  looksLikeResponsesPayload,
  messageMatchesModel,
  modelKey,
  supportsRemoteCompactionModel,
  thinkingLevelToResponsesReasoning,
} from "./openai.ts";
import {
  buildRemoteCompactionDetails,
  buildToolsPayload,
  callRemoteCompactionEndpoint,
  REMOTE_COMPACTION_CHECKPOINT_SUMMARY,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  reconstructRemoteCompactionStateFromBranch,
  type ResponseItem,
} from "./remote-compaction.ts";
import {
  clearAllRuntimeState,
  clearRemoteCompactionState,
  clearResponsesRequestShapeState,
  getRemoteCompactionState,
  getResponsesRequestShapeState,
  setRemoteCompactionState,
  setResponsesRequestShapeState,
} from "./state.ts";

type TargetModel = Parameters<typeof modelKey>[0];
type ResponsesModel = Exclude<Parameters<typeof messagesToResponseItems>[1], undefined>;

type BranchEntry = {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  details?: unknown;
  message?: unknown;
  thinkingLevel?: unknown;
  summary?: unknown;
};

type SessionContextLike = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): BranchEntry[];
  };
};

function getSessionId(ctx: SessionContextLike): string {
  return ctx.sessionManager.getSessionId();
}

function getBranchThinkingLevel(branchEntries: BranchEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry?.type !== "thinking_level_change") continue;
    return typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
  }
  return undefined;
}

function syncRemoteState(ctx: SessionContextLike): void {
  const sessionId = getSessionId(ctx);
  const branchEntries = ctx.sessionManager.getBranch() as Array<{
    type: string;
    id: string;
    details?: unknown;
    message?: AgentMessage;
  }>;
  const state = reconstructRemoteCompactionStateFromBranch({ branchEntries });
  if (state) {
    setRemoteCompactionState(sessionId, state);
  } else {
    clearRemoteCompactionState(sessionId);
  }
}

function getMatchingRemoteState(
  sessionId: string,
  model: TargetModel | undefined,
): ReturnType<typeof getRemoteCompactionState> {
  if (!model) return undefined;
  const remoteState = getRemoteCompactionState(sessionId);
  return remoteState && remoteState.modelKey === modelKey(model) ? remoteState : undefined;
}

function getMatchingResponsesRequestShape(
  sessionId: string,
  model: TargetModel,
): ReturnType<typeof getResponsesRequestShapeState> {
  const requestShape = getResponsesRequestShapeState(sessionId);
  return requestShape?.modelKey === modelKey(model) ? requestShape : undefined;
}

function isCheckpointInputItem(item: ResponseItem | undefined): boolean {
  if (item?.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) {
    return false;
  }
  return item.content.some((part) => (
    part.type === "input_text" && part.text.includes(REMOTE_COMPACTION_CHECKPOINT_SUMMARY)
  ));
}

function getExpectedReplayReplacementSpan(params: {
  branchEntries: BranchEntry[];
  compactionEntryId: string;
  model: ResponsesModel;
}): ResponseItem[] | undefined {
  const compactionEntry = params.branchEntries.find(
    (entry) => entry.id === params.compactionEntryId,
  );
  if (
    compactionEntry?.type !== "compaction" ||
    compactionEntry.summary !== REMOTE_COMPACTION_CHECKPOINT_SUMMARY
  ) {
    return undefined;
  }

  try {
    const checkpointContext = buildSessionContext(
      params.branchEntries as Parameters<typeof buildSessionContext>[0],
      params.compactionEntryId,
    );
    const expectedReplayReplacementSpan = normalizeResponseItemsForPrompt(
      messagesToResponseItems(convertToLlm(checkpointContext.messages), params.model),
      params.model,
    );
    return isCheckpointInputItem(expectedReplayReplacementSpan[0])
      ? expectedReplayReplacementSpan
      : undefined;
  } catch {
    return undefined;
  }
}

function getCompatibleNativeReplayTailMessages(params: {
  branchEntries: Parameters<typeof buildSessionContext>[0];
  compactionEntryId: string;
  model: TargetModel;
}): AgentMessage[] {
  const compactionIndex = params.branchEntries.findIndex(
    (entry) => entry.id === params.compactionEntryId,
  );
  if (compactionIndex < 0) return [];

  const trailingContext = buildSessionContext(params.branchEntries.slice(compactionIndex + 1));
  const compatibleMessages: AgentMessage[] = [];
  let pendingMessages: AgentMessage[] = [];

  for (const message of trailingContext.messages) {
    if (message.role !== "assistant") {
      pendingMessages.push(message);
      continue;
    }

    if (messageMatchesModel(message, params.model)) {
      compatibleMessages.push(...pendingMessages, message);
    }
    pendingMessages = [];
  }

  compatibleMessages.push(...pendingMessages);
  return compatibleMessages;
}

export default function openaiServerCompactionExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    clearResponsesRequestShapeState(getSessionId(ctx));
    syncRemoteState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    clearResponsesRequestShapeState(getSessionId(ctx));
    syncRemoteState(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    syncRemoteState(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    clearResponsesRequestShapeState(getSessionId(ctx));
  });

  pi.on("session_shutdown", () => {
    clearAllRuntimeState();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.signal.aborted) return { cancel: true };

    const model = ctx.model;
    if (!model || !supportsRemoteCompactionModel(model)) return undefined;

    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (event.signal.aborted) return { cancel: true };
      if (!auth.ok) throw new Error(auth.error);

      const allTools = pi.getAllTools();
      const responsesCompat = model.compat as OpenAIResponsesCompat | undefined;
      const tools = buildToolsPayload(
        allTools,
        pi.getActiveTools(),
        responsesCompat?.supportsStrictMode ?? false,
      );
      const sessionId = getSessionId(ctx);
      const branchEntries = event.branchEntries as BranchEntry[];
      const remoteState = getMatchingRemoteState(sessionId, model);
      const contextMessages = remoteState
        ? getCompatibleNativeReplayTailMessages({
            branchEntries: event.branchEntries,
            compactionEntryId: remoteState.compactionEntryId,
            model,
          })
        : buildSessionContext(event.branchEntries).messages;
      const effectiveMessages = convertToLlm(contextMessages);
      const convertedResponseItems = messagesToResponseItems(effectiveMessages, model);
      const responseItems = remoteState
        ? [...remoteState.replacementHistory, ...convertedResponseItems]
        : convertedResponseItems;
      const observedRequestShape = getMatchingResponsesRequestShape(sessionId, model);
      const promptResponseItems = normalizeResponseItemsForPrompt(responseItems, model);
      const thinkingLevel = pi.getThinkingLevel();
      const fallbackReasoning = model.reasoning
        ? thinkingLevelToResponsesReasoning(
            model,
            thinkingLevel ?? getBranchThinkingLevel(branchEntries),
          )
        : undefined;
      const reasoning = observedRequestShape?.reasoning ?? fallbackReasoning;
      const text = observedRequestShape?.text;
      const serviceTier = observedRequestShape?.serviceTier;
      const customInstructions = event.customInstructions?.trim();
      const instructions = customInstructions
        ? `${ctx.getSystemPrompt()}\n\nAdditional user guidance for this compaction request:\n${customInstructions}`
        : ctx.getSystemPrompt();

      const remoteResult = await callRemoteCompactionEndpoint({
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        baseUrl: auth.baseUrl,
        sessionId,
        input: promptResponseItems,
        instructions,
        tools,
        parallelToolCalls: true,
        reasoning,
        text,
        serviceTier,
        signal: event.signal,
        onRetry: ({ attempt, maxRetries, delayMs, error }) => {
          if (!ctx.hasUI) return;
          ctx.ui.notify(
            `OpenAI remote compaction retry ${attempt}/${maxRetries} in ${Math.round(delayMs)}ms. ${error.message}`,
            "warning",
          );
        },
      });
      if (event.signal.aborted) return { cancel: true };

      const remoteDetails = buildRemoteCompactionDetails(
        model,
        remoteResult.output,
        remoteResult.usage,
      );
      return {
        compaction: {
          summary: REMOTE_COMPACTION_CHECKPOINT_SUMMARY,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: remoteResult.usage,
          details: { remoteCompaction: remoteDetails },
        },
      };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`OpenAI remote compaction failed; local fallback was skipped. ${message}`, "error");
      }
      return { cancel: true };
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (
      !model ||
      !supportsRemoteCompactionModel(model) ||
      !isRecord(event.payload) ||
      !looksLikeResponsesPayload(event.payload)
    ) {
      return undefined;
    }

    const sessionId = getSessionId(ctx);
    setResponsesRequestShapeState(sessionId, {
      modelKey: modelKey(model),
      updatedAt: Date.now(),
      reasoning: extractResponsesReasoningConfig(event.payload),
      text: extractRemoteCompactionTextConfig(event.payload),
      serviceTier: extractResponsesServiceTier(event.payload),
    });

    const remoteState = getMatchingRemoteState(sessionId, model);
    if (!remoteState) return undefined;

    const expectedReplayReplacementSpan = getExpectedReplayReplacementSpan({
      branchEntries: ctx.sessionManager.getBranch() as BranchEntry[],
      compactionEntryId: remoteState.compactionEntryId,
      model,
    });
    const replacementHistory = normalizeResponseItemsForPrompt(
      remoteState.replacementHistory,
      model,
    ) as unknown[];
    const payload = expectedReplayReplacementSpan
      ? applyRemoteHistoryPayloadPatch({
          payload: event.payload,
          expectedReplayReplacementSpan,
          replacementHistory,
        })
      : undefined;
    if (!payload) {
      const warning =
        "OpenAI native replay was not injected because its replay replacement span could not be matched safely; the original provider input was preserved.";
      if (ctx.hasUI) {
        ctx.ui.notify(warning, "warning");
      } else {
        console.warn(warning);
      }
      return undefined;
    }
    return payload;
  });
}
