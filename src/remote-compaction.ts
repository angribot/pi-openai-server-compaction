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

export type RemoteCompactionApi = "openai-responses" | "openai-codex-responses";
export type RemoteCompactionOperationKind = "direct-responses" | "pi-codex-responses";

export type RemoteCompactionModelKey = {
  provider: string;
  api: RemoteCompactionApi;
  id: string;
};

export type CompactionCompatibilityResolver = (modelId: string) => string | undefined;

export const NATIVE_REPLAY_CHECKPOINT_FORMAT = "native-replay-checkpoint/1";
export const NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE = "native-replay-compatibility-decision/1";

const CODEX_COMPACTION_COMPATIBILITY_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  // OpenAI Codex catalog at 9b9b614b02ba04df55479284749c5cbbed695c24.
  "gpt-5.4": "2911",
  "gpt-5.4-mini": "2911",
  "gpt-5.5": "2911",
  "gpt-5.6-sol": "3000",
  "gpt-5.6-terra": "3000",
  "gpt-5.6-luna": "3000",
});

export const resolveCodexCompactionCompatibilityClass: CompactionCompatibilityResolver = (
  modelId,
) => CODEX_COMPACTION_COMPATIBILITY_CLASSES[modelId];

export type NativeReplayCheckpointDetails = {
  nativeReplayCheckpoint: {
    format: typeof NATIVE_REPLAY_CHECKPOINT_FORMAT;
    producer: {
      modelKey: RemoteCompactionModelKey;
      compactionCompatibilityClass: string | null;
    };
    replacementHistory: [CompactionItem];
  };
};

type BranchEntry = {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: unknown;
  data?: unknown;
  summary?: unknown;
  firstKeptEntryId?: unknown;
  tokensBefore?: unknown;
  details?: unknown;
  message?: AgentMessage;
};

type RequestModelIdentity = { provider: string; api: string; id: string };

type CompatibilityDecision = {
  checkpointId: string;
  target: {
    modelKey: RequestModelIdentity;
    compactionCompatibilityClass: string | null;
  };
  compatible: boolean;
};

type ReplayDerivation =
  | { kind: "valid"; invalidated: boolean }
  | { kind: "broken"; reason: string };

type ValidReplayState = {
  kind: "valid";
  entry: BranchEntry;
  entryIndex: number;
  modelKey: RemoteCompactionModelKey;
  compactionCompatibilityClass: string | null;
  checkpointKind: "legacy" | "native";
  replacementHistory: [CompactionItem];
  invalidated: boolean;
};

type ActiveReplayState = { kind: "none" } | { kind: "broken"; reason: string } | ValidReplayState;

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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function operationKindForIdentity(
  provider: unknown,
  api: unknown,
): RemoteCompactionOperationKind | undefined {
  if (api === "openai-responses") return "direct-responses";
  if (provider === "openai-codex" && api === "openai-codex-responses") {
    return "pi-codex-responses";
  }
  return undefined;
}

export function remoteCompactionOperationKind(
  model: unknown,
): RemoteCompactionOperationKind | undefined {
  return isRecord(model) ? operationKindForIdentity(model.provider, model.api) : undefined;
}

function isEligibleModel(model: unknown): model is Model<any> {
  return remoteCompactionOperationKind(model) !== undefined;
}

function modelKeyFromIdentity(
  provider: unknown,
  api: unknown,
  id: unknown,
): RemoteCompactionModelKey | undefined {
  if (typeof provider !== "string" || !provider.trim() || typeof id !== "string" || !id.trim()) {
    return undefined;
  }

  const operationKind = operationKindForIdentity(provider, api);
  if (operationKind === "direct-responses") {
    return { provider, api: "openai-responses", id };
  }
  if (operationKind === "pi-codex-responses") {
    return { provider: "openai-codex", api: "openai-codex-responses", id };
  }
  return undefined;
}

function modelKey(model: Model<any>): RemoteCompactionModelKey | undefined {
  return modelKeyFromIdentity(model.provider, model.api, model.id);
}

function sameModelKey(left: RequestModelIdentity, right: RequestModelIdentity): boolean {
  return left.provider === right.provider && left.api === right.api && left.id === right.id;
}

function compatibleWithCheckpoint(
  state: Pick<ValidReplayState, "modelKey" | "compactionCompatibilityClass">,
  targetIdentity: RequestModelIdentity,
  targetClass: string | null | undefined,
): boolean {
  if (state.compactionCompatibilityClass !== null && isCompatibilityClass(targetClass)) {
    return (
      modelKeyFromIdentity(targetIdentity.provider, targetIdentity.api, targetIdentity.id) !==
        undefined && state.compactionCompatibilityClass === targetClass
    );
  }
  return sameModelKey(state.modelKey, targetIdentity);
}

function requestModelIdentity(model: unknown): RequestModelIdentity | undefined {
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

function isCompatibilityClass(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveCompatibilityClass(
  resolver: CompactionCompatibilityResolver,
  modelId: string,
): string | undefined {
  const value = resolver(modelId);
  return isCompatibilityClass(value) ? value : undefined;
}

function decodeLegacyDetails(
  value: unknown,
): Omit<ValidReplayState, "kind" | "entry" | "entryIndex" | "invalidated"> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["remoteCompaction"])) return undefined;
  const remote = value.remoteCompaction;
  if (
    !isRecord(remote) ||
    !hasExactKeys(remote, ["version", "modelKey", "replacementHistory"]) ||
    remote.version !== 2 ||
    !isRecord(remote.modelKey) ||
    !hasExactKeys(remote.modelKey, ["provider", "api", "id"])
  ) {
    return undefined;
  }
  const key = modelKeyFromIdentity(
    remote.modelKey.provider,
    remote.modelKey.api,
    remote.modelKey.id,
  );
  if (
    !key ||
    !Array.isArray(remote.replacementHistory) ||
    remote.replacementHistory.length !== 1 ||
    !isCompactionItem(remote.replacementHistory[0])
  ) {
    return undefined;
  }
  return {
    modelKey: key,
    compactionCompatibilityClass: null,
    checkpointKind: "legacy",
    replacementHistory: [remote.replacementHistory[0]],
  };
}

function decodeNativeDetails(
  value: unknown,
): Omit<ValidReplayState, "kind" | "entry" | "entryIndex" | "invalidated"> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["nativeReplayCheckpoint"])) {
    return undefined;
  }
  const checkpoint = value.nativeReplayCheckpoint;
  if (
    !isRecord(checkpoint) ||
    !hasExactKeys(checkpoint, ["format", "producer", "replacementHistory"]) ||
    checkpoint.format !== NATIVE_REPLAY_CHECKPOINT_FORMAT ||
    !isRecord(checkpoint.producer) ||
    !hasExactKeys(checkpoint.producer, ["modelKey", "compactionCompatibilityClass"]) ||
    !isRecord(checkpoint.producer.modelKey) ||
    !hasExactKeys(checkpoint.producer.modelKey, ["provider", "api", "id"])
  ) {
    return undefined;
  }
  const key = modelKeyFromIdentity(
    checkpoint.producer.modelKey.provider,
    checkpoint.producer.modelKey.api,
    checkpoint.producer.modelKey.id,
  );
  const compatibilityClass = checkpoint.producer.compactionCompatibilityClass;
  if (
    !key ||
    (compatibilityClass !== null && !isCompatibilityClass(compatibilityClass)) ||
    !Array.isArray(checkpoint.replacementHistory) ||
    checkpoint.replacementHistory.length !== 1 ||
    !isCompactionItem(checkpoint.replacementHistory[0])
  ) {
    return undefined;
  }
  return {
    modelKey: key,
    compactionCompatibilityClass: compatibilityClass,
    checkpointKind: "native",
    replacementHistory: [checkpoint.replacementHistory[0]],
  };
}

function decodeDetails(
  value: unknown,
): Omit<ValidReplayState, "kind" | "entry" | "entryIndex" | "invalidated"> | undefined {
  return decodeNativeDetails(value) ?? decodeLegacyDetails(value);
}

function decodeCompatibilityDecision(value: unknown): CompatibilityDecision | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["checkpointId", "target", "compatible"]) ||
    typeof value.checkpointId !== "string" ||
    !value.checkpointId ||
    typeof value.compatible !== "boolean" ||
    !isRecord(value.target) ||
    !hasExactKeys(value.target, ["modelKey", "compactionCompatibilityClass"]) ||
    !isRecord(value.target.modelKey) ||
    !hasExactKeys(value.target.modelKey, ["provider", "api", "id"])
  ) {
    return undefined;
  }
  const target = requestModelIdentity(value.target.modelKey);
  const targetClass = value.target.compactionCompatibilityClass;
  if (!target || (targetClass !== null && !isCompatibilityClass(targetClass))) return undefined;
  return {
    checkpointId: value.checkpointId,
    target: {
      modelKey: target,
      compactionCompatibilityClass: targetClass,
    },
    compatible: value.compatible,
  };
}

function successfulAssistant(entry: BranchEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    entry.message.stopReason !== "error" &&
    entry.message.stopReason !== "aborted"
  );
}

function assistantIdentity(entry: BranchEntry): RequestModelIdentity | undefined {
  const message = entry.message;
  if (entry.type !== "message" || message?.role !== "assistant") return undefined;
  return requestModelIdentity({
    provider: message.provider,
    api: message.api,
    id: message.model,
  });
}

function assistantInvalidates(entry: BranchEntry, owner: RemoteCompactionModelKey): boolean {
  if (!successfulAssistant(entry)) return false;
  const identity = assistantIdentity(entry);
  return !identity || !sameModelKey(owner, identity);
}

function deriveClassAwareReplay(
  suffix: readonly BranchEntry[],
  state: Pick<ValidReplayState, "entry" | "modelKey" | "compactionCompatibilityClass">,
): ReplayDerivation {
  let pending: CompatibilityDecision | undefined;
  for (const entry of suffix) {
    if (entry.type === "custom" && entry.customType === NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE) {
      const decision = decodeCompatibilityDecision(entry.data);
      if (!decision) {
        return { kind: "broken", reason: "compatibility evidence is malformed" };
      }
      if (decision.checkpointId !== state.entry.id) {
        return {
          kind: "broken",
          reason: "compatibility evidence belongs to a different checkpoint",
        };
      }
      if (
        decision.compatible !==
        compatibleWithCheckpoint(
          state,
          decision.target.modelKey,
          decision.target.compactionCompatibilityClass,
        )
      ) {
        return {
          kind: "broken",
          reason: "compatibility evidence contains an inconsistent decision",
        };
      }
      pending = decision;
      continue;
    }

    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "assistant") continue;
    const identity = assistantIdentity(entry);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      pending = undefined;
      continue;
    }
    if (!identity) {
      return {
        kind: "broken",
        reason: "a successful assistant turn has an invalid model identity",
      };
    }
    if (!pending) {
      return {
        kind: "broken",
        reason: "a successful assistant turn is missing compatibility evidence",
      };
    }
    if (!sameModelKey(pending.target.modelKey, identity)) {
      return {
        kind: "broken",
        reason: "compatibility evidence does not match its assistant turn",
      };
    }
    if (!pending.compatible) return { kind: "valid", invalidated: true };
    pending = undefined;
  }
  return { kind: "valid", invalidated: false };
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
      reason: "the latest Remote compaction checkpoint has missing or malformed details",
    };
  }

  const suffix = branch.slice(latestIndex + 1);
  const derivation =
    decoded.checkpointKind === "native" && decoded.compactionCompatibilityClass !== null
      ? deriveClassAwareReplay(suffix, {
          entry,
          modelKey: decoded.modelKey,
          compactionCompatibilityClass: decoded.compactionCompatibilityClass,
        })
      : {
          kind: "valid" as const,
          invalidated: suffix.some((candidate) =>
            assistantInvalidates(candidate, decoded.modelKey),
          ),
        };
  if (derivation.kind === "broken") return derivation;

  return {
    kind: "valid",
    entry,
    entryIndex: latestIndex,
    ...decoded,
    invalidated: derivation.invalidated,
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

function appendCompatibilityDecision(
  pi: ExtensionAPI,
  context: HookContext,
  decision: CompatibilityDecision,
): boolean {
  try {
    pi.appendEntry(NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE, decision);
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
  compactionCompatibilityClass: string | null,
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
      details: {
        nativeReplayCheckpoint: {
          format: NATIVE_REPLAY_CHECKPOINT_FORMAT,
          producer: {
            modelKey: key,
            compactionCompatibilityClass,
          },
          replacementHistory: [accepted.item],
        },
      },
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
    if (!isEligibleModel(model)) return undefined;
    if (event.signal.aborted) return { cancel: true };

    const key = modelKey(model);
    if (!key) {
      reportError(context, "Remote compaction requires a non-empty structured model identity.");
      return { cancel: true };
    }

    const selectedCompatibilityClass = resolveCompatibilityClass(
      resolveCompatibilityClassForModel,
      key.id,
    );
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
      if (!compatibleWithCheckpoint(state, key, selectedCompatibilityClass)) {
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
        return successResult(event, key, selectedCompatibilityClass ?? null, outcome);
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

    const selectedIdentity = requestModelIdentity(model);
    if (!selectedIdentity) {
      return hardStop(context, "the selected model has an invalid structured identity");
    }
    const selectedKey = modelKey(model);
    if (!selectedKey) {
      if (state.checkpointKind === "native" && state.compactionCompatibilityClass !== null) {
        if (
          !appendCompatibilityDecision(pi, context, {
            checkpointId: state.entry.id,
            target: {
              modelKey: selectedIdentity,
              compactionCompatibilityClass:
                resolveCompatibilityClass(resolveCompatibilityClassForModel, selectedIdentity.id) ??
                null,
            },
            compatible: false,
          })
        ) {
          return undefined;
        }
      }
      reportWarning(
        context,
        "The selected model is incompatible with the active Remote compaction checkpoint. Pre-checkpoint context is unavailable; a successful assistant turn will invalidate native replay for this branch.",
      );
      return undefined;
    }

    const targetClass = resolveCompatibilityClass(
      resolveCompatibilityClassForModel,
      selectedKey.id,
    );
    const compatible = compatibleWithCheckpoint(state, selectedKey, targetClass);
    if (state.checkpointKind === "native" && state.compactionCompatibilityClass !== null) {
      if (
        !appendCompatibilityDecision(pi, context, {
          checkpointId: state.entry.id,
          target: {
            modelKey: selectedKey,
            compactionCompatibilityClass: targetClass ?? null,
          },
          compatible,
        })
      ) {
        return undefined;
      }
    }
    if (!compatible) {
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
