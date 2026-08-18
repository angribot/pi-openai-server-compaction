import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  installRemoteCompaction,
  NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  type CompactionCompatibilityResolver,
} from "../src/remote-compaction.ts";
import {
  assistantMessage,
  chainEntries,
  compactionEvent,
  createHookContext,
  createRecordingPi,
  messageEntry,
  responsesModel,
  type TestBranchEntry,
} from "./support/pi-fixtures.ts";
import {
  accepted,
  firstCompactionItem,
  recordingAttempt,
  retryable,
  secondCompactionItem,
  terminal,
} from "./support/responses-fixtures.ts";

function legacyRemoteDetails(
  item = firstCompactionItem,
  model = responsesModel(),
): Record<string, unknown> {
  return {
    remoteCompaction: {
      version: 2,
      modelKey: {
        provider: model.provider,
        api: model.api,
        id: model.id,
      },
      replacementHistory: [item],
    },
  };
}

function nativeReplayDetails(
  item = firstCompactionItem,
  model = responsesModel(),
  compatibilityClass: string | null = null,
): Record<string, unknown> {
  return {
    nativeReplayCheckpoint: {
      format: "native-replay-checkpoint/1",
      producer: {
        modelKey: {
          provider: model.provider,
          api: model.api,
          id: model.id,
        },
        compactionCompatibilityClass: compatibilityClass,
      },
      replacementHistory: [item],
    },
  };
}

function checkpointBranch(
  options: {
    details?: unknown;
    summary?: string;
    suffix?: Array<Omit<TestBranchEntry, "parentId" | "timestamp">>;
  } = {},
): TestBranchEntry[] {
  return chainEntries([
    messageEntry("old", {
      role: "user",
      content: [{ type: "text", text: "OLD-DROPPED" }],
      timestamp: 1,
    }),
    messageEntry("retained", {
      role: "user",
      content: [{ type: "text", text: "RETAINED" }],
      timestamp: 2,
    }),
    {
      type: "compaction",
      id: "checkpoint",
      summary: options.summary ?? REMOTE_COMPACTION_CHECKPOINT_MARKER,
      firstKeptEntryId: "retained",
      tokensBefore: 100,
      details: options.details === undefined ? legacyRemoteDetails() : options.details,
    },
    ...(options.suffix ?? [
      messageEntry("post", {
        role: "user",
        content: [{ type: "text", text: "POST" }],
        timestamp: 3,
      }),
    ]),
  ]);
}

function compatibilityDecisionEntry(
  id: string,
  target: ReturnType<typeof responsesModel>,
  compactionCompatibilityClass: string | null,
  compatible: boolean,
  checkpointId = "checkpoint",
): Omit<TestBranchEntry, "parentId" | "timestamp"> {
  return {
    type: "custom",
    id,
    customType: NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE,
    data: {
      checkpointId,
      target: {
        modelKey: {
          provider: target.provider,
          api: target.api,
          id: target.id,
        },
        compactionCompatibilityClass,
      },
      compatible,
    },
  };
}

function installed(
  outcomes = [accepted()],
  resolveCompatibilityClass?: CompactionCompatibilityResolver,
) {
  const recorded = recordingAttempt(outcomes);
  const fixture = createRecordingPi();
  installRemoteCompaction(fixture.pi, recorded.attempt, resolveCompatibilityClass);
  return { ...fixture, ...recorded };
}

function hook(fixture: ReturnType<typeof installed>, name: string) {
  const handler = fixture.handlers.get(name);
  assert.ok(handler, `missing ${name} hook`);
  return handler;
}

const usage = {
  input: 10,
  output: 2,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 13,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("attempts only Eligible models and publishes one atomic first compaction", async () => {
  const tools = [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      name: "inactive",
      description: "Inactive",
      parameters: { type: "object" },
    },
  ] as unknown as ToolInfo[];
  const recorded = recordingAttempt([
    accepted(firstCompactionItem, usage),
    accepted(firstCompactionItem, usage),
  ]);
  const fixture = createRecordingPi({ tools, activeTools: ["read"] });
  installRemoteCompaction(fixture.pi, recorded.attempt);
  const branch = chainEntries([
    messageEntry("user", {
      role: "user",
      content: [{ type: "text", text: "FIRST-CONTEXT" }],
      timestamp: 1,
    }),
  ]);
  const { context } = createHookContext({ branch, systemPrompt: "SYSTEM-PROMPT" });

  const result = (await fixture.handlers.get("session_before_compact")?.(
    compactionEvent(branch, undefined, "CUSTOM-GUIDANCE"),
    context,
  )) as any;

  assert.equal(recorded.requests.length, 1);
  assert.deepEqual(recorded.requests[0], {
    model: recorded.requests[0]?.model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "FIRST-CONTEXT" }],
      },
      { type: "compaction_trigger" },
    ],
    instructions: "SYSTEM-PROMPT\n\nAdditional compaction instructions:\nCUSTOM-GUIDANCE",
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    store: false,
  });
  assert.notEqual(recorded.requests[0]?.model, context.model);
  assert.deepEqual(result, {
    compaction: {
      summary: REMOTE_COMPACTION_CHECKPOINT_MARKER,
      firstKeptEntryId: "user",
      tokensBefore: 123,
      usage,
      details: nativeReplayDetails(),
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /compaction_trigger|SYSTEM-PROMPT|CUSTOM-GUIDANCE/);
  assert.deepEqual(fixture.appendedEntries, []);

  const codexModel = responsesModel({
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-sol",
  });
  const codexBranch = chainEntries([
    messageEntry("codex-user", {
      role: "user",
      content: [{ type: "text", text: "CODEX-CONTEXT" }],
      timestamp: 2,
    }),
  ]);
  const codex = createHookContext({ branch: codexBranch, model: codexModel });
  const codexResult = (await fixture.handlers.get("session_before_compact")?.(
    compactionEvent(codexBranch),
    codex.context,
  )) as any;
  assert.equal(recorded.requests.length, 2);
  assert.equal(recorded.requests[1]?.model.provider, "openai-codex");
  assert.equal(recorded.requests[1]?.model.api, "openai-codex-responses");
  assert.equal(recorded.contexts[1]?.sessionId, "test-session");
  assert.deepEqual(
    codexResult.compaction.details,
    nativeReplayDetails(firstCompactionItem, codexModel, "3000"),
  );

  const ineligibleBranch = chainEntries([
    messageEntry("other", {
      role: "user",
      content: [{ type: "text", text: "OTHER" }],
      timestamp: 2,
    }),
  ]);
  const ineligible = createHookContext({
    branch: ineligibleBranch,
    model: responsesModel({
      provider: "third-party-codex",
      api: "openai-codex-responses",
    }),
  });
  assert.equal(
    await fixture.handlers.get("session_before_compact")?.(
      compactionEvent(ineligibleBranch),
      ineligible.context,
    ),
    undefined,
  );
  assert.equal(recorded.requests.length, 2);
});

test("owns one immutable three-attempt retry budget and cancels terminal failures", async () => {
  const branch = chainEntries([
    messageEntry("user", {
      role: "user",
      content: [{ type: "text", text: "RETRY-CONTEXT" }],
      timestamp: 1,
    }),
  ]);
  const fixture = installed([retryable("one"), retryable("two"), accepted()]);
  const { context } = createHookContext({ branch });
  const result = await hook(fixture, "session_before_compact")(compactionEvent(branch), context);
  assert.ok((result as any)?.compaction);
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.requests[0], fixture.requests[1]);
  assert.equal(fixture.requests[1], fixture.requests[2]);
  assert.ok(Object.isFrozen(fixture.requests[0]));
  assert.ok(Object.isFrozen(fixture.requests[0]?.input));

  const exhausted = installed([retryable(), retryable(), retryable()]);
  assert.deepEqual(
    await hook(exhausted, "session_before_compact")(
      compactionEvent(branch),
      createHookContext({ branch }).context,
    ),
    { cancel: true },
  );
  assert.equal(exhausted.requests.length, 3);

  const terminalFixture = installed([terminal("context_length_exceeded")]);
  assert.deepEqual(
    await hook(terminalFixture, "session_before_compact")(
      compactionEvent(branch),
      createHookContext({ branch }).context,
    ),
    { cancel: true },
  );
  assert.equal(terminalFixture.requests.length, 1);
  assert.match(JSON.stringify(terminalFixture.requests[0]?.input), /RETRY-CONTEXT/);
});

test("cancels preparation and abort races without leaking partial acceptance", async () => {
  const malformedBranch = chainEntries([
    messageEntry("future", {
      role: "futureRole",
      content: "VISIBLE-BUT-UNREPRESENTABLE",
    } as unknown as AgentMessage),
  ]);
  const malformed = installed();
  assert.deepEqual(
    await hook(malformed, "session_before_compact")(
      compactionEvent(malformedBranch),
      createHookContext({ branch: malformedBranch }).context,
    ),
    { cancel: true },
  );
  assert.equal(malformed.requests.length, 0);

  const branch = chainEntries([
    messageEntry("user", {
      role: "user",
      content: [{ type: "text", text: "ABORT" }],
      timestamp: 1,
    }),
  ]);
  const preAborted = new AbortController();
  preAborted.abort();
  const noAttempt = installed();
  assert.deepEqual(
    await hook(noAttempt, "session_before_compact")(
      compactionEvent(branch, preAborted.signal),
      createHookContext({ branch }).context,
    ),
    { cancel: true },
  );
  assert.equal(noAttempt.requests.length, 0);

  const acceptedThenAborted = new AbortController();
  const acceptedFixture = createRecordingPi();
  let acceptedCalls = 0;
  installRemoteCompaction(acceptedFixture.pi, async () => {
    acceptedCalls++;
    acceptedThenAborted.abort();
    return accepted(firstCompactionItem, usage);
  });
  assert.deepEqual(
    await acceptedFixture.handlers.get("session_before_compact")?.(
      compactionEvent(branch, acceptedThenAborted.signal),
      createHookContext({ branch }).context,
    ),
    { cancel: true },
  );
  assert.equal(acceptedCalls, 1);

  const duringDelay = new AbortController();
  const delayFixture = createRecordingPi();
  let delayCalls = 0;
  installRemoteCompaction(delayFixture.pi, async () => {
    delayCalls++;
    queueMicrotask(() => duringDelay.abort());
    return retryable("wait", 60_000);
  });
  assert.deepEqual(
    await delayFixture.handlers.get("session_before_compact")?.(
      compactionEvent(branch, duringDelay.signal),
      createHookContext({ branch }).context,
    ),
    { cancel: true },
  );
  assert.equal(delayCalls, 1);
});

function replayPayload(...suffix: unknown[]): Record<string, unknown> {
  return {
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "The conversation history before this point was compacted into the following summary:\n\n" +
              `<summary>\n${REMOTE_COMPACTION_CHECKPOINT_MARKER}\n</summary>`,
          },
        ],
      },
      { role: "user", content: [{ type: "input_text", text: "RETAINED" }] },
      ...suffix,
    ],
  };
}

test("replays equal Compaction compatibility classes across providers and eligible APIs", () => {
  const producer = responsesModel({ id: "gpt-5.6-sol" });
  const target = responsesModel({
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-luna",
  });
  const branch = checkpointBranch({
    details: nativeReplayDetails(firstCompactionItem, producer, "3000"),
    suffix: [],
  });
  const fixture = installed();
  const observed = createHookContext({ branch, model: target });

  assert.deepEqual(
    hook(fixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload() },
      observed.context,
    ),
    { input: [firstCompactionItem] },
  );
  assert.equal(observed.abortCalls.count, 0);
  assert.deepEqual(fixture.appendedEntries, [
    {
      customType: NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE,
      data: {
        checkpointId: "checkpoint",
        target: {
          modelKey: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.6-luna",
          },
          compactionCompatibilityClass: "3000",
        },
        compatible: true,
      },
    },
  ]);

  const thirdParty = responsesModel({
    provider: "third-party-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-terra",
  });
  const ineligibleFixture = installed();
  const ineligible = createHookContext({ branch, model: thirdParty });
  assert.equal(
    hook(ineligibleFixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload() },
      ineligible.context,
    ),
    undefined,
  );
  assert.equal(ineligible.abortCalls.count, 0);
  assert.equal(ineligible.notifications.at(-1)?.level, "warning");
  assert.deepEqual(ineligibleFixture.appendedEntries, [
    {
      customType: NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE,
      data: {
        checkpointId: "checkpoint",
        target: {
          modelKey: {
            provider: "third-party-codex",
            api: "openai-codex-responses",
            id: "gpt-5.6-terra",
          },
          compactionCompatibilityClass: "3000",
        },
        compatible: false,
      },
    },
  ]);
});

test("prefers Compaction compatibility class before exact Model key fallback and keeps legacy semantics", () => {
  const producer = responsesModel({ id: "gpt-5.6-sol" });
  const classAwareBranch = checkpointBranch({
    details: nativeReplayDetails(firstCompactionItem, producer, "3000"),
    suffix: [],
  });
  const differentClass = responsesModel({ id: "gpt-5.5" });
  const differentFixture = installed();
  const different = createHookContext({ branch: classAwareBranch, model: differentClass });
  assert.equal(
    hook(differentFixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload() },
      different.context,
    ),
    undefined,
  );
  assert.equal(different.notifications.at(-1)?.level, "warning");
  assert.deepEqual(differentFixture.appendedEntries[0]?.data, {
    checkpointId: "checkpoint",
    target: {
      modelKey: {
        provider: "example-provider",
        api: "openai-responses",
        id: "gpt-5.5",
      },
      compactionCompatibilityClass: "2911",
    },
    compatible: false,
  });

  const unknownResolver: CompactionCompatibilityResolver = () => undefined;
  const exactFixture = installed([accepted()], unknownResolver);
  const exact = createHookContext({ branch: classAwareBranch, model: producer });
  assert.deepEqual(
    hook(exactFixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload() },
      exact.context,
    ),
    { input: [firstCompactionItem] },
  );
  assert.equal((exactFixture.appendedEntries[0]?.data as any).compatible, true);

  const legacyBranch = checkpointBranch({
    details: legacyRemoteDetails(firstCompactionItem, producer),
    suffix: [],
  });
  const legacyTarget = responsesModel({ id: "gpt-5.6-luna" });
  const legacyFixture = installed();
  const legacy = createHookContext({ branch: legacyBranch, model: legacyTarget });
  assert.equal(
    hook(legacyFixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload() },
      legacy.context,
    ),
    undefined,
  );
  assert.equal(legacy.notifications.at(-1)?.level, "warning");
  assert.deepEqual(legacyFixture.appendedEntries, []);

  const uncataloged = responsesModel({ id: "future-model" });
  const uncatalogedBranch = checkpointBranch({
    details: nativeReplayDetails(firstCompactionItem, uncataloged, null),
    suffix: [],
  });
  const uncatalogedFixture = installed();
  const uncatalogedContext = createHookContext({ branch: uncatalogedBranch, model: uncataloged });
  assert.deepEqual(
    hook(uncatalogedFixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload() },
      uncatalogedContext.context,
    ),
    { input: [firstCompactionItem] },
  );
  assert.deepEqual(uncatalogedFixture.appendedEntries, []);
});

test("reconstructs latest built-in Codex Remote compaction v2 state and replaces one unique full-array replay span", () => {
  const selectedModel = responsesModel({
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-codex",
  });
  const branch = checkpointBranch({
    details: legacyRemoteDetails(firstCompactionItem, selectedModel),
  });
  const fixture = installed();
  const { context, abortCalls } = createHookContext({
    branch,
    model: { ...selectedModel, baseUrl: "https://different-route.example" },
  });
  const before = { type: "provider_context", value: "BEFORE" };
  const after = { type: "provider_context", value: "AFTER" };
  const marker = {
    role: "user",
    content: [
      {
        type: "input_text",
        text:
          "The conversation history before this point was compacted into the following summary:\n\n" +
          `<summary>\n${REMOTE_COMPACTION_CHECKPOINT_MARKER}\n</summary>`,
      },
    ],
  };
  const retained = {
    role: "user",
    content: [{ type: "input_text", text: "RETAINED" }],
  };
  const post = {
    role: "user",
    content: [{ type: "input_text", text: "POST" }],
  };
  const payload = {
    model: "gpt-test",
    input: [before, marker, retained, post, after],
    messages: ["legacy"],
    previous_response_id: "resp-old",
    temperature: 0.5,
  };

  const patched = hook(fixture, "before_provider_request")(
    { type: "before_provider_request", payload },
    context,
  ) as any;
  assert.deepEqual(patched, {
    model: "gpt-test",
    input: [before, firstCompactionItem, post, after],
    temperature: 0.5,
  });
  assert.equal(abortCalls.count, 0);

  const fresh = installed();
  assert.deepEqual(
    hook(fresh, "before_provider_request")({ type: "before_provider_request", payload }, context),
    patched,
  );
});

test("reconstructs request-time decisions without reinterpreting historical turns", () => {
  const producer = responsesModel({ id: "gpt-5.6-sol" });
  const historicalTarget = responsesModel({
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-luna",
  });
  const branch = checkpointBranch({
    details: nativeReplayDetails(firstCompactionItem, producer, "3000"),
    suffix: [
      compatibilityDecisionEntry("decision", historicalTarget, "3000", true),
      messageEntry("assistant", assistantMessage("compatible", historicalTarget)),
    ],
  });
  const changedCatalog: CompactionCompatibilityResolver = (id) =>
    id === "gpt-5.6-luna" ? "future-class" : id === "gpt-5.6-sol" ? "3000" : undefined;
  const forkBeforeEvidence = checkpointBranch({
    details: nativeReplayDetails(firstCompactionItem, producer, "3000"),
    suffix: [],
  });
  const forkBeforeFixture = installed([accepted()], changedCatalog);
  const forkBefore = createHookContext({ branch: forkBeforeEvidence, model: producer });
  assert.deepEqual(
    hook(forkBeforeFixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload() },
      forkBefore.context,
    ),
    { input: [firstCompactionItem] },
  );

  const fixture = installed([accepted()], changedCatalog);
  const observed = createHookContext({ branch, model: producer });
  const suffix = { type: "provider_context", value: "AFTER-CHECKPOINT" };

  assert.deepEqual(
    hook(fixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload(suffix) },
      observed.context,
    ),
    { input: [firstCompactionItem, suffix] },
  );
  assert.equal(observed.abortCalls.count, 0);
  assert.equal((fixture.appendedEntries[0]?.data as any).compatible, true);

  const futureRequestFixture = installed([accepted()], changedCatalog);
  const futureRequest = createHookContext({ branch, model: historicalTarget });
  assert.equal(
    hook(futureRequestFixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload(suffix) },
      futureRequest.context,
    ),
    undefined,
  );
  assert.equal(futureRequest.abortCalls.count, 0);
  assert.equal(futureRequest.notifications.at(-1)?.level, "warning");
  assert.equal((futureRequestFixture.appendedEntries[0]?.data as any).compatible, false);

  const fresh = installed([accepted()], changedCatalog);
  const freshObserved = createHookContext({ branch, model: producer });
  assert.deepEqual(
    hook(fresh, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload(suffix) },
      freshObserved.context,
    ),
    { input: [firstCompactionItem, suffix] },
  );
});

test("consumes Compatibility decision records according to persisted assistant outcomes", async () => {
  const producer = responsesModel({ id: "gpt-5.6-sol" });
  const incompatible = responsesModel({ id: "gpt-5.5" });

  for (const stopReason of ["error", "aborted"] as const) {
    const branch = checkpointBranch({
      details: nativeReplayDetails(firstCompactionItem, producer, "3000"),
      suffix: [
        compatibilityDecisionEntry(`decision-${stopReason}`, incompatible, "2911", false),
        messageEntry(
          `assistant-${stopReason}`,
          assistantMessage("failed", incompatible, { stopReason }),
        ),
      ],
    });
    const fixture = installed();
    const observed = createHookContext({ branch, model: producer });
    assert.deepEqual(
      hook(fixture, "before_provider_request")(
        { type: "before_provider_request", payload: replayPayload() },
        observed.context,
      ),
      { input: [firstCompactionItem] },
      stopReason,
    );
    assert.equal(observed.abortCalls.count, 0, stopReason);
  }

  const superseded = checkpointBranch({
    details: nativeReplayDetails(firstCompactionItem, producer, "3000"),
    suffix: [
      compatibilityDecisionEntry("abandoned", incompatible, "2911", false),
      compatibilityDecisionEntry("replacement", producer, "3000", true),
      messageEntry("compatible-assistant", assistantMessage("compatible", producer)),
    ],
  });
  const supersededFixture = installed();
  const supersededContext = createHookContext({ branch: superseded, model: producer });
  assert.deepEqual(
    hook(supersededFixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload() },
      supersededContext.context,
    ),
    { input: [firstCompactionItem] },
  );

  const invalidated = checkpointBranch({
    details: nativeReplayDetails(firstCompactionItem, producer, "3000"),
    suffix: [
      compatibilityDecisionEntry("incompatible", incompatible, "2911", false),
      messageEntry("incompatible-assistant", assistantMessage("success", incompatible)),
    ],
  });
  const invalidatedFixture = installed();
  const invalidatedContext = createHookContext({ branch: invalidated, model: producer });
  assert.equal(
    hook(invalidatedFixture, "before_provider_request")(
      { type: "before_provider_request", payload: replayPayload() },
      invalidatedContext.context,
    ),
    undefined,
  );
  assert.equal(invalidatedContext.abortCalls.count, 1);
  assert.deepEqual(
    await hook(invalidatedFixture, "session_before_compact")(
      compactionEvent(invalidated),
      invalidatedContext.context,
    ),
    { cancel: true },
  );
});

test("fails closed on missing, malformed, or mismatched class-aware evidence", async () => {
  const producer = responsesModel({ id: "gpt-5.6-sol" });
  const target = responsesModel({ id: "gpt-5.6-luna" });
  const cases: Array<[string, Array<Omit<TestBranchEntry, "parentId" | "timestamp">>]> = [
    ["missing", [messageEntry("assistant", assistantMessage("success", target))]],
    [
      "malformed",
      [
        {
          type: "custom",
          id: "malformed",
          customType: NATIVE_REPLAY_COMPATIBILITY_DECISION_TYPE,
          data: { compatible: true },
        },
      ],
    ],
    [
      "wrong checkpoint",
      [compatibilityDecisionEntry("wrong", target, "3000", true, "other-checkpoint")],
    ],
    ["inconsistent", [compatibilityDecisionEntry("inconsistent", target, "3000", false)]],
    [
      "assistant mismatch",
      [
        compatibilityDecisionEntry("decision", target, "3000", true),
        messageEntry("assistant", assistantMessage("success", producer)),
      ],
    ],
  ];

  for (const [name, suffix] of cases) {
    const branch = checkpointBranch({
      details: nativeReplayDetails(firstCompactionItem, producer, "3000"),
      suffix,
    });
    const fixture = installed();
    const observed = createHookContext({ branch, model: producer });
    assert.equal(
      hook(fixture, "before_provider_request")(
        { type: "before_provider_request", payload: replayPayload() },
        observed.context,
      ),
      undefined,
      name,
    );
    assert.equal(observed.abortCalls.count, 1, name);
    assert.deepEqual(
      await hook(fixture, "session_before_compact")(compactionEvent(branch), observed.context),
      { cancel: true },
      name,
    );
  }
});

test("repeated compaction accepts a Compatible model and records its current class", async () => {
  const producer = responsesModel({ id: "gpt-5.4" });
  const target = responsesModel({ provider: "other-route", id: "gpt-5.5" });
  const branch = checkpointBranch({
    details: nativeReplayDetails(firstCompactionItem, producer, "2911"),
    suffix: [
      messageEntry("suffix-user", {
        role: "user",
        content: [{ type: "text", text: "CLASS-SUFFIX" }],
        timestamp: 4,
      }),
    ],
  });
  const fixture = installed([accepted(secondCompactionItem)]);
  const result = (await hook(fixture, "session_before_compact")(
    compactionEvent(branch),
    createHookContext({ branch, model: target }).context,
  )) as any;

  assert.deepEqual(fixture.requests[0]?.input[0], firstCompactionItem);
  assert.match(JSON.stringify(fixture.requests[0]?.input), /CLASS-SUFFIX/);
  assert.deepEqual(fixture.requests[0]?.input.at(-1), { type: "compaction_trigger" });
  assert.deepEqual(
    result.compaction.details,
    nativeReplayDetails(secondCompactionItem, target, "2911"),
  );
});

test("hard-stops malformed, stateless, missing, and ambiguous native replay", async () => {
  const branch = checkpointBranch();
  const marker = {
    role: "user",
    content: [
      {
        type: "input_text",
        text:
          "The conversation history before this point was compacted into the following summary:\n\n" +
          `<summary>\n${REMOTE_COMPACTION_CHECKPOINT_MARKER}\n</summary>`,
      },
    ],
  };
  const retained = { role: "user", content: [{ type: "input_text", text: "RETAINED" }] };
  const cases: Array<[string, unknown]> = [
    ["non-array", { input: "stateless" }],
    ["missing", { input: [{ role: "user", content: [] }] }],
    ["ambiguous", { input: [marker, retained, marker, retained] }],
  ];

  for (const [name, payload] of cases) {
    const fixture = installed();
    const observed = createHookContext({ branch });
    assert.equal(
      hook(fixture, "before_provider_request")(
        { type: "before_provider_request", payload },
        observed.context,
      ),
      undefined,
      name,
    );
    assert.equal(observed.abortCalls.count, 1, name);
    assert.equal(observed.notifications.at(-1)?.level, "error", name);
  }

  const oldValid = checkpointBranch({ suffix: [] });
  const broken = chainEntries([
    ...oldValid.map(({ parentId: _parentId, timestamp: _timestamp, ...entry }) => entry),
    {
      type: "compaction",
      id: "broken-latest",
      summary: REMOTE_COMPACTION_CHECKPOINT_MARKER,
      firstKeptEntryId: "checkpoint",
      tokensBefore: 200,
      details: {
        remoteCompaction: {
          version: 2,
          provider: "openai-responses-compaction",
          implementation: "responses_compaction_v2",
          modelKey: "example-provider:openai-responses:gpt-test",
          replacementHistory: [firstCompactionItem, { role: "user", content: [] }],
          usage,
        },
      },
    },
  ]);
  const brokenFixture = installed();
  const brokenContext = createHookContext({ branch: broken });
  assert.equal(
    hook(brokenFixture, "before_provider_request")(
      { type: "before_provider_request", payload: { input: [] } },
      brokenContext.context,
    ),
    undefined,
  );
  assert.equal(brokenContext.abortCalls.count, 1);
  assert.deepEqual(
    await hook(brokenFixture, "session_before_compact")(
      compactionEvent(broken),
      brokenContext.context,
    ),
    { cancel: true },
  );
});

test("does not resurrect an older checkpoint past a later ordinary compaction", () => {
  const older = checkpointBranch({ suffix: [] });
  const branch = chainEntries([
    ...older.map(({ parentId: _parentId, timestamp: _timestamp, ...entry }) => entry),
    {
      type: "compaction",
      id: "ordinary-latest",
      summary: "ordinary text summary",
      firstKeptEntryId: "checkpoint",
      tokensBefore: 200,
      details: { ordinary: true },
    },
  ]);
  const fixture = installed();
  const observed = createHookContext({ branch });
  assert.equal(
    hook(fixture, "before_provider_request")(
      { type: "before_provider_request", payload: { input: [] } },
      observed.context,
    ),
    undefined,
  );
  assert.equal(observed.abortCalls.count, 0);
});

test("uses structured case-sensitive compatibility and invalidates only persisted successful assistants", async () => {
  const branch = checkpointBranch();
  const incompatibleFixture = installed();
  const incompatible = createHookContext({
    branch,
    model: responsesModel({ provider: "Example-Provider" }),
  });
  const originalPayload = { input: [{ role: "user", content: [] }] };
  assert.equal(
    hook(incompatibleFixture, "before_provider_request")(
      { type: "before_provider_request", payload: originalPayload },
      incompatible.context,
    ),
    undefined,
  );
  assert.equal(incompatible.abortCalls.count, 0);
  assert.equal(incompatible.notifications.at(-1)?.level, "warning");

  const incompatibleApi = createHookContext({
    branch,
    model: responsesModel({
      provider: "other-provider",
      api: "anthropic-messages",
      id: "other-model",
    }),
  });
  assert.equal(
    hook(incompatibleFixture, "before_provider_request")(
      { type: "before_provider_request", payload: originalPayload },
      incompatibleApi.context,
    ),
    undefined,
  );
  assert.equal(incompatibleApi.abortCalls.count, 0);
  assert.equal(incompatibleApi.notifications.at(-1)?.level, "warning");

  for (const stopReason of ["error", "aborted"] as const) {
    const nonInvalidating = checkpointBranch({
      suffix: [
        messageEntry(
          `assistant-${stopReason}`,
          assistantMessage("partial", responsesModel({ id: "other-model" }), { stopReason }),
        ),
      ],
    });
    const fixture = installed();
    const observed = createHookContext({ branch: nonInvalidating });
    const marker = {
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            "The conversation history before this point was compacted into the following summary:\n\n" +
            `<summary>\n${REMOTE_COMPACTION_CHECKPOINT_MARKER}\n</summary>`,
        },
      ],
    };
    const retained = { role: "user", content: [{ type: "input_text", text: "RETAINED" }] };
    assert.deepEqual(
      hook(fixture, "before_provider_request")(
        { type: "before_provider_request", payload: { input: [marker, retained] } },
        observed.context,
      ),
      { input: [firstCompactionItem] },
    );
    assert.equal(observed.abortCalls.count, 0);
  }

  const invalidatingAssistants = [
    assistantMessage("successful incompatible turn", responsesModel({ id: "other-model" })),
    assistantMessage("", responsesModel({ id: "other-model" }), {
      content: [
        {
          type: "toolCall",
          id: "other-call|fc-other",
          name: "read",
          arguments: { path: "x" },
        },
      ],
      stopReason: "toolUse",
    }),
  ];
  for (const [index, invalidatingAssistant] of invalidatingAssistants.entries()) {
    const invalidated = checkpointBranch({
      suffix: [messageEntry(`other-assistant-${index}`, invalidatingAssistant)],
    });
    const invalidFixture = installed();
    const observed = createHookContext({ branch: invalidated });
    assert.equal(
      hook(invalidFixture, "before_provider_request")(
        { type: "before_provider_request", payload: { input: [] } },
        observed.context,
      ),
      undefined,
    );
    assert.equal(observed.abortCalls.count, 1);
    assert.deepEqual(
      await hook(invalidFixture, "session_before_compact")(
        compactionEvent(invalidated),
        observed.context,
      ),
      { cancel: true },
    );
    assert.equal(invalidFixture.requests.length, 0);
  }
});

test("repeated compaction uses one old item plus projected suffix and atomically supersedes it", async () => {
  const target = responsesModel();
  const suffixAssistant = assistantMessage("SUFFIX-ASSISTANT", target, {
    content: [
      {
        type: "thinking",
        thinking: "",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs-suffix",
          encrypted_content: "SIGNED-SUFFIX",
          summary: [],
        }),
      },
      { type: "text", text: "SUFFIX-ASSISTANT" },
      { type: "toolCall", id: "suffix-call|fc-suffix", name: "read", arguments: { path: "x" } },
    ],
    stopReason: "toolUse",
  });
  const branch = checkpointBranch({
    suffix: [
      messageEntry("suffix-user", {
        role: "user",
        content: [{ type: "text", text: "SUFFIX-USER" }],
        timestamp: 4,
      }),
      messageEntry("suffix-assistant", suffixAssistant),
      messageEntry("suffix-result", {
        role: "toolResult",
        toolCallId: "suffix-call|fc-suffix",
        toolName: "read",
        content: [{ type: "text", text: "SUFFIX-RESULT" }],
        isError: false,
        timestamp: 5,
      }),
      {
        type: "message",
        id: "suffix-custom",
        message: {
          role: "custom",
          customType: "note",
          content: "SUFFIX-CUSTOM",
          display: true,
          timestamp: 6,
        },
      },
    ],
  });
  const fixture = installed([accepted(secondCompactionItem), accepted(firstCompactionItem)]);
  const result = (await hook(fixture, "session_before_compact")(
    compactionEvent(branch),
    createHookContext({ branch }).context,
  )) as any;
  const input = fixture.requests[0]?.input ?? [];
  assert.deepEqual(input[0], firstCompactionItem);
  assert.deepEqual(input.at(-1), { type: "compaction_trigger" });
  const serialized = JSON.stringify(input);
  for (const expected of [
    "SUFFIX-USER",
    "SUFFIX-ASSISTANT",
    "SIGNED-SUFFIX",
    "SUFFIX-RESULT",
    "SUFFIX-CUSTOM",
  ]) {
    assert.match(serialized, new RegExp(expected));
  }
  assert.doesNotMatch(serialized, /RETAINED|OLD-DROPPED|Remote Responses compaction checkpoint/);
  assert.equal(serialized.match(/FIRST-OPAQUE/g)?.length, 1);
  assert.deepEqual(result.compaction.details, nativeReplayDetails(secondCompactionItem));
  assert.doesNotMatch(JSON.stringify(result), /FIRST-OPAQUE|SUFFIX-USER/);

  const latestBranch = chainEntries([
    ...branch.map(({ parentId: _parentId, timestamp: _timestamp, ...entry }) => entry),
    {
      type: "compaction",
      id: "checkpoint-2",
      summary: REMOTE_COMPACTION_CHECKPOINT_MARKER,
      firstKeptEntryId: "suffix-custom",
      tokensBefore: 200,
      details: result.compaction.details,
    },
  ]);
  await hook(fixture, "session_before_compact")(
    compactionEvent(latestBranch),
    createHookContext({ branch: latestBranch }).context,
  );
  assert.deepEqual(fixture.requests[1]?.input[0], secondCompactionItem);
  assert.doesNotMatch(JSON.stringify(fixture.requests[1]?.input), /FIRST-OPAQUE/);

  const fresh = installed([accepted(firstCompactionItem)]);
  await hook(fresh, "session_before_compact")(
    compactionEvent(latestBranch),
    createHookContext({ branch: latestBranch }).context,
  );
  assert.deepEqual(fresh.requests[0]?.input[0], secondCompactionItem);
  assert.doesNotMatch(JSON.stringify(fresh.requests[0]?.input), /FIRST-OPAQUE/);
});
