import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { InMemoryCredentialStore, type Model, type SystemMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attemptDirectResponsesOperation } from "../src/direct-responses-operation.ts";
import {
  NATIVE_REPLAY_CHECKPOINT_FORMAT,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  type BranchEntry,
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

function install(attempt: RemoteCompactionAttempt): SessionBeforeCompactHandler {
  let captured: SessionBeforeCompactHandler | undefined;
  const pi = {
    on(name: string, handler: SessionBeforeCompactHandler) {
      if (name === "session_before_compact") captured = handler;
    },
  } as unknown as ExtensionAPI;
  installRemoteCompaction(pi, attempt);
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
    modelRegistry: { isUsingOAuth: () => false },
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

test("uncatalogued GPT IDs attempt compaction and persist null classes on either API", async () => {
  for (const api of ["openai-responses", "openai-codex-responses"]) {
    const selected = model({ provider: "custom-provider", api, id: "gpt-future" });
    const { attempt, calls, request } = recordingAttempt();
    const { context } = makeContext(selected);
    const result = await install(attempt)(compactEvent(), context);
    assert.equal(calls(), 1);
    assert.equal(request()?.model, selected);
    assert.deepEqual(result?.compaction?.details.nativeReplayCheckpoint.producer, {
      modelKey: { provider: selected.provider, api, id: selected.id },
      compactionCompatibilityClass: null,
    });
  }
});

test("previously catalogued GPT IDs persist explicit null classes", async () => {
  const cases = [
    model({ id: "gpt-5.4" }),
    model({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" }),
    model({ id: "gpt-6-sol" }),
    model({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-luna" }),
  ];

  for (const selected of cases) {
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
      null,
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

test("eligibility uses literal request IDs and exact APIs, never display names", async () => {
  const cases: Array<[Partial<Model<any>>, boolean]> = [
    [{ id: "gpt-", name: "not GPT" }, true],
    [{ id: "GPT-example" }, false],
    [{ id: "openai/gpt-example" }, false],
    [{ id: " gpt-example" }, false],
    [{ id: "codex-auto-review", name: "gpt-example" }, false],
    [{ id: "other", name: "gpt-5.4" }, false],
    [{ api: "OpenAI-responses" }, false],
    [{ api: "openai-responses " }, false],
    [{ api: "OpenAI-codex-responses" }, false],
  ];
  for (const [overrides, eligible] of cases) {
    const { attempt, calls } = recordingAttempt();
    const { context } = makeContext(model(overrides));
    const result = await install(attempt)(compactEvent(), context);
    assert.equal(calls(), eligible ? 1 : 0, JSON.stringify(overrides));
    if (!eligible) assert.equal(result, undefined);
  }
});

test("uncatalogued targets recompact replacement history with one terminal trigger", async () => {
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
      systemMessage: { role: "system", content: "saved instructions", timestamp: 1 },
    },
  ];
  const { attempt, calls, request } = recordingAttempt();
  const handler = install(attempt);
  const { context, notifications } = makeContext(model({ id: "gpt-not-catalogued" }));

  const result = await handler(compactEvent(branch), context);
  assert.ok(result?.compaction);
  assert.equal(calls(), 1);
  assert.deepEqual(request()?.input, [{ type: "compaction", encrypted_content: "old-item" }, { type: "compaction_trigger" }]);
  assert.deepEqual(result.compaction.details.nativeReplayCheckpoint.replacementHistory, [{ type: "compaction", encrypted_content: "opaque-item" }]);
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

function replayHook() {
  const handlers: Record<string, (event: any, context: any) => any> = {};
  installRemoteCompaction({ on(name: string, handler: any) { handlers[name] = handler; } } as any,
    async () => { throw new Error("ordinary replay must not compact"); });
  return handlers.before_provider_request!;
}

function replayPayload() {
  return { input: [
    { role: "user", content: [{ type: "input_text", text:
      `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${REMOTE_COMPACTION_CHECKPOINT_MARKER}\n</summary>` }] },
    { role: "user", content: [{ type: "input_text", text: "retained" }] },
    { role: "user", content: [{ type: "input_text", text: "after" }] },
  ] };
}

test("ordinary hooks replay historical classes across identities and reinterpret successful GPT turns", () => {
  for (const api of ["openai-responses", "openai-codex-responses"]) {
    for (const historicalClass of ["2911", "3000", "opaque-other", null]) {
      const producer = model({ provider: "custom-codex", api: "openai-codex-responses", id: "gpt-5.5" });
      const branch = snapshotlessBranch(producer);
      (branch[2]!.details as NativeReplayCheckpointDetails).nativeReplayCheckpoint.producer.compactionCompatibilityClass = historicalClass;
      branch.push(messageEntry("a1", "e3", {
        role: "assistant", content: [], provider: "another-provider", api: "openai-responses",
        model: "gpt-6-sol", stopReason: "stop", timestamp: 5,
      }));
      const { context, notifications, aborts } = makeContext(model({ api, id: "gpt-future" }), "", branch);
      const result = replayHook()({ payload: replayPayload() }, context);
      assert.deepEqual(result.input[0], { type: "compaction", encrypted_content: "opaque-item" });
      assert.equal(aborts(), 0);
      assert.deepEqual(notifications, []);
    }
  }
});

test("ineligible producers and selection warn without corrupting state; successful ineligible turns stop replay", () => {
  const hook = replayHook();
  for (const producerId of ["gpt-5.5", "codex-auto-review"]) {
    const branch = snapshotlessBranch(model({ id: producerId }));
    const selected = makeContext(model({ id: "non-gpt" }), "", branch);
    const payload = replayPayload();
    assert.equal(hook({ payload }, selected.context), undefined);
    assert.equal(selected.aborts(), 0);
    assert.equal(selected.notifications[0]?.kind, "warning");
    assert.deepEqual(payload, replayPayload());
    const eligible = makeContext(model({ id: "gpt-future" }), "", branch);
    const result = hook({ payload }, eligible.context);
    assert.equal(Boolean(result), producerId.startsWith("gpt-"));
    assert.equal(eligible.aborts(), 0); // A valid non-GPT record is not malformed.
  }
  for (const identity of [{ model: "non-gpt" }, { provider: "" }, { api: "openai-completions" }]) {
    for (const stopReason of ["stop", "error", "aborted"]) {
      const branch = snapshotlessBranch(model());
      branch.push(messageEntry("a1", "e3", { role: "assistant", content: [],
        provider: "custom", api: "openai-responses", model: "gpt-future", ...identity, stopReason }));
      const state = makeContext(model(), "", branch);
      const result = hook({ payload: replayPayload() }, state.context);
      assert.equal(state.aborts(), stopReason === "stop" ? 1 : 0);
      assert.equal(Boolean(result), stopReason !== "stop");
    }
  }
});

test("broken and legacy checkpoints and unsafe replay spans still hard stop", () => {
  const hook = replayHook();
  const detailsCases: unknown[] = [undefined, { remoteCompaction: { version: 2 } },
    { nativeReplayCheckpoint: { ...replayDetails(model()).nativeReplayCheckpoint, producer: {
      modelKey: { provider: "custom", api: "openai-responses", id: "gpt-test" },
      compactionCompatibilityClass: "",
    } } }];
  for (const details of detailsCases) {
    const branch = snapshotlessBranch(model());
    branch[2]!.details = details;
    const state = makeContext(model(), "", branch);
    assert.equal(hook({ payload: replayPayload() }, state.context), undefined);
    assert.equal(state.aborts(), 1);
  }
  for (const payload of [{ input: [] }, { input: [...replayPayload().input, ...replayPayload().input] }, { messages: [] }]) {
    const state = makeContext(model(), "", snapshotlessBranch(model()));
    assert.equal(hook({ payload }, state.context), undefined);
    assert.equal(state.aborts(), 1);
  }
});

test("terminal unsupported compaction cancels without a text fallback", async () => {
  let attempts = 0;
  const handler = install(async () => { attempts++; return { kind: "terminal", error: new Error("unsupported trigger") }; });
  const state = makeContext(model({ id: "gpt-future" }));
  assert.deepEqual(await handler(compactEvent(), state.context), { cancel: true });
  assert.equal(attempts, 1);
  assert.match(state.notifications[0]!.message, /no text fallback/);
});

// Approved seams: registered lifecycle hooks with Pi's real auth runtime and
// production direct operation; fetch is the only remote boundary replaced.
async function openaiAuthRuntime(oauth = true, apiKey?: string) {
  const credentials = new InMemoryCredentialStore();
  if (oauth) await credentials.modify("openai", async () => ({
    type: "oauth", access: "test-oauth", refresh: "test-refresh", expires: 0,
  }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  if (apiKey) runtime.registerProvider("openai", { apiKey });
  const refreshed = await runtime.refresh({ providers: ["openai"], allowNetwork: false });
  assert.equal(refreshed.errors.size, 0);
  return { runtime, registry: new ModelRegistry(runtime) };
}

test("OpenAI OAuth defers new compaction before authentication refresh or network dispatch", async () => {
  const network = mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network"); });
  try {
    const { registry } = await openaiAuthRuntime();
    const selected = model({ provider: "openai" });
    assert.equal(registry.isUsingOAuth(selected), true);
    const { context } = makeContext(selected);
    Object.assign(context as object, { modelRegistry: registry });
    assert.equal(await install(attemptDirectResponsesOperation)(compactEvent(), context), undefined);
    assert.equal(network.mock.callCount(), 0);
  } finally {
    network.mock.restore();
  }
});

test("Pi runtime API-key override enables new and repeated OpenAI compaction; removing it restores OAuth deferral without blocking replay", async () => {
  const requests: Array<{ authorization: string | null; payload: any }> = [];
  const network = mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ authorization: new Headers(init?.headers).get("authorization"), payload: JSON.parse(String(init?.body)) });
    return new Response([
      { type: "response.output_item.done", item: { type: "compaction", encrypted_content: "new-item" } },
      { type: "response.completed", response: {} },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  try {
    const { runtime, registry } = await openaiAuthRuntime();
    const selected = model({ provider: "openai" });
    const producer = model({ provider: "custom-codex", api: "openai-codex-responses" });
    const branch = snapshotlessBranch(producer);
    Object.assign(branch[2]!, { systemMessage: { role: "system", content: "saved instructions", timestamp: 1 } });
    const { context } = makeContext(selected, "system instructions", branch);
    Object.assign(context as object, { modelRegistry: registry });
    const handler = install(attemptDirectResponsesOperation);

    await runtime.setRuntimeApiKey("openai", "test-runtime-key");
    assert.equal(registry.isUsingOAuth(selected), false);
    assert.ok((await handler(compactEvent(), context))?.compaction);
    assert.ok((await handler(compactEvent(branch), context))?.compaction);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.authorization, "Bearer test-runtime-key");
    assert.equal(requests[1]!.authorization, "Bearer test-runtime-key");
    assert.deepEqual(requests[1]!.payload.input, [
      { type: "compaction", encrypted_content: "opaque-item" },
      { role: "user", content: [{ type: "input_text", text: "after" }] },
      { type: "compaction_trigger" },
    ]);

    await runtime.removeRuntimeApiKey("openai");
    assert.equal(registry.isUsingOAuth(selected), true);
    const before = structuredClone(branch);
    assert.equal(await handler(compactEvent(branch), context), undefined);
    assert.equal(requests.length, 2, "OAuth re-compaction does not dispatch");
    assert.deepEqual(branch, before, "deferral does not modify the existing checkpoint");
    const replay = replayHook()({ payload: replayPayload() }, context);
    assert.deepEqual(replay.input[0], { type: "compaction", encrypted_content: "opaque-item" });
    assert.equal(replay.input.some((item: any) => item.type === "compaction_trigger"), false);
  } finally {
    network.mock.restore();
  }
});

test("OpenAI environment and configured API keys permit compaction but do not override stored OAuth", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-environment-key";
  const authorizations: Array<string | null> = [];
  const network = mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization"));
    return new Response([
      { type: "response.output_item.done", item: { type: "compaction", encrypted_content: "key-item" } },
      { type: "response.completed", response: {} },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  try {
    for (const configuredKey of [undefined, "test-configured-key"]) {
      for (const oauth of [false, true]) {
        const { registry } = await openaiAuthRuntime(oauth, configuredKey);
        const selected = model({ provider: "openai" });
        assert.equal(registry.isUsingOAuth(selected), oauth);
        const { context } = makeContext(selected);
        Object.assign(context as object, { modelRegistry: registry });
        const before = authorizations.length;
        const result = await install(attemptDirectResponsesOperation)(compactEvent(), context);
        if (oauth) {
          assert.equal(result, undefined);
          assert.equal(authorizations.length, before);
        } else {
          assert.ok(result?.compaction);
          assert.equal(authorizations.at(-1), `Bearer ${configuredKey ?? "test-environment-key"}`);
        }
      }
    }
    assert.equal(authorizations.length, 2);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    network.mock.restore();
  }
});

test("OAuth exclusion is exact-provider-only on either Responses API; unknown auth follows normal operation validation", async () => {
  for (const api of ["openai-responses", "openai-codex-responses"]) {
    for (const provider of ["openai", "openai-codex", "custom-provider", "OpenAI"]) {
      const selected = model({ api, provider });
      const { attempt, calls } = recordingAttempt();
      const { context } = makeContext(selected);
      Object.assign(context as object, { modelRegistry: { isUsingOAuth: () => true } });
      const result = await install(attempt)(compactEvent(), context);
      assert.equal(calls(), provider === "openai" ? 0 : 1);
      if (provider === "openai") assert.equal(result, undefined);
      else assert.ok(result?.compaction);
    }
  }
  const { context, notifications } = makeContext(model({ provider: "openai" }));
  const result = await install(async () => ({ kind: "terminal", error: new Error("Authentication unavailable") }))(compactEvent(), context);
  assert.deepEqual(result, { cancel: true });
  assert.match(notifications[0]!.message, /Authentication unavailable/);
});
