/**
 * Main extension entrypoint.
 *
 * Owns remote compaction and Responses payload history replay. It deliberately
 * does not register providers or choose HTTP versus WebSocket transport.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  applyRemoteHistoryPayloadPatch,
  extractResponsesReasoningConfig,
  extractResponsesTextConfig,
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
  messageToResponseItems,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  reconstructRemoteCompactionStateFromBranch,
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

type BranchEntry = {
  type: string;
  id: string;
  details?: unknown;
  message?: unknown;
  thinkingLevel?: unknown;
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

function getBranchMessages(branchEntries: BranchEntry[]): AgentMessage[] {
  return branchEntries.flatMap((entry) =>
    entry.type === "message" && entry.message ? [entry.message as AgentMessage] : [],
  );
}

function getBranchThinkingLevel(branchEntries: BranchEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry?.type !== "thinking_level_change") continue;
    return typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
  }
  return undefined;
}

function clearSessionRuntimeState(sessionId: string | undefined): void {
  clearRemoteCompactionState(sessionId);
  clearResponsesRequestShapeState(sessionId);
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

function extendRemoteHistoryIfCompatible(params: {
  sessionId: string;
  model: TargetModel | undefined;
  message: AgentMessage;
}): void {
  const remoteState = getMatchingRemoteState(params.sessionId, params.model);
  if (!remoteState || !params.model) return;
  if (params.message.role === "assistant" && !messageMatchesModel(params.message, params.model)) {
    return;
  }

  const items = messageToResponseItems(params.message);
  if (items.length === 0) return;

  setRemoteCompactionState(params.sessionId, {
    ...remoteState,
    explicitHistory: [...remoteState.explicitHistory, ...items],
  });
}

export default function openaiServerCompactionExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    clearResponsesRequestShapeState(getSessionId(ctx));
    syncRemoteState(ctx);
  });

  const clearBeforeSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearSessionRuntimeState(getSessionId(ctx));
  };
  pi.on("session_before_switch", clearBeforeSessionChange);
  pi.on("session_before_fork", clearBeforeSessionChange);
  pi.on("session_before_tree", clearBeforeSessionChange);

  const syncAfterSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    syncRemoteState(ctx);
  };
  pi.on("session_tree", syncAfterSessionChange);
  pi.on("session_compact", syncAfterSessionChange);

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

      const tools = buildToolsPayload(pi.getAllTools(), pi.getActiveTools());
      const sessionId = getSessionId(ctx);
      const branchEntries = event.branchEntries as BranchEntry[];
      const fullBranchMessages = getBranchMessages(branchEntries);
      const remoteState = getMatchingRemoteState(sessionId, model);
      const observedRequestShape = getResponsesRequestShapeState(sessionId);
      const responseItems = remoteState
        ? remoteState.explicitHistory
        : messagesToResponseItems(fullBranchMessages);
      const promptResponseItems = normalizeResponseItemsForPrompt(responseItems, model);
      const thinkingLevel = pi.getThinkingLevel();
      const fallbackReasoning = model.reasoning
        ? thinkingLevelToResponsesReasoning(thinkingLevel ?? getBranchThinkingLevel(branchEntries))
        : undefined;
      const reasoning = observedRequestShape?.reasoning ?? fallbackReasoning;
      const text = observedRequestShape?.text;
      const customInstructions = event.customInstructions?.trim();
      const instructions = customInstructions
        ? `${ctx.getSystemPrompt()}\n\nAdditional user guidance for this compaction request:\n${customInstructions}`
        : ctx.getSystemPrompt();

      const remoteResult = await callRemoteCompactionEndpoint({
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        sessionId,
        input: promptResponseItems,
        instructions,
        tools,
        parallelToolCalls: true,
        reasoning,
        text,
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

  pi.on("message_end", (event, ctx) => {
    extendRemoteHistoryIfCompatible({
      sessionId: getSessionId(ctx),
      model: ctx.model,
      message: event.message,
    });
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
      updatedAt: Date.now(),
      reasoning: extractResponsesReasoningConfig(event.payload),
      text: extractResponsesTextConfig(event.payload),
    });

    const remoteState = getMatchingRemoteState(sessionId, model);
    if (!remoteState) return undefined;

    const payload = applyRemoteHistoryPayloadPatch({
      payload: event.payload,
      explicitHistory: normalizeResponseItemsForPrompt(remoteState.explicitHistory, model) as unknown[],
    });
    return payload;
  });
}
