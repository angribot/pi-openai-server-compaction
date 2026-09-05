import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  prepareCompactionReplay,
  prepareNativeReplay,
  remoteCompactionOperationKind,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  resolveCodexCompactionCompatibilityClass,
  type BranchEntry,
  type CompactionCompatibilityResolver,
  type NativeReplayCheckpointDetails,
  type ReplayCheckpoint,
  type ReplayEvidenceRecord,
} from "./native-replay.ts";
import type {
  RemoteCompactionAttempt,
  RemoteCompactionAttemptOutcome,
  RemoteCompactionRequest,
} from "./remote-compaction-operation.ts";
import { projectCompactableContext, type ResponsesItem } from "./responses-projection.ts";

export {
  NATIVE_REPLAY_CHECKPOINT_FORMAT,
  NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  remoteCompactionOperationKind,
  resolveCodexCompactionCompatibilityClass,
  type CompactionCompatibilityResolver,
  type NativeReplayCheckpointDetails,
  type RemoteCompactionApi,
  type RemoteCompactionModelKey,
  type RemoteCompactionOperationKind,
} from "./native-replay.ts";

const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const BASE_RETRY_DELAY_MS = 200;

type HookContext = {
  model?: Model<any>;
  hasUI: boolean;
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  modelRegistry: Parameters<RemoteCompactionAttempt>[1]["modelRegistry"];
  sessionManager: { getBranch(): BranchEntry[]; getSessionId(): string };
  getSystemPrompt(): string;
  abort(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportError(context: HookContext, message: string): void {
  if (context.hasUI) context.ui.notify(message, "error");
  else console.error(message);
}

function reportWarning(context: HookContext, message: string): void {
  if (context.hasUI) context.ui.notify(message, "warning");
  else console.warn(message);
}

function hardStop(context: HookContext, reason: string): undefined {
  reportError(
    context,
    `Remote compaction native replay stopped because ${reason}. Start a new session or return to a complete pre-checkpoint branch point.`,
  );
  context.abort();
  return undefined;
}

function appendCompatibilityDecision(
  pi: ExtensionAPI,
  context: HookContext,
  evidence: ReplayEvidenceRecord,
): boolean {
  try {
    pi.appendEntry(evidence.customType, evidence.data);
    return true;
  } catch {
    hardStop(context, "request-time compatibility evidence could not be persisted");
    return false;
  }
}

function containsCheckpointMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes(REMOTE_COMPACTION_CHECKPOINT_MARKER);
  if (Array.isArray(value)) return value.some(containsCheckpointMarker);
  return isRecord(value) && Object.values(value).some(containsCheckpointMarker);
}

function checkpointSpan(
  branch: readonly BranchEntry[],
  state: ReplayCheckpoint,
  model: Model<any>,
): ResponsesItem[] | undefined {
  if (
    typeof state.entry.firstKeptEntryId !== "string" ||
    !branch.slice(0, state.entryIndex).some((entry) => entry.id === state.entry.firstKeptEntryId)
  ) {
    return undefined;
  }

  try {
    const context = buildSessionContext(
      branch as Parameters<typeof buildSessionContext>[0],
      state.entry.id,
    );
    const span = projectCompactableContext(context.messages, model);
    const first = span[0];
    return first && containsCheckpointMarker(first) ? span : undefined;
  } catch {
    return undefined;
  }
}

function wireValue(value: unknown): unknown | undefined {
  try {
    const serialized = JSON.parse(JSON.stringify(value)) as unknown;
    if (
      isRecord(serialized) &&
      !("type" in serialized) &&
      typeof serialized.role === "string" &&
      "content" in serialized
    ) {
      return { ...serialized, type: "message" };
    }
    return serialized;
  } catch {
    return undefined;
  }
}

function wireEquivalent(left: unknown, right: unknown): boolean {
  const serializedLeft = wireValue(left);
  const serializedRight = wireValue(right);
  return (
    serializedLeft !== undefined &&
    serializedRight !== undefined &&
    isDeepStrictEqual(serializedLeft, serializedRight)
  );
}

function findUniqueSpan(
  input: readonly unknown[],
  expected: readonly unknown[],
): number | undefined {
  if (expected.length === 0 || expected.length > input.length) return undefined;
  let match: number | undefined;
  const lastStart = input.length - expected.length;
  for (let start = 0; start <= lastStart; start++) {
    if (!expected.every((item, offset) => wireEquivalent(input[start + offset], item))) continue;
    if (match !== undefined) return undefined;
    match = start;
  }
  return match;
}

function combineInstructions(systemPrompt: string, customInstructions: string | undefined): string {
  const custom = customInstructions?.trim();
  return custom
    ? `${systemPrompt}\n\nAdditional compaction instructions:\n${custom}`
    : systemPrompt;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function immutableRequest(request: RemoteCompactionRequest): RemoteCompactionRequest {
  return deepFreeze(structuredClone(request));
}

function retryDelay(
  outcome: Extract<RemoteCompactionAttemptOutcome, { kind: "retryable" }>,
  retry: number,
): number {
  if (typeof outcome.retryAfterMs === "number" && Number.isFinite(outcome.retryAfterMs)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, outcome.retryAfterMs));
  }
  const base = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.max(0, retry - 1));
  return Math.min(MAX_RETRY_DELAY_MS, Math.floor(base * (0.75 + Math.random() * 0.5)));
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function suffixMessages(branch: readonly BranchEntry[], state: ReplayCheckpoint): AgentMessage[] {
  if (state.entryIndex >= branch.length - 1) return [];
  return buildSessionContext(
    branch.slice(state.entryIndex + 1) as Parameters<typeof buildSessionContext>[0],
  ).messages;
}

function buildRequest(
  event: {
    branchEntries: BranchEntry[];
    customInstructions?: string;
  },
  context: HookContext,
  model: Model<any>,
  state: ReplayCheckpoint | undefined,
): RemoteCompactionRequest {
  let projected: ResponsesItem[];
  if (state) {
    projected = [
      ...state.replacementHistory,
      ...projectCompactableContext(suffixMessages(event.branchEntries, state), model),
    ];
  } else {
    const session = buildSessionContext(
      event.branchEntries as Parameters<typeof buildSessionContext>[0],
    );
    projected = projectCompactableContext(session.messages, model);
  }
  // Remote compaction is a Responses protocol operation, not a model turn.
  // Do not send Pi's active tools: some built-in tool schemas use regex
  // lookaround, which OpenAI's Responses schema validator rejects.
  return immutableRequest({
    model,
    input: [...projected, { type: "compaction_trigger" }],
    instructions: combineInstructions(context.getSystemPrompt(), event.customInstructions),
    store: false,
  });
}

function successResult(
  event: {
    preparation: { firstKeptEntryId: string; tokensBefore: number };
  },
  details: NativeReplayCheckpointDetails,
  accepted: Extract<RemoteCompactionAttemptOutcome, { kind: "accepted" }>,
): {
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    usage?: Usage;
    details: NativeReplayCheckpointDetails;
  };
} {
  return {
    compaction: {
      summary: REMOTE_COMPACTION_CHECKPOINT_MARKER,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      ...(accepted.usage ? { usage: accepted.usage } : {}),
      details,
    },
  };
}

export function installRemoteCompaction(
  pi: ExtensionAPI,
  attempt: RemoteCompactionAttempt,
  resolveCompatibilityClassForModel: CompactionCompatibilityResolver = resolveCodexCompactionCompatibilityClass,
): void {
  pi.on("session_before_compact", async (event, rawContext) => {
    const context = rawContext as unknown as HookContext;
    const model = context.model;
    if (!model || remoteCompactionOperationKind(model) === undefined) return undefined;
    if (event.signal.aborted) return { cancel: true };

    const branchEntries = event.branchEntries as BranchEntry[];
    const preparation = prepareCompactionReplay(
      branchEntries,
      model,
      resolveCompatibilityClassForModel,
    );
    if (preparation.kind === "invalid-model") {
      reportError(context, "Remote compaction requires a non-empty structured model identity.");
      return { cancel: true };
    }
    if (preparation.kind === "broken") {
      reportError(context, `Remote compaction was cancelled because ${preparation.reason}.`);
      return { cancel: true };
    }
    if (preparation.kind === "invalidated") {
      reportError(
        context,
        "Remote compaction was cancelled because a persisted incompatible assistant turn invalidated native replay.",
      );
      return { cancel: true };
    }
    if (preparation.kind === "incompatible") {
      reportWarning(
        context,
        "Remote compaction was cancelled because the selected model is incompatible with the active checkpoint.",
      );
      return { cancel: true };
    }

    let request: RemoteCompactionRequest;
    try {
      request = buildRequest(
        {
          branchEntries,
          customInstructions: event.customInstructions,
        },
        context,
        model,
        preparation.replay,
      );
    } catch (error) {
      if (!event.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(context, `Remote compaction preparation failed. ${message}`);
      }
      return { cancel: true };
    }

    for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex++) {
      if (event.signal.aborted) return { cancel: true };
      let outcome: RemoteCompactionAttemptOutcome;
      try {
        outcome = await attempt(request, {
          modelRegistry: context.modelRegistry,
          sessionId: context.sessionManager.getSessionId(),
          signal: event.signal,
        });
      } catch (error) {
        if (!event.signal.aborted) {
          reportError(
            context,
            `Remote compaction operation failed unexpectedly. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return { cancel: true };
      }

      if (event.signal.aborted) return { cancel: true };
      if (outcome.kind === "accepted") {
        return successResult(event, preparation.createCheckpointDetails(outcome.item), outcome);
      }
      if (outcome.kind === "terminal" || attemptIndex === MAX_ATTEMPTS - 1) {
        reportError(
          context,
          `Remote compaction failed; no text fallback was used. ${outcome.error.message}`,
        );
        return { cancel: true };
      }

      try {
        await abortableDelay(retryDelay(outcome, attemptIndex + 1), event.signal);
      } catch {
        return { cancel: true };
      }
    }

    return { cancel: true };
  });

  pi.on("before_provider_request", (event, rawContext) => {
    const context = rawContext as unknown as HookContext;
    const model = context.model;
    if (!model) return undefined;

    const branch = context.sessionManager.getBranch();
    const preparation = prepareNativeReplay(branch, model, resolveCompatibilityClassForModel);
    if (preparation.kind === "none") return undefined;
    if (preparation.kind === "broken") return hardStop(context, preparation.reason);
    if (preparation.kind === "invalidated") {
      return hardStop(
        context,
        "a persisted incompatible assistant turn invalidated the checkpoint",
      );
    }
    if (preparation.kind === "invalid-model") {
      return hardStop(context, "the selected model has an invalid structured identity");
    }
    if (preparation.evidence && !appendCompatibilityDecision(pi, context, preparation.evidence)) {
      return undefined;
    }
    if (preparation.kind === "incompatible") {
      reportWarning(
        context,
        "The selected model is incompatible with the active Remote compaction checkpoint. Pre-checkpoint context is unavailable; a successful assistant turn will invalidate native replay for this branch.",
      );
      return undefined;
    }

    if (!isRecord(event.payload) || !Array.isArray(event.payload.input)) {
      return hardStop(
        context,
        "the ordinary request does not contain a full-array Responses input",
      );
    }
    const state = preparation.replay;
    const expected = checkpointSpan(branch, state, model);
    if (!expected) {
      return hardStop(
        context,
        "the replay replacement span could not be reconstructed from the active branch",
      );
    }
    const matchStart = findUniqueSpan(event.payload.input, expected);
    if (matchStart === undefined) {
      return hardStop(context, "the replay replacement span was missing or ambiguous");
    }

    const patched: Record<string, unknown> = {
      ...event.payload,
      input: [
        ...event.payload.input.slice(0, matchStart),
        ...state.replacementHistory,
        ...event.payload.input.slice(matchStart + expected.length),
      ],
    };
    delete patched.messages;
    delete patched.previous_response_id;
    return patched;
  });
}
