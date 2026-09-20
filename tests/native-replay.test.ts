import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Model, SystemMessage } from "@earendil-works/pi-ai";
import {
  NATIVE_REPLAY_CHECKPOINT_FORMAT,
  prepareCompactionReplay,
  prepareNativeReplay,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  type BranchEntry,
  type NativeReplayCheckpointDetails,
} from "../src/native-replay.ts";

type ModelKey = {
  provider: string;
  api: "openai-responses" | "openai-codex-responses";
  id: string;
};

const PRODUCER_KEY: ModelKey = {
  provider: "example-provider",
  api: "openai-responses",
  id: "gpt-test",
};

const COMPACTION_ITEM = { type: "compaction", encrypted_content: "opaque-item" } as const;

const PROJECTED_CHECKPOINT_MARKER =
  "The conversation history before this point was compacted into the following summary:\n\n" +
  `<summary>\n${REMOTE_COMPACTION_CHECKPOINT_MARKER}\n</summary>`;

function model(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    provider: PRODUCER_KEY.provider,
    api: PRODUCER_KEY.api,
    id: PRODUCER_KEY.id,
    name: "Native replay test model",
    baseUrl: "https://model.example/v1/",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

let entryCounter = 0;

function timestamp(): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, entryCounter++)).toISOString();
}

function userEntry(id: string, text: string, parentId?: string): BranchEntry {
  return {
    type: "message",
    id,
    parentId: parentId ?? null,
    timestamp: timestamp(),
    message: { role: "user", content: text, timestamp: entryCounter },
  };
}

function assistantEntry(
  id: string,
  parentId: string,
  overrides: Partial<AssistantMessage> = {},
): BranchEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: timestamp(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "assistant turn" }],
      api: PRODUCER_KEY.api,
      provider: PRODUCER_KEY.provider,
      model: PRODUCER_KEY.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: entryCounter,
      ...overrides,
    },
  };
}

function checkpointEntry(
  id: string,
  parentId: string,
  firstKeptEntryId: string,
  details: NativeReplayCheckpointDetails,
  systemMessage?: SystemMessage,
): BranchEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: timestamp(),
    summary: REMOTE_COMPACTION_CHECKPOINT_MARKER,
    firstKeptEntryId,
    tokensBefore: 123,
    details,
    ...(systemMessage ? { systemMessage } : {}),
  };
}

function checkpointDetails(
  modelKey: ModelKey = PRODUCER_KEY,
  compactionCompatibilityClass: string | null = null,
): NativeReplayCheckpointDetails {
  return {
    nativeReplayCheckpoint: {
      format: NATIVE_REPLAY_CHECKPOINT_FORMAT,
      producer: { modelKey, compactionCompatibilityClass },
      replacementHistory: [COMPACTION_ITEM],
    },
  };
}

test("repeated compaction sends replacement history plus the post-checkpoint suffix", () => {
  const snapshot: SystemMessage = { role: "system", content: "BASE PROMPT", timestamp: 1 };
  const branch: BranchEntry[] = [
    userEntry("e1", "retained before checkpoint"),
    checkpointEntry("e2", "e1", "e1", checkpointDetails(), snapshot),
    userEntry("e3", "after checkpoint"),
  ];

  const preparation = prepareCompactionReplay(branch, model(), () => "2911");
  assert.equal(preparation.kind, "ready");
  if (preparation.kind !== "ready") return;

  assert.deepEqual(preparation.buildInput(), [
    COMPACTION_ITEM,
    { role: "user", content: [{ type: "input_text", text: "after checkpoint" }] },
    { type: "compaction_trigger" },
  ]);

  assert.deepEqual(
    preparation.createCheckpointDetails({ type: "compaction", encrypted_content: "new-item" }),
    {
      nativeReplayCheckpoint: {
        format: "native-replay-checkpoint/1",
        producer: {
          modelKey: { provider: "example-provider", api: "openai-responses", id: "gpt-test" },
          compactionCompatibilityClass: "2911",
        },
        replacementHistory: [{ type: "compaction", encrypted_content: "new-item" }],
      },
    },
  );
});

test("a snapshot-less checkpoint stays readable for replay but cannot compact again", () => {
  const branch: BranchEntry[] = [
    userEntry("e1", "retained before checkpoint"),
    checkpointEntry("e2", "e1", "e1", checkpointDetails()),
    userEntry("e3", "after checkpoint"),
  ];

  assert.deepEqual(
    prepareCompactionReplay(branch, model(), () => "2911"),
    {
      kind: "snapshot-unavailable",
    },
  );
  assert.equal(prepareNativeReplay(branch, model(), () => undefined).kind, "compatible");
});

test("native replay replaces only the replay replacement span and preserves surrounding items", () => {
  const branch: BranchEntry[] = [
    userEntry("e1", "retained before checkpoint"),
    checkpointEntry("e2", "e1", "e1", checkpointDetails()),
    userEntry("e3", "after checkpoint"),
  ];
  const payload = {
    model: "gpt-test",
    input: [
      { type: "reasoning", id: "rs_prefix", encrypted_content: "provider-prefix" },
      {
        role: "user",
        content: [{ type: "input_text", text: PROJECTED_CHECKPOINT_MARKER }],
      },
      { role: "user", content: [{ type: "input_text", text: "retained before checkpoint" }] },
      { role: "user", content: [{ type: "input_text", text: "after checkpoint" }] },
    ],
    previous_response_id: "resp-1",
    messages: [{ role: "user", content: "legacy" }],
  };

  const preparation = prepareNativeReplay(branch, model(), () => undefined);
  assert.equal(preparation.kind, "compatible");
  if (preparation.kind !== "compatible") return;

  const rewrite = preparation.rewrite(payload);
  assert.equal(rewrite.kind, "patched");
  if (rewrite.kind !== "patched") return;
  assert.deepEqual(rewrite.payload, {
    model: "gpt-test",
    input: [
      { type: "reasoning", id: "rs_prefix", encrypted_content: "provider-prefix" },
      COMPACTION_ITEM,
      { role: "user", content: [{ type: "input_text", text: "after checkpoint" }] },
    ],
  });
});

test("native replay fails when the replay replacement span is missing or ambiguous", () => {
  const branch: BranchEntry[] = [
    userEntry("e1", "retained before checkpoint"),
    checkpointEntry("e2", "e1", "e1", checkpointDetails()),
    userEntry("e3", "after checkpoint"),
  ];
  const preparation = prepareNativeReplay(branch, model(), () => undefined);
  assert.equal(preparation.kind, "compatible");
  if (preparation.kind !== "compatible") return;

  const span = [
    { role: "user", content: [{ type: "input_text", text: PROJECTED_CHECKPOINT_MARKER }] },
    { role: "user", content: [{ type: "input_text", text: "retained before checkpoint" }] },
  ];

  assert.equal(
    preparation.rewrite({ input: [{ type: "reasoning", id: "rs_only" }] }).kind,
    "span-missing-or-ambiguous",
  );
  assert.equal(
    preparation.rewrite({ input: [...span, ...span] }).kind,
    "span-missing-or-ambiguous",
  );
  assert.equal(preparation.rewrite({ messages: [] }).kind, "payload-not-full-array");

  const unavailable = prepareNativeReplay(
    [
      userEntry("u1", "retained before checkpoint"),
      checkpointEntry("u2", "u1", "ghost", checkpointDetails()),
      userEntry("u3", "after checkpoint"),
    ],
    model(),
    () => undefined,
  );
  assert.equal(unavailable.kind, "compatible");
  if (unavailable.kind !== "compatible") return;
  assert.equal(unavailable.rewrite({ input: [] }).kind, "span-unavailable");
});

test("a successful incompatible assistant turn invalidates while error and aborted turns do not", () => {
  const withSuffix = (suffix: BranchEntry[]): BranchEntry[] => [
    userEntry("e1", "retained before checkpoint"),
    checkpointEntry("e2", "e1", "e1", checkpointDetails()),
    ...suffix,
  ];

  const incompatible = prepareNativeReplay(
    withSuffix([assistantEntry("e3", "e2", { model: "gpt-other" })]),
    model(),
    () => undefined,
  );
  assert.equal(incompatible.kind, "invalidated");

  const invalidIdentity = prepareNativeReplay(
    withSuffix([assistantEntry("e4", "e2", { provider: "" })]),
    model(),
    () => undefined,
  );
  assert.equal(invalidIdentity.kind, "invalidated");

  for (const stopReason of ["error", "aborted"] as const) {
    const skipped = prepareNativeReplay(
      withSuffix([assistantEntry("e5", "e2", { model: "gpt-other", stopReason })]),
      model(),
      () => undefined,
    );
    assert.equal(skipped.kind, "compatible");

    const skippedInvalidIdentity = prepareNativeReplay(
      withSuffix([assistantEntry("e6", "e2", { provider: "", stopReason })]),
      model(),
      () => undefined,
    );
    assert.equal(skippedInvalidIdentity.kind, "compatible");
  }
});
