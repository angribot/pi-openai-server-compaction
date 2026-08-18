import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  CompactionItem,
  RemoteCompactionAttempt,
  RemoteCompactionAttemptOutcome,
  RemoteCompactionRequest,
} from "./remote-compaction-operation.ts";
import {
  projectActiveFunctionTools,
  projectCompactableContext,
  type ResponsesItem,
} from "./responses-projection.ts";

export const REMOTE_COMPACTION_CHECKPOINT_MARKER =
  "[Remote Responses compaction checkpoint]\n\n" +
  "Detailed context before this checkpoint is retained in the native replay artifact and is available only to compatible Responses models.";

const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const BASE_RETRY_DELAY_MS = 200;

export type RemoteCompactionModelKey = {
  provider: string;
  api: "openai-responses";
  id: string;
};

export type RemoteCompactionDetails = {
  remoteCompaction: {
    version: 2;
    modelKey: RemoteCompactionModelKey;
    replacementHistory: [CompactionItem];
  };
};

type BranchEntry = {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  summary?: unknown;
  firstKeptEntryId?: unknown;
  tokensBefore?: unknown;
  details?: unknown;
  message?: AgentMessage;
};

type ValidReplayState = {
  kind: "valid";
  entry: BranchEntry;
  entryIndex: number;
  modelKey: RemoteCompactionModelKey;
  replacementHistory: [CompactionItem];
  invalidated: boolean;
};

type ActiveReplayState = { kind: "none" } | { kind: "broken"; reason: string } | ValidReplayState;

type HookContext = {
  model?: Model<any>;
  hasUI: boolean;
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  modelRegistry: Parameters<RemoteCompactionAttempt>[1]["modelRegistry"];
  sessionManager: { getBranch(): BranchEntry[] };
  getSystemPrompt(): string;
  abort(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isEligibleModel(model: unknown): model is Model<any> {
  return isRecord(model) && model.api === "openai-responses";
}

function modelKey(model: Model<any>): RemoteCompactionModelKey | undefined {
  if (
    typeof model.provider !== "string" ||
    !model.provider.trim() ||
    typeof model.id !== "string" ||
    !model.id.trim() ||
    model.api !== "openai-responses"
  ) {
    return undefined;
  }
  return { provider: model.provider, api: "openai-responses", id: model.id };
}

function sameModelKey(
  left: RemoteCompactionModelKey,
  right: { provider: string; api: string; id: string },
): boolean {
  return left.provider === right.provider && left.api === right.api && left.id === right.id;
}

function requestModelIdentity(
  model: unknown,
): { provider: string; api: string; id: string } | undefined {
  if (
    !isRecord(model) ||
    typeof model.provider !== "string" ||
    !model.provider.trim() ||
    typeof model.api !== "string" ||
    !model.api ||
    typeof model.id !== "string" ||
    !model.id.trim()
  ) {
    return undefined;
  }
  return { provider: model.provider, api: model.api, id: model.id };
}

function isCompactionItem(value: unknown): value is CompactionItem {
  return (
    isRecord(value) && value.type === "compaction" && typeof value.encrypted_content === "string"
  );
}

function decodeDetails(
  value: unknown,
): Omit<ValidReplayState, "kind" | "entry" | "entryIndex" | "invalidated"> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["remoteCompaction"])) return undefined;
  const remote = value.remoteCompaction;
  if (
    !isRecord(remote) ||
    !hasExactKeys(remote, ["version", "modelKey", "replacementHistory"]) ||
    remote.version !== 2 ||
    !isRecord(remote.modelKey) ||
    !hasExactKeys(remote.modelKey, ["provider", "api", "id"]) ||
    typeof remote.modelKey.provider !== "string" ||
    !remote.modelKey.provider.trim() ||
    remote.modelKey.api !== "openai-responses" ||
    typeof remote.modelKey.id !== "string" ||
    !remote.modelKey.id.trim() ||
    !Array.isArray(remote.replacementHistory) ||
    remote.replacementHistory.length !== 1 ||
    !isCompactionItem(remote.replacementHistory[0])
  ) {
    return undefined;
  }
  return {
    modelKey: {
      provider: remote.modelKey.provider,
      api: "openai-responses",
      id: remote.modelKey.id,
    },
    replacementHistory: [remote.replacementHistory[0]],
  };
}

function assistantInvalidates(entry: BranchEntry, owner: RemoteCompactionModelKey): boolean {
  const message = entry.message;
  return (
    entry.type === "message" &&
    message?.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted" &&
    (message.provider !== owner.provider || message.api !== owner.api || message.model !== owner.id)
  );
}

function deriveActiveReplayState(branch: readonly BranchEntry[]): ActiveReplayState {
  let latestIndex = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]?.type === "compaction") {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return { kind: "none" };

  const entry = branch[latestIndex];
  if (!entry) return { kind: "none" };
  if (entry.summary !== REMOTE_COMPACTION_CHECKPOINT_MARKER) return { kind: "none" };

  const decoded = decodeDetails(entry.details);
  if (!decoded) {
    return {
      kind: "broken",
      reason:
        "the latest Remote compaction checkpoint has missing, legacy, or malformed v2 details",
    };
  }

  return {
    kind: "valid",
    entry,
    entryIndex: latestIndex,
    ...decoded,
    invalidated: branch
      .slice(latestIndex + 1)
      .some((candidate) => assistantInvalidates(candidate, decoded.modelKey)),
  };
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

function containsCheckpointMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes(REMOTE_COMPACTION_CHECKPOINT_MARKER);
  if (Array.isArray(value)) return value.some(containsCheckpointMarker);
  return isRecord(value) && Object.values(value).some(containsCheckpointMarker);
}

function checkpointSpan(
  branch: readonly BranchEntry[],
  state: ValidReplayState,
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

function suffixMessages(branch: readonly BranchEntry[], state: ValidReplayState): AgentMessage[] {
  if (state.entryIndex >= branch.length - 1) return [];
  return buildSessionContext(
    branch.slice(state.entryIndex + 1) as Parameters<typeof buildSessionContext>[0],
  ).messages;
}

function buildRequest(
  pi: ExtensionAPI,
  event: {
    branchEntries: BranchEntry[];
    customInstructions?: string;
  },
  context: HookContext,
  model: Model<any>,
  state: ActiveReplayState,
): RemoteCompactionRequest {
  let projected: ResponsesItem[];
  if (state.kind === "valid") {
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
  const tools = projectActiveFunctionTools(pi.getAllTools(), pi.getActiveTools());
  return immutableRequest({
    model,
    input: [...projected, { type: "compaction_trigger" }],
    instructions: combineInstructions(context.getSystemPrompt(), event.customInstructions),
    ...(tools.length > 0 ? { tools } : {}),
    store: false,
  });
}

function successResult(
  event: {
    preparation: { firstKeptEntryId: string; tokensBefore: number };
  },
  key: RemoteCompactionModelKey,
  accepted: Extract<RemoteCompactionAttemptOutcome, { kind: "accepted" }>,
): {
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    usage?: Usage;
    details: RemoteCompactionDetails;
  };
} {
  return {
    compaction: {
      summary: REMOTE_COMPACTION_CHECKPOINT_MARKER,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      ...(accepted.usage ? { usage: accepted.usage } : {}),
      details: {
        remoteCompaction: {
          version: 2,
          modelKey: key,
          replacementHistory: [accepted.item],
        },
      },
    },
  };
}

export function installRemoteCompaction(pi: ExtensionAPI, attempt: RemoteCompactionAttempt): void {
  pi.on("session_before_compact", async (event, rawContext) => {
    const context = rawContext as unknown as HookContext;
    const model = context.model;
    if (!isEligibleModel(model)) return undefined;
    if (event.signal.aborted) return { cancel: true };

    const key = modelKey(model);
    if (!key) {
      reportError(context, "Remote compaction requires a non-empty structured model identity.");
      return { cancel: true };
    }

    const branchEntries = event.branchEntries as BranchEntry[];
    const state = deriveActiveReplayState(branchEntries);
    if (state.kind === "broken") {
      reportError(context, `Remote compaction was cancelled because ${state.reason}.`);
      return { cancel: true };
    }
    if (state.kind === "valid") {
      if (state.invalidated) {
        reportError(
          context,
          "Remote compaction was cancelled because a persisted incompatible assistant turn invalidated native replay.",
        );
        return { cancel: true };
      }
      if (!sameModelKey(state.modelKey, key)) {
        reportWarning(
          context,
          "Remote compaction was cancelled because the selected model is incompatible with the active checkpoint.",
        );
        return { cancel: true };
      }
    }

    let request: RemoteCompactionRequest;
    try {
      request = buildRequest(
        pi,
        {
          branchEntries,
          customInstructions: event.customInstructions,
        },
        context,
        model,
        state,
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
        return successResult(event, key, outcome);
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
    const state = deriveActiveReplayState(branch);
    if (state.kind === "none") return undefined;
    if (state.kind === "broken") return hardStop(context, state.reason);
    if (state.invalidated) {
      return hardStop(
        context,
        "a persisted incompatible assistant turn invalidated the checkpoint",
      );
    }

    const selectedKey = requestModelIdentity(model);
    if (!selectedKey)
      return hardStop(context, "the selected model has an invalid structured identity");
    if (!sameModelKey(state.modelKey, selectedKey)) {
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
