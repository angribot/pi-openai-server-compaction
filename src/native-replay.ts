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

type ReplayDerivation = { invalidated: boolean };

type ValidReplayState = {
  kind: "valid";
  entry: BranchEntry;
  entryIndex: number;
  modelKey: RemoteCompactionModelKey;
  compactionCompatibilityClass: string | null;
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

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
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

function decodeNativeDetails(
  value: unknown,
): Omit<ValidReplayState, "kind" | "entry" | "entryIndex" | "invalidated"> | undefined {
  if (!isRecord(value) || !hasRequiredKeys(value, ["nativeReplayCheckpoint"])) {
    return undefined;
  }
  const checkpoint = value.nativeReplayCheckpoint;
  if (
    !isRecord(checkpoint) ||
    !hasRequiredKeys(checkpoint, ["format", "producer", "replacementHistory"]) ||
    checkpoint.format !== NATIVE_REPLAY_CHECKPOINT_FORMAT ||
    !isRecord(checkpoint.producer) ||
    !hasRequiredKeys(checkpoint.producer, ["modelKey", "compactionCompatibilityClass"]) ||
    !isRecord(checkpoint.producer.modelKey) ||
    !hasRequiredKeys(checkpoint.producer.modelKey, ["provider", "api", "id"])
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
    replacementHistory: [checkpoint.replacementHistory[0]],
  };
}

function decodeCompatibilityDecision(value: unknown): CompatibilityDecision | undefined {
  if (
    !isRecord(value) ||
    !hasRequiredKeys(value, ["checkpointId", "target", "compatible"]) ||
    typeof value.checkpointId !== "string" ||
    !value.checkpointId ||
    typeof value.compatible !== "boolean" ||
    !isRecord(value.target) ||
    !hasRequiredKeys(value.target, ["modelKey", "compactionCompatibilityClass"]) ||
    !isRecord(value.target.modelKey) ||
    !hasRequiredKeys(value.target.modelKey, ["provider", "api", "id"])
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

function assistantIdentity(entry: BranchEntry): RequestModelIdentity | undefined {
  const message = entry.message;
  if (entry.type !== "message" || message?.role !== "assistant") return undefined;
  return requestModelIdentity({
    provider: message.provider,
    api: message.api,
    id: message.model,
  });
}

function identityCompatible(
  state: Pick<ValidReplayState, "modelKey" | "compactionCompatibilityClass">,
  identity: RequestModelIdentity,
  resolver: CompactionCompatibilityResolver,
): boolean {
  return compatibleWithCheckpoint(
    state,
    identity,
    resolveCompatibilityClass(resolver, identity.id) ?? null,
  );
}

function deriveReplayContinuity(
  suffix: readonly BranchEntry[],
  state: Pick<ValidReplayState, "entry" | "modelKey" | "compactionCompatibilityClass">,
  resolver: CompactionCompatibilityResolver,
): ReplayDerivation {
  let pending: CompatibilityDecision | undefined;
  for (const entry of suffix) {
    if (
      requiresCompatibilityEvidence(state) &&
      entry.type === "custom" &&
      entry.customType === NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE
    ) {
      const decision = decodeCompatibilityDecision(entry.data);
      // Malformed, foreign, or internally inconsistent bookkeeping is ignored, not
      // fatal: when no trustworthy decision applies, compatibility is re-derived
      // from the persisted assistant identity under the checkpoint's creation-time class.
      pending =
        decision &&
        decision.checkpointId === state.entry.id &&
        decision.compatible ===
          compatibleWithCheckpoint(
            state,
            decision.target.modelKey,
            decision.target.compactionCompatibilityClass,
          )
          ? decision
          : undefined;
      continue;
    }

    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      pending = undefined;
      continue;
    }
    const identity = assistantIdentity(entry);
    if (!identity) return { invalidated: true };
    const compatible =
      pending && sameModelKey(pending.target.modelKey, identity)
        ? pending.compatible
        : state.compactionCompatibilityClass === null
          ? sameModelKey(state.modelKey, identity)
          : identityCompatible(state, identity, resolver);
    if (!compatible) return { invalidated: true };
    pending = undefined;
  }
  return { invalidated: false };
}

function deriveActiveReplayState(
  branch: readonly BranchEntry[],
  resolver: CompactionCompatibilityResolver,
): ActiveReplayState {
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

  const decoded = decodeNativeDetails(entry.details);
  if (!decoded) {
    return {
      kind: "broken",
      reason: "the latest Remote compaction checkpoint has missing or malformed details",
    };
  }

  const suffix = branch.slice(latestIndex + 1);
  const derivation = deriveReplayContinuity(suffix, { entry, ...decoded }, resolver);

  return {
    kind: "valid",
    entry,
    entryIndex: latestIndex,
    ...decoded,
    invalidated: derivation.invalidated,
  };
}

function requiresCompatibilityEvidence(
  state: Pick<ValidReplayState, "compactionCompatibilityClass">,
): boolean {
  return state.compactionCompatibilityClass !== null;
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
  const state = deriveActiveReplayState(branch, resolver);
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
  const state = deriveActiveReplayState(branch, resolver);
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
