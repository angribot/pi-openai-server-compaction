import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage,
  getInitialSystemMessage,
  getSystemMessageText,
  type Model,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionItem } from "./remote-compaction-operation.ts";
import { projectCompactableContext, type ResponsesItem } from "./responses-projection.ts";

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

export const NATIVE_REPLAY_CHECKPOINT_FORMAT = "native-replay-checkpoint/1";

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
  summary?: unknown;
  firstKeptEntryId?: unknown;
  tokensBefore?: unknown;
  details?: unknown;
  message?: AgentMessage;
  systemMessage?: SystemMessage;
};

type RequestModelIdentity = { provider: string; api: string; id: string };

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

type ReplayPreparationFailure =
  | { kind: "broken"; reason: string }
  | { kind: "invalidated" }
  | { kind: "invalid-model" };

type CompactionReplayPreparation =
  | ReplayPreparationFailure
  | { kind: "snapshot-unavailable" }
  | { kind: "incompatible" }
  | { kind: "ineligible" }
  | {
      kind: "ready";
      buildInput(): ResponsesItem[];
      createCheckpointDetails(item: CompactionItem): NativeReplayCheckpointDetails;
    };

export type NativeReplayRewrite =
  | { kind: "patched"; payload: Record<string, unknown> }
  | { kind: "payload-not-full-array" }
  | { kind: "span-unavailable" }
  | { kind: "span-missing-or-ambiguous" };

type NativeReplayPreparation =
  | ReplayPreparationFailure
  | { kind: "none" }
  | { kind: "incompatible" }
  | { kind: "compatible"; rewrite(payload: unknown): NativeReplayRewrite };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationKindForIdentity(
  api: unknown,
): RemoteCompactionOperationKind | undefined {
  if (api === "openai-responses") return "direct-responses";
  if (api === "openai-codex-responses") {
    return "pi-codex-responses";
  }
  return undefined;
}

export function remoteCompactionOperationKind(
  model: unknown,
): RemoteCompactionOperationKind | undefined {
  return isRecord(model) ? operationKindForIdentity(model.api) : undefined;
}

function modelKeyFromIdentity(
  provider: unknown,
  api: unknown,
  id: unknown,
): RemoteCompactionModelKey | undefined {
  if (typeof provider !== "string" || !provider.trim() || typeof id !== "string" || !id.trim()) {
    return undefined;
  }

  const operationKind = operationKindForIdentity(api);
  if (operationKind === "direct-responses") {
    return { provider, api: "openai-responses", id };
  }
  if (operationKind === "pi-codex-responses") {
    return { provider, api: "openai-codex-responses", id };
  }
  return undefined;
}

function eligibleIdentity(identity: RequestModelIdentity): boolean {
  return (
    modelKeyFromIdentity(identity.provider, identity.api, identity.id) !== undefined &&
    identity.id.startsWith("gpt-")
  );
}

function compatibleWithCheckpoint(
  state: Pick<ValidReplayState, "modelKey">,
  targetIdentity: RequestModelIdentity,
): boolean {
  return eligibleIdentity(state.modelKey) && eligibleIdentity(targetIdentity);
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

function decodeNativeDetails(
  value: unknown,
): Omit<ValidReplayState, "kind" | "entry" | "entryIndex" | "invalidated"> | undefined {
  if (!isRecord(value)) return undefined;
  const checkpoint = value.nativeReplayCheckpoint;
  if (
    !isRecord(checkpoint) ||
    checkpoint.format !== NATIVE_REPLAY_CHECKPOINT_FORMAT ||
    !isRecord(checkpoint.producer) ||
    !isRecord(checkpoint.producer.modelKey)
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

function assistantIdentity(entry: BranchEntry): RequestModelIdentity | undefined {
  const message = entry.message;
  if (entry.type !== "message" || message?.role !== "assistant") return undefined;
  return requestModelIdentity({
    provider: message.provider,
    api: message.api,
    id: message.model,
  });
}

function deriveReplayContinuity(
  suffix: readonly BranchEntry[],
): ReplayDerivation {
  for (const entry of suffix) {
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const identity = assistantIdentity(entry);
    if (!identity) return { invalidated: true };
    const compatible = eligibleIdentity(identity);
    if (!compatible) return { invalidated: true };
  }
  return { invalidated: false };
}

function latestCompactionIndex(branch: readonly BranchEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]?.type === "compaction") return index;
  }
  return -1;
}

/**
 * Whether the active branch's latest compaction is a Remote compaction
 * checkpoint. This deliberately ignores checkpoint decode, continuity, and
 * model eligibility: any latest Remote checkpoint owns context that Native
 * replay reconstructs, including broken, invalidated, incompatible, and
 * recognized legacy records.
 */
export function hasActiveRemoteCompactionCheckpoint(branch: readonly BranchEntry[]): boolean {
  const index = latestCompactionIndex(branch);
  return index >= 0 && branch[index]?.summary === REMOTE_COMPACTION_CHECKPOINT_MARKER;
}

function deriveActiveReplayState(
  branch: readonly BranchEntry[],
): ActiveReplayState {
  const latestIndex = latestCompactionIndex(branch);
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
  const derivation = deriveReplayContinuity(suffix);

  return {
    kind: "valid",
    entry,
    entryIndex: latestIndex,
    ...decoded,
    invalidated: derivation.invalidated,
  };
}

function suffixMessages(branch: readonly BranchEntry[], state: ValidReplayState): AgentMessage[] {
  if (state.entryIndex >= branch.length - 1) return [];
  return buildSessionContext(
    branch.slice(state.entryIndex + 1) as Parameters<typeof buildSessionContext>[0],
  ).messages;
}

function supportsMidConversationSystemMessages(model: Model<any>): boolean {
  return (
    (model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)
      ?.supportsMidConvoSystemMessages ?? false
  );
}

/**
 * Effective Remote compaction instructions for the selected model's transcript
 * contract. Models without mid-conversation system messages collapse the prompt
 * into one head; those that accept them keep the leading base prompt and re-send
 * later section/tool updates as ordered input items.
 */
export function compactionInstructions(
  branch: readonly BranchEntry[],
  model: Model<any>,
  customInstructions: string | undefined,
  fallbackSystemPrompt = "",
): string {
  const messages = buildSessionContext(
    branch as Parameters<typeof buildSessionContext>[0],
  ).messages;
  const head = supportsMidConversationSystemMessages(model)
    ? getInitialSystemMessage(messages)
    : getCurrentSystemMessage(messages);
  const base = (head ? getSystemMessageText(head) : "") || fallbackSystemPrompt;
  const custom = customInstructions?.trim();
  if (!custom) return base;
  return base
    ? `${base}\n\nAdditional compaction instructions:\n${custom}`
    : `Additional compaction instructions:\n${custom}`;
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
    // The leading system snapshot (if any) is provider instruction state that
    // stays outside the replay replacement span. Anchor the span on the checkpoint
    // marker instead of assuming it is the first projected item.
    const projected = projectCompactableContext(context.messages, model, {
      includeSystemPrompt: false,
    });
    const markerIndex = projected.findIndex((item) => containsCheckpointMarker(item));
    return markerIndex < 0 ? undefined : projected.slice(markerIndex);
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

export function prepareCompactionReplay(
  branch: readonly BranchEntry[],
  model: Model<any>,
): CompactionReplayPreparation {
  const key = modelKeyFromIdentity(model.provider, model.api, model.id);
  if (!key) return { kind: "invalid-model" };

  if (!eligibleIdentity(key)) return { kind: "ineligible" };
  const producer = { modelKey: key, compactionCompatibilityClass: null };
  const state = deriveActiveReplayState(branch);
  if (state.kind === "broken") return state;
  if (state.kind === "valid") {
    if (state.invalidated) return { kind: "invalidated" };
    if (!compatibleWithCheckpoint(state, key)) {
      return { kind: "incompatible" };
    }
    // Without a host system-message snapshot the checkpoint stays readable for
    // ordinary replay, but a further compaction must not guess its instructions.
    if (state.entry.systemMessage === undefined) return { kind: "snapshot-unavailable" };
  }

  return {
    kind: "ready",
    buildInput() {
      if (state.kind === "valid") {
        return [
          ...state.replacementHistory,
          ...projectCompactableContext(suffixMessages(branch, state), model, {
            includeSystemPrompt: false,
            // A post-checkpoint system message continues the compacted transcript
            // rather than leading it; only mid-conversation models keep it in place.
            hasPrecedingItems: supportsMidConversationSystemMessages(model),
          }),
          { type: "compaction_trigger" },
        ];
      }
      const messages = projectCompactableContext(
        buildSessionContext(branch as Parameters<typeof buildSessionContext>[0]).messages,
        model,
        { includeSystemPrompt: false },
      );
      return [...messages, { type: "compaction_trigger" }];
    },
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
  model: Model<any>,
): NativeReplayPreparation {
  const state = deriveActiveReplayState(branch);
  if (state.kind === "none" || state.kind === "broken") return state;
  if (state.invalidated) return { kind: "invalidated" };

  const identity = requestModelIdentity(model);
  if (!identity) return { kind: "invalid-model" };
  const key = modelKeyFromIdentity(identity.provider, identity.api, identity.id);
  const compatible = key !== undefined && compatibleWithCheckpoint(state, identity);
  if (!compatible) return { kind: "incompatible" };

  return {
    kind: "compatible",
    rewrite(payload) {
      if (!isRecord(payload) || !Array.isArray(payload.input)) {
        return { kind: "payload-not-full-array" };
      }
      const expected = checkpointSpan(branch, state, model);
      if (!expected) return { kind: "span-unavailable" };
      const matchStart = findUniqueSpan(payload.input, expected);
      if (matchStart === undefined) return { kind: "span-missing-or-ambiguous" };

      const patched: Record<string, unknown> = {
        ...payload,
        input: [
          ...payload.input.slice(0, matchStart),
          ...state.replacementHistory,
          ...payload.input.slice(matchStart + expected.length),
        ],
      };
      delete patched.messages;
      delete patched.previous_response_id;
      return { kind: "patched", payload: patched };
    },
  };
}
