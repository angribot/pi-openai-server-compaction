import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionItem } from "./remote-compaction-operation.ts";

export const REMOTE_COMPACTION_CHECKPOINT_MARKER =
  "[Remote Responses compaction checkpoint]\n\n" +
  "Detailed context before this checkpoint is retained in the native replay artifact and is available only to compatible Responses models.";

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
  // OpenAI Codex catalog at 459a79eb85400af759e9220c7bafb4429ae07516.
  "gpt-5.4": "2911",
  "gpt-5.4-mini": "2911",
  "gpt-5.5": "2911",
  "gpt-5.6-sol": "3000",
  "gpt-5.6-terra": "3000",
  "gpt-5.6-luna": "3000",
  "gpt-6-astra": "3000",
  "gpt-daybreak-blue-latest": "3000",
  "gpt-daybreak-red-latest": "3000",
  "codex-auto-review": "3000",
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

export type BranchEntry = {
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

export type ReplayCheckpoint = Pick<
  ValidReplayState,
  "entry" | "entryIndex" | "replacementHistory"
>;

export type ReplayEvidenceRecord = {
  customType: typeof NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE;
  data: CompatibilityDecision;
};

type ReplayPreparationFailure =
  | { kind: "broken"; reason: string }
  | { kind: "invalidated" }
  | { kind: "invalid-model" };

type CompactionReplayPreparation =
  | ReplayPreparationFailure
  | { kind: "incompatible" }
  | {
      kind: "ready";
      replay: ReplayCheckpoint | undefined;
      createCheckpointDetails(item: CompactionItem): NativeReplayCheckpointDetails;
    };

type NativeReplayPreparation =
  | ReplayPreparationFailure
  | { kind: "none" }
  | { kind: "incompatible"; evidence?: ReplayEvidenceRecord }
  | { kind: "compatible"; replay: ReplayCheckpoint; evidence?: ReplayEvidenceRecord };

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
  const derivation = requiresCompatibilityEvidence(decoded)
    ? deriveClassAwareReplay(suffix, {
        entry,
        modelKey: decoded.modelKey,
        compactionCompatibilityClass: decoded.compactionCompatibilityClass,
      })
    : {
        kind: "valid" as const,
        invalidated: suffix.some((candidate) => assistantInvalidates(candidate, decoded.modelKey)),
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

function requiresCompatibilityEvidence(
  state: Pick<ValidReplayState, "checkpointKind" | "compactionCompatibilityClass">,
): boolean {
  return state.checkpointKind === "native" && state.compactionCompatibilityClass !== null;
}

export function prepareCompactionReplay(
  branch: readonly BranchEntry[],
  model: { provider: string; api: string; id: string },
  resolver: CompactionCompatibilityResolver,
): CompactionReplayPreparation {
  const key = modelKeyFromIdentity(model.provider, model.api, model.id);
  if (!key) return { kind: "invalid-model" };

  // Capture the producer class before the remote operation, never when it completes.
  const producer = {
    modelKey: key,
    compactionCompatibilityClass: resolveCompatibilityClass(resolver, key.id) ?? null,
  };
  const state = deriveActiveReplayState(branch);
  if (state.kind === "broken") return state;
  if (state.kind === "valid") {
    if (state.invalidated) return { kind: "invalidated" };
    if (!compatibleWithCheckpoint(state, key, producer.compactionCompatibilityClass)) {
      return { kind: "incompatible" };
    }
  }

  return {
    kind: "ready",
    replay: state.kind === "valid" ? state : undefined,
    createCheckpointDetails(item) {
      return {
        nativeReplayCheckpoint: {
          format: NATIVE_REPLAY_CHECKPOINT_FORMAT,
          producer,
          replacementHistory: [item],
        },
      };
    },
  };
}

export function prepareNativeReplay(
  branch: readonly BranchEntry[],
  model: unknown,
  resolver: CompactionCompatibilityResolver,
): NativeReplayPreparation {
  const state = deriveActiveReplayState(branch);
  if (state.kind === "none" || state.kind === "broken") return state;
  if (state.invalidated) return { kind: "invalidated" };

  const identity = requestModelIdentity(model);
  if (!identity) return { kind: "invalid-model" };
  const key = modelKeyFromIdentity(identity.provider, identity.api, identity.id);
  const needsEvidence = requiresCompatibilityEvidence(state);
  const targetClass =
    key || needsEvidence ? (resolveCompatibilityClass(resolver, identity.id) ?? null) : null;
  const compatible = key !== undefined && compatibleWithCheckpoint(state, identity, targetClass);
  const evidence: ReplayEvidenceRecord | undefined = needsEvidence
    ? {
        customType: NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE,
        data: {
          checkpointId: state.entry.id,
          target: { modelKey: identity, compactionCompatibilityClass: targetClass },
          compatible,
        },
      }
    : undefined;

  return compatible
    ? { kind: "compatible", replay: state, evidence }
    : { kind: "incompatible", evidence };
}
