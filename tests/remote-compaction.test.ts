import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model, SystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  NATIVE_REPLAY_CHECKPOINT_FORMAT,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  type BranchEntry,
  type CompactionCompatibilityResolver,
  type NativeReplayCheckpointDetails,
} from "../src/native-replay.ts";
import type {
  RemoteCompactionAttempt,
  RemoteCompactionRequest,
} from "../src/remote-compaction-operation.ts";
import { installRemoteCompaction } from "../src/remote-compaction.ts";

type SessionBeforeCompactHandler = (
  event: unknown,
  context: unknown,
) => Promise<{ compaction?: Record<string, any> } | undefined>;

function model(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    provider: "example-provider",
    api: "openai-responses",
    id: "gpt-5.4",
    name: "Session hook test model",
    baseUrl: "https://model.example/v1/",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

function install(
  attempt: RemoteCompactionAttempt,
  resolver?: CompactionCompatibilityResolver,
): SessionBeforeCompactHandler {
  let captured: SessionBeforeCompactHandler | undefined;
  const pi = {
    on(name: string, handler: SessionBeforeCompactHandler) {
      if (name === "session_before_compact") captured = handler;
    },
  } as unknown as ExtensionAPI;
  installRemoteCompaction(pi, attempt, resolver);
  assert.ok(captured, "session_before_compact handler was not installed");
  return captured;
}

function makeContext(
  selected: Model<any>,
  systemPrompt = "system instructions",
  branch: BranchEntry[] = [],
): {
  context: unknown;
  notifications: Array<{ message: string; kind: unknown }>;
  aborts: () => number;
} {
  const notifications: Array<{ message: string; kind: unknown }> = [];
  let aborts = 0;
  const context = {
    model: selected,
    hasUI: true,
    ui: {
      notify(message: string, kind: unknown) {
        notifications.push({ message, kind });
      },
    },
    getSystemPrompt: () => systemPrompt,
    abort() {
      aborts++;
    },
    modelRegistry: {},
    sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
  };
  return { context, notifications, aborts: () => aborts };
}

function userEntry(id: string, text: string): BranchEntry {
  return {
    type: "message",
    id,
    parentId: null,
    message: { role: "user", content: text, timestamp: 1 },
  };
}

function messageEntry(id: string, parentId: string | null, message: unknown): BranchEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message,
  } as BranchEntry;
}

function systemEntry(id: string, parentId: string | null, message: SystemMessage): BranchEntry {
  return { type: "message", id, parentId, timestamp: new Date().toISOString(), message };
}

function replayDetails(selected: Model<any>): NativeReplayCheckpointDetails {
  return {
    nativeReplayCheckpoint: {
      format: NATIVE_REPLAY_CHECKPOINT_FORMAT,
      producer: {
        modelKey: {
          provider: selected.provider,
          api: selected.api as "openai-responses" | "openai-codex-responses",
          id: selected.id,
        },
        compactionCompatibilityClass: null,
      },
      replacementHistory: [{ type: "compaction", encrypted_content: "opaque-item" }],
    },
  };
}

/** A `/1` checkpoint with no host `systemMessage` snapshot. */
function snapshotlessBranch(
  selected: Model<any>,
  options: { head?: SystemMessage; update?: SystemMessage } = {},
): BranchEntry[] {
  const { head, update } = options;
  return [
    ...(head ? [systemEntry("s0", null, head)] : []),
    messageEntry("e1", head ? "s0" : null, { role: "user", content: "old", timestamp: 1 }),
    messageEntry("e2", "e1", { role: "user", content: "retained", timestamp: 2 }),
    {
      type: "compaction",
      id: "c1",
      parentId: "e2",
      timestamp: new Date().toISOString(),
      summary: REMOTE_COMPACTION_CHECKPOINT_MARKER,
      firstKeptEntryId: "e2",
      tokensBefore: 10,
      details: replayDetails(selected),
    },
    ...(update ? [systemEntry("s2", "c1", update)] : []),
    messageEntry("e3", update ? "s2" : "c1", {
      role: "user",
      content: "after",
      timestamp: 4,
    }),
  ];
}

function compactEvent(branchEntries: BranchEntry[] = [userEntry("u1", "compact me")]): unknown {
  return {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: "u1", tokensBefore: 42 },
    branchEntries,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

function recordingAttempt(): {
  attempt: RemoteCompactionAttempt;
  calls: () => number;
  request: () => RemoteCompactionRequest | undefined;
} {
  let calls = 0;
  let request: RemoteCompactionRequest | undefined;
  const attempt: RemoteCompactionAttempt = async (next) => {
    calls++;
    request = next;
    return {
      kind: "accepted",
      item: { type: "compaction", encrypted_content: "opaque-item" },
    };
  };
  return { attempt, calls: () => calls, request: () => request };
}

test("an unresolvable compatibility class defers to Pi default compaction without attempting", async () => {
  const models = [
    model({ id: "gpt-not-catalogued" }),
    model({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-not-catalogued" }),
  ];

  for (const selected of models) {
    const { attempt, calls } = recordingAttempt();
    const handler = install(attempt);
    const { context, notifications, aborts } = makeContext(selected);

    assert.equal(await handler(compactEvent(), context), undefined);
    assert.equal(calls(), 0, `${selected.api} ${selected.id} must not invoke the attempt`);
    assert.equal(aborts(), 0);
    assert.deepEqual(notifications, []);
  }
});

test("an empty resolver result is treated as an unresolvable class", async () => {
  const { attempt, calls } = recordingAttempt();
  const handler = install(attempt, () => "");
  const { context } = makeContext(model());

  assert.equal(await handler(compactEvent(), context), undefined);
  assert.equal(calls(), 0);
});

test("a catalogued class invokes the attempt and persists the resolved producer class", async () => {
  const cases: Array<[Model<any>, string]> = [
    [model({ id: "gpt-5.4" }), "2911"],
    [model({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" }), "3000"],
  ];

  for (const [selected, expectedClass] of cases) {
    const { attempt, calls, request } = recordingAttempt();
    const handler = install(attempt);
    const { context, notifications, aborts } = makeContext(selected);

    const result = await handler(compactEvent(), context);
    assert.equal(calls(), 1, `${selected.api} ${selected.id} must invoke the attempt`);
    assert.equal(aborts(), 0);
    assert.deepEqual(notifications, []);
    assert.ok(result?.compaction);
    assert.equal(result.compaction.summary, REMOTE_COMPACTION_CHECKPOINT_MARKER);
    assert.equal(
      result.compaction.details.nativeReplayCheckpoint.producer.compactionCompatibilityClass,
      expectedClass,
    );
    assert.deepEqual(request()?.input.at(-1), { type: "compaction_trigger" });
    assert.equal(request()?.instructions, "system instructions");
  }
});

test("unsupported API types are left untouched", async () => {
  const { attempt, calls } = recordingAttempt();
  const handler = install(attempt);
  const { context, notifications, aborts } = makeContext(
    model({ api: "openai-completions", id: "gpt-5.4" }),
  );

  assert.equal(await handler(compactEvent(), context), undefined);
  assert.equal(calls(), 0);
  assert.equal(aborts(), 0);
  assert.deepEqual(notifications, []);
});

test("the provider-scoped Codex restriction is preserved even for a catalogued model ID", async () => {
  const { attempt, calls } = recordingAttempt();
  const handler = install(attempt);
  const { context } = makeContext(
    model({ provider: "third-party", api: "openai-codex-responses", id: "gpt-5.4" }),
  );

  assert.equal(await handler(compactEvent(), context), undefined);
  assert.equal(calls(), 0);
});

test("the class gate also applies to repeated compaction over an existing checkpoint", async () => {
  const details: NativeReplayCheckpointDetails = {
    nativeReplayCheckpoint: {
      format: NATIVE_REPLAY_CHECKPOINT_FORMAT,
      producer: {
        modelKey: { provider: "example-provider", api: "openai-responses", id: "gpt-5.4" },
        compactionCompatibilityClass: "2911",
      },
      replacementHistory: [{ type: "compaction", encrypted_content: "old-item" }],
    },
  };
  const branch: BranchEntry[] = [
    userEntry("e1", "retained before checkpoint"),
    {
      type: "compaction",
      id: "c1",
      parentId: "e1",
      summary: REMOTE_COMPACTION_CHECKPOINT_MARKER,
      firstKeptEntryId: "e1",
      tokensBefore: 10,
      details,
    },
  ];
  const { attempt, calls } = recordingAttempt();
  const handler = install(attempt);
  const { context, notifications } = makeContext(model({ id: "gpt-not-catalogued" }));

  assert.equal(await handler(compactEvent(branch), context), undefined);
  assert.equal(calls(), 0);
  assert.deepEqual(notifications, []);
});

test("a snapshot-less /1 checkpoint cancels Remote compaction before any attempt for both APIs", async () => {
  const models = [
    model({ id: "gpt-5.4" }),
    model({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" }),
  ];
  const head: SystemMessage = { role: "system", content: "PERSISTED BASE", timestamp: 1 };
  const update: SystemMessage = { role: "system", content: "PERSISTED UPDATE", timestamp: 3 };
  const cases: Array<[string, { head?: SystemMessage; update?: SystemMessage }]> = [
    ["no prior head or suffix update", {}],
    ["prior head", { head }],
    ["suffix update", { update }],
    ["prior head and suffix update", { head, update }],
  ];

  for (const selected of models) {
    for (const [name, options] of cases) {
      const label = `${selected.api} ${name}`;
      const branch = snapshotlessBranch(selected, options);
      const { attempt, calls } = recordingAttempt();
      const handler = install(attempt);
      const { context, notifications, aborts } = makeContext(selected, "LIVE FALLBACK", branch);

      assert.deepEqual(await handler(compactEvent(branch), context), { cancel: true }, label);
      assert.equal(calls(), 0, `${label}: no remote attempt`);
      assert.equal(aborts(), 0, `${label}: cancellation is not an abort`);
      const error = notifications.find(({ kind }) => kind === "error")?.message ?? "";
      assert.match(error, /system-message snapshot/, label);
      assert.match(error, /new session/, label);
    }
  }
});
