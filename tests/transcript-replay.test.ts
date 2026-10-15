import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as zlib from "node:zlib";
import {
  normalizeContext,
  type AssistantMessage,
  type Message,
  type Model,
  type SystemMessage,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { stream as codexResponsesStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as directResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { buildSessionContext, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import {
  compactionInstructions,
  prepareCompactionReplay,
  prepareNativeReplay,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  type BranchEntry,
  type NativeReplayCheckpointDetails,
} from "../src/native-replay.ts";

// ---------------------------------------------------------------------------
// Pi 0.99.1 public-behavior oracle
//
// These helpers drive Pi's real Responses providers with a mocked fetch. The
// captured body is what Pi would send on the wire, so projection and replay
// alignment are checked against the provider payload rather than a local
// expected projection.
// ---------------------------------------------------------------------------

type ApiKind = "direct" | "codex";

const COMPACTION_ITEM = { type: "compaction", encrypted_content: "opaque-item" } as const;
const READ_TOOL = {
  name: "read",
  description: "read tool",
  parameters: { type: "object", properties: {} },
};
const TOOL_DECLARATION_TYPES = new Set([
  "additional_tools",
  "tool_search_call",
  "tool_search_output",
]);

function model(kind: ApiKind, overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    provider: kind === "direct" ? "openai" : "openai-codex",
    api: kind === "direct" ? "openai-responses" : "openai-codex-responses",
    id: "gpt-5.6-sol",
    name: "transcript oracle model",
    baseUrl: kind === "direct" ? "https://model.example/v1" : "https://chatgpt.example/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

function withMidConvo(kind: ApiKind, supported: boolean): Model<any> {
  return model(kind, { compat: { supportsMidConvoSystemMessages: supported } });
}

function fakeJwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
  })}.sig`;
}

function terminalResponse(): Response {
  const encoder = new TextEncoder();
  const wire =
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_oracle",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
        status: "completed",
      },
    })}\r\n\r\n` +
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { status: "completed", output: [] },
    })}\r\n\r\n`;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(wire));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function realProviderPayload(
  kind: ApiKind,
  selectedModel: Model<any>,
  messages: readonly Message[],
  systemPrompt?: string,
  onPayload?: (payload: unknown) => unknown,
): Promise<Record<string, any>> {
  const transcript = normalizeContext({
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages: [...messages],
  });
  let body: Record<string, any> | undefined;
  const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    let raw: unknown = init?.body;
    if (headers.get("content-encoding") === "zstd") {
      const decompress = (zlib as { zstdDecompressSync?: (value: Buffer) => Buffer })
        .zstdDecompressSync;
      assert.ok(decompress, "the provider compressed the body without zstd decompression support");
      raw = decompress(Buffer.from(raw as Buffer));
    }
    body = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as Buffer).toString("utf8"));
    return terminalResponse();
  }) as typeof globalThis.fetch;

  const options: Record<string, unknown> = { fetch: fetchMock, onPayload };
  if (kind === "direct") options.apiKey = "sk-test";
  else {
    options.apiKey = fakeJwt();
    options.transport = "sse";
  }
  const provider = (kind === "direct" ? directResponsesStream : codexResponsesStream) as (
    model: Model<any>,
    context: ReturnType<typeof normalizeContext>,
    options: Record<string, unknown>,
  ) => AsyncIterable<unknown>;
  for await (const _event of provider(selectedModel, transcript, options)) {
    // Drain to completion so the provider finishes the request lifecycle.
  }
  assert.ok(body, "the provider did not issue a request body");
  return body;
}

/**
 * Remove only the documented differences between an ordinary provider payload
 * and a Remote compaction input: the leading prompt item (ordinary Responses
 * carries it in the input; Codex carries it in `instructions`) and any tool
 * declaration items. Everything else must be wire-equivalent.
 */
function stripProviderDeclarations(kind: ApiKind, input: readonly any[]): any[] {
  const items = [...input];
  const withoutLeading =
    kind === "direct" && items[0]?.role === "developer" ? items.slice(1) : items;
  return withoutLeading.filter((item) => !TOOL_DECLARATION_TYPES.has(String(item.type)));
}

function leadingText(kind: ApiKind, payload: Record<string, any>): string {
  return kind === "codex" ? payload.instructions : payload.input[0].content;
}

// ---------------------------------------------------------------------------
// Branch fixtures
// ---------------------------------------------------------------------------

let entryCounter = 0;

function timestamp(): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, entryCounter++)).toISOString();
}

function userEntry(id: string, text: string, parentId: string | null = null): BranchEntry {
  return {
    type: "message",
    id,
    parentId,
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
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-sol",
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

function toolCallAssistantEntry(id: string, parentId: string): BranchEntry {
  const call: ToolCall = {
    type: "toolCall",
    id: "call_1|fc_item_1",
    name: "read",
    arguments: { path: "/tmp/file" },
  };
  return assistantEntry(id, parentId, { content: [call] });
}

function toolResultEntry(id: string, parentId: string): BranchEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: timestamp(),
    message: {
      role: "toolResult",
      toolCallId: "call_1|fc_item_1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: entryCounter,
    },
  };
}

function systemEntry(
  id: string,
  parentId: string | null,
  systemMessage: SystemMessage,
): BranchEntry {
  return { type: "message", id, parentId, timestamp: timestamp(), message: systemMessage };
}

function checkpointDetails(
  selectedModel: Model<any> = model("direct"),
  compactionCompatibilityClass: string | null = null,
): NativeReplayCheckpointDetails {
  return {
    nativeReplayCheckpoint: {
      format: "native-replay-checkpoint/1",
      producer: {
        modelKey: {
          provider: selectedModel.provider,
          api: selectedModel.api,
          id: selectedModel.id,
        },
        compactionCompatibilityClass,
      },
      replacementHistory: [COMPACTION_ITEM],
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

function payloadMessages(branch: readonly BranchEntry[], leafId?: string): Message[] {
  return convertToLlm(buildSessionContext(branch as never, leafId as never).messages) as Message[];
}

function branchSuffixMessages(branch: readonly BranchEntry[]): Message[] {
  const index = branch.findIndex((entry) => entry.type === "compaction");
  return convertToLlm(
    branch.slice(index + 1).flatMap((entry) => (entry.message ? [entry.message] : [])),
  ) as Message[];
}

function containsMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes(REMOTE_COMPACTION_CHECKPOINT_MARKER);
  if (Array.isArray(value)) return value.some(containsMarker);
  if (value && typeof value === "object") return Object.values(value).some(containsMarker);
  return false;
}

function indexOfMarker(input: readonly unknown[]): number {
  return input.findIndex(containsMarker);
}

/**
 * First compaction: a leading text-array system prompt, a later section and
 * content update, a function call/result pair, and custom instructions. This
 * covers the leading/mid-conversation split, section additions/replacements/
 * removals, string and text-array content, tool declarations, and historical
 * function calls in one fixture.
 */
function firstCompactionBranch(): BranchEntry[] {
  const leading: SystemMessage = {
    role: "system",
    content: [{ type: "text", text: "ARRAY BASE" }],
    sections: { env: "ENV SECTION", style: "STYLE SECTION" },
    toolsAdded: [READ_TOOL],
    timestamp: 1,
  };
  const update: SystemMessage = {
    role: "system",
    content: "MID INSTRUCTIONS",
    sections: { style: null, extra: "EXTRA SECTION" },
    timestamp: 2,
  };
  return [
    systemEntry("s1", null, leading),
    userEntry("u1", "first question", "s1"),
    systemEntry("s2", "u1", update),
    toolCallAssistantEntry("a1", "s2"),
    toolResultEntry("t1", "a1"),
    userEntry("u2", "second question", "t1"),
  ];
}

function replayBranch(selectedModel: Model<any>, suffix: string): BranchEntry[] {
  const snapshot: SystemMessage = {
    role: "system",
    content: "BASE PROMPT",
    sections: { env: "ENV SECTION" },
    timestamp: 10,
  };
  return [
    userEntry("e1", "discarded before first kept"),
    userEntry("e2", "retained before checkpoint", "e1"),
    checkpointEntry("c1", "e2", "e2", checkpointDetails(selectedModel), snapshot),
    userEntry("e3", suffix, "c1"),
  ];
}

/**
 * Repeated compaction with a host snapshot plus a later section replacement and
 * an optional retained system message the host drops in favor of the snapshot.
 */
function repeatedCompactionBranch(
  selectedModel: Model<any>,
  includeRetainedSystem = false,
): BranchEntry[] {
  const snapshot: SystemMessage = {
    role: "system",
    content: "BASE PROMPT",
    sections: { style: "STYLE SECTION", env: "ENV OLD" },
    timestamp: 10,
  };
  const update: SystemMessage = {
    role: "system",
    content: "",
    sections: { style: null, extra: "EXTRA SECTION", env: "ENV NEW" },
    timestamp: 11,
  };
  const retainedSystem: SystemMessage = {
    role: "system",
    content: "",
    sections: { late: "LATE SECTION" },
    timestamp: 9,
  };
  return [
    userEntry("e1", "retained", null),
    ...(includeRetainedSystem ? [systemEntry("s0", "e1", retainedSystem)] : []),
    userEntry("e2", "kept two", includeRetainedSystem ? "s0" : "e1"),
    checkpointEntry("c1", "e2", "e1", checkpointDetails(selectedModel), snapshot),
    systemEntry("s2", "c1", update),
    userEntry("e3", "after checkpoint", "s2"),
  ];
}

function snapshotlessBranch(selectedModel: Model<any>, update?: SystemMessage): BranchEntry[] {
  return [
    userEntry("e1", "old"),
    userEntry("e2", "retained", "e1"),
    checkpointEntry("c1", "e2", "e2", checkpointDetails(selectedModel)),
    ...(update ? [systemEntry("s2", "c1", update)] : []),
    userEntry("e3", "after", update ? "s2" : "c1"),
  ];
}

// ---------------------------------------------------------------------------
// Remote compaction input parity
// ---------------------------------------------------------------------------

test("Remote compaction input matches the real provider projection for both API contracts and capabilities", async () => {
  for (const kind of ["direct", "codex"] as const) {
    for (const midConvo of [false, true]) {
      const selectedModel = withMidConvo(kind, midConvo);
      const branch = firstCompactionBranch();
      const ordinary = await realProviderPayload(kind, selectedModel, payloadMessages(branch));
      const label = `${kind} mid-convo=${midConvo}`;

      // The ordinary payload establishes where Pi places the effective prompt.
      const leading = leadingText(kind, ordinary);
      if (kind === "direct") {
        assert.equal(ordinary.instructions, undefined, label);
        assert.equal(
          ordinary.input.filter((item: any) => item.role === "developer").length,
          midConvo ? 2 : 1,
          label,
        );
        assert.equal(ordinary.tools?.[0]?.name, "read", label);
      } else {
        assert.equal(
          ordinary.input.some((item: any) => item.role === "developer"),
          midConvo,
          label,
        );
      }

      const preparation = prepareCompactionReplay(branch, selectedModel);
      assert.equal(preparation.kind, "ready", label);
      if (preparation.kind !== "ready") continue;

      assert.deepEqual(
        preparation.buildInput(),
        [...stripProviderDeclarations(kind, ordinary.input), { type: "compaction_trigger" }],
        label,
      );
      assert.equal(compactionInstructions(branch, selectedModel, undefined, ""), leading, label);
      assert.equal(
        compactionInstructions(branch, selectedModel, "  focus on the API  ", ""),
        `${leading}\n\nAdditional compaction instructions:\nfocus on the API`,
        label,
      );
    }
  }
});

test("repeated Remote compaction matches the real provider projection of the post-checkpoint suffix", async () => {
  for (const kind of ["direct", "codex"] as const) {
    for (const midConvo of [false, true]) {
      const selectedModel = withMidConvo(kind, midConvo);
      const branch = repeatedCompactionBranch(selectedModel, true);
      const label = `${kind} mid-convo=${midConvo}`;

      const fullOrdinary = await realProviderPayload(kind, selectedModel, payloadMessages(branch));
      // The host drops the retained system message in favor of the snapshot.
      assert.equal(JSON.stringify(fullOrdinary.input).includes("LATE SECTION"), false, label);
      const leading = leadingText(kind, fullOrdinary);
      // Section replacement folds into one prompt for collapse models and stays
      // an ordered update for mid-conversation models.
      assert.equal(leading.includes("EXTRA SECTION"), !midConvo, label);
      assert.equal(leading.includes("STYLE SECTION"), midConvo, label);
      assert.equal(leading.includes("ENV OLD"), midConvo, label);
      assert.equal(leading.includes("ENV NEW"), !midConvo, label);

      const suffix = await realProviderPayload(
        kind,
        selectedModel,
        branchSuffixMessages(branch),
        "ORACLE LEADING",
      );
      const preparation = prepareCompactionReplay(branch, selectedModel);
      assert.equal(preparation.kind, "ready", label);
      if (preparation.kind !== "ready") continue;
      assert.deepEqual(
        preparation.buildInput(),
        [
          COMPACTION_ITEM,
          ...stripProviderDeclarations(kind, suffix.input),
          { type: "compaction_trigger" },
        ],
        label,
      );
      assert.equal(compactionInstructions(branch, selectedModel, undefined, ""), leading, label);
    }
  }
});

test("tool additions, removals, and redefinitions project like Pi and stay out of compaction input", async () => {
  const selectedModel = model("codex", {
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  });
  const leading: SystemMessage = {
    role: "system",
    content: "",
    sections: { env: "ENV SECTION" },
    toolsAdded: [READ_TOOL],
    timestamp: 1,
  };
  const grepTool = {
    name: "grep",
    description: "grep tool",
    parameters: { type: "object", properties: {} },
  };
  const cases: Array<[string, SystemMessage, boolean, boolean]> = [
    ["addition", { role: "system", content: "", toolsAdded: [grepTool], timestamp: 2 }, true, true],
    [
      "removal",
      {
        role: "system",
        content: "",
        toolsRemoved: [{ name: "read" }],
        toolsAdded: [grepTool],
        timestamp: 3,
      },
      false,
      false,
    ],
    [
      "redefinition",
      {
        role: "system",
        content: "",
        toolsAdded: [{ ...READ_TOOL, description: "read tool v2" }],
        timestamp: 4,
      },
      false,
      true,
    ],
  ];

  for (const [name, change, anchorsAddition, readPresent] of cases) {
    const branch: BranchEntry[] = [
      systemEntry("s1", null, leading),
      userEntry("u1", "first", "s1"),
      systemEntry("s2", "u1", change),
      userEntry("u2", "second", "s2"),
    ];

    const ordinary = await realProviderPayload("codex", selectedModel, payloadMessages(branch));
    assert.equal(
      ordinary.input.some((item: any) => item.type === "additional_tools"),
      anchorsAddition,
      `${name}: additive changes are declared in place, non-additive ones at the top level`,
    );
    assert.equal(
      ordinary.tools?.some((tool: any) => tool.name === "read"),
      readPresent,
      `${name}: the current tool set reflects the change`,
    );

    const preparation = prepareCompactionReplay(branch, selectedModel);
    assert.equal(preparation.kind, "ready", name);
    if (preparation.kind !== "ready") continue;
    const input = preparation.buildInput();
    assert.deepEqual(
      input,
      [...stripProviderDeclarations("codex", ordinary.input), { type: "compaction_trigger" }],
      name,
    );
    assert.equal(
      input.some((item) => TOOL_DECLARATION_TYPES.has(String(item.type))),
      false,
      name,
    );
  }
});

test("a system message between a function call and its result is ordered like Pi, including missing results", async () => {
  const update: SystemMessage = {
    role: "system",
    content: "",
    sections: { late: "LATE SECTION" },
    timestamp: 2,
  };
  for (const withResult of [true, false]) {
    const leading: SystemMessage = {
      role: "system",
      content: "BASE PROMPT",
      timestamp: 1,
    };
    const branch: BranchEntry[] = [
      systemEntry("s1", null, leading),
      userEntry("u1", "first", "s1"),
      toolCallAssistantEntry("a1", "u1"),
      systemEntry("s2", "a1", update),
      ...(withResult ? [toolResultEntry("t1", "s2")] : []),
      userEntry("u2", "second", withResult ? "t1" : "s2"),
    ];

    const ordinary = await realProviderPayload(
      "codex",
      withMidConvo("codex", true),
      payloadMessages(branch),
    );
    const preparation = prepareCompactionReplay(branch, withMidConvo("codex", true));
    assert.equal(preparation.kind, "ready", `withResult=${withResult}`);
    if (preparation.kind !== "ready") continue;
    assert.deepEqual(
      preparation.buildInput(),
      [...stripProviderDeclarations("codex", ordinary.input), { type: "compaction_trigger" }],
      `withResult=${withResult}`,
    );
    if (!withResult) {
      assert.equal(JSON.stringify(preparation.buildInput()).includes("No result provided"), true);
    }
  }
});

// ---------------------------------------------------------------------------
// Native replay against the real provider payload
// ---------------------------------------------------------------------------

for (const kind of ["direct", "codex"] as const) {
  for (const midConvo of [false, true]) {
    test(`native replay replaces exactly the checkpoint span in the real ${kind} payload (mid-convo=${midConvo})`, async () => {
      const selectedModel = withMidConvo(kind, midConvo);
      const branch = replayBranch(selectedModel, "after checkpoint");
      const payload = await realProviderPayload(kind, selectedModel, payloadMessages(branch));
      const markerIndex = indexOfMarker(payload.input);
      assert.ok(markerIndex >= 0, "the real payload must contain the checkpoint marker");

      const preparation = prepareNativeReplay(branch, selectedModel);
      assert.equal(preparation.kind, "compatible");
      if (preparation.kind !== "compatible") return;

      const rewrite = preparation.rewrite(payload);
      assert.equal(rewrite.kind, "patched", JSON.stringify(rewrite));
      if (rewrite.kind !== "patched") return;

      const patchedInput = rewrite.payload.input as unknown[];
      // The span is the marker item plus the single retained user entry.
      assert.deepEqual(patchedInput, [
        ...payload.input.slice(0, markerIndex),
        COMPACTION_ITEM,
        ...payload.input.slice(markerIndex + 2),
      ]);
      assert.equal(rewrite.payload.instructions, payload.instructions);
      assert.equal(rewrite.payload.model, payload.model);
      assert.equal(indexOfMarker(patchedInput), -1);
      assert.equal(
        patchedInput.filter(
          (item: any) => item.type === "compaction" && typeof item.encrypted_content === "string",
        ).length,
        1,
      );
    });
  }
}

test("native replay follows a reloaded SessionManager branch after navigation", async (t) => {
  const selectedModel = model("codex", { provider: "custom-codex", id: "gpt-future" });
  const snapshot: SystemMessage = {
    role: "system",
    content: "BASE PROMPT",
    sections: { env: "ENV SECTION" },
    timestamp: 10,
  };
  const initial = SessionManager.inMemory("/tmp", undefined, [
    userEntry("e1", "old"),
    userEntry("e2", "kept", "e1"),
    checkpointEntry("c1", "e2", "e2", (() => {
      const prepared = prepareCompactionReplay([userEntry("fresh", "old")], selectedModel);
      assert.equal(prepared.kind, "ready");
      if (prepared.kind !== "ready") throw new Error("not ready");
      return JSON.parse(JSON.stringify(prepared.createCheckpointDetails(COMPACTION_ITEM)));
    })(), snapshot),
  ] as never);
  const directory = mkdtempSync(join(process.cwd(), ".test-session-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "session.jsonl");
  writeFileSync(file, [initial.getHeader(), ...initial.getEntries()]
    .map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const session = SessionManager.open(file, directory);
  session.appendMessage({ role: "user", content: "branch one", timestamp: 7 });
  const firstBranch = session.getBranch() as unknown as BranchEntry[];
  const firstMessages = convertToLlm(session.buildSessionContext().messages) as Message[];

  const checkpointId = firstBranch.find((entry) => entry.type === "compaction")?.id;
  assert.ok(checkpointId);
  session.branch(checkpointId);
  session.appendMessage({ role: "user", content: "branch two", timestamp: 8 });
  const secondBranch = session.getBranch() as unknown as BranchEntry[];
  const secondMessages = convertToLlm(session.buildSessionContext().messages) as Message[];

  for (const [branch, messages, suffix, other] of [
    [firstBranch, firstMessages, "branch one", "branch two"],
    [secondBranch, secondMessages, "branch two", "branch one"],
  ] as const) {
    const repeated = prepareCompactionReplay(branch, model("direct", { id: "gpt-another" }));
    assert.equal(repeated.kind, "ready");
    if (repeated.kind === "ready") {
      assert.deepEqual(repeated.buildInput().slice(0, 2), [
        { role: "user", content: [{ type: "input_text", text: "old" }] }, COMPACTION_ITEM,
      ]);
      assert.deepEqual(repeated.buildInput().at(-1), { type: "compaction_trigger" });
    }
    const payload = await realProviderPayload("codex", selectedModel, messages);
    const preparation = prepareNativeReplay(branch, selectedModel);
    assert.equal(preparation.kind, "compatible", suffix);
    if (preparation.kind !== "compatible") continue;
    const rewrite = preparation.rewrite(payload);
    assert.equal(rewrite.kind, "patched", suffix);
    if (rewrite.kind !== "patched") continue;
    const patched = JSON.stringify(rewrite.payload.input);
    assert.equal(patched.includes(suffix), true, suffix);
    assert.equal(patched.includes(other), false, suffix);
  }
});

test("native replay reads a snapshot-less /1 checkpoint through the real provider payload", async () => {
  const selectedModel = withMidConvo("codex", false);
  const branch = snapshotlessBranch(selectedModel, {
    role: "system",
    content: "",
    sections: { added: "NEW SECTION" },
    timestamp: 3,
  });
  const payload = await realProviderPayload("codex", selectedModel, payloadMessages(branch));

  const preparation = prepareNativeReplay(branch, selectedModel);
  assert.equal(preparation.kind, "compatible");
  if (preparation.kind !== "compatible") return;

  const rewrite = preparation.rewrite(payload);
  assert.equal(rewrite.kind, "patched", JSON.stringify(rewrite));
  if (rewrite.kind !== "patched") return;
  assert.equal(JSON.stringify(rewrite.payload.input).includes("after"), true);

  const markerIndex = indexOfMarker(payload.input);
  const withoutMarker = {
    ...payload,
    input: payload.input.filter((_item: unknown, index: number) => index !== markerIndex),
  };
  assert.equal(preparation.rewrite(withoutMarker).kind, "span-missing-or-ambiguous");
});

function compactionHarness(kind: ApiKind, branch: BranchEntry[], selected = model(kind)) {
  const handlers: Record<string, (event: any, context: any) => any> = {};
  extension({ on(name: string, handler: any) { handlers[name] = handler; } } as any);
  const session = SessionManager.inMemory(process.cwd(), undefined, branch as never);
  const notifications: string[] = [];
  let aborts = 0;
  const context = { model: selected, sessionManager: session, hasUI: true,
    ui: { notify(message: string) { notifications.push(message); } },
    getSystemPrompt: () => "BASE", abort() { aborts++; },
    modelRegistry: { isUsingOAuth: () => false,
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "test-key" }; },
      async complete(actual: any, transcript: any, options: any) {
        return codexResponsesStream(actual, normalizeContext(transcript), { ...options, apiKey: fakeJwt() }).result();
      },
    },
  };
  return { handlers, context, session, notifications, aborts: () => aborts,
    compact(keepRecentTokens = 20_000) {
      const active = context.sessionManager.getBranch();
      return handlers.session_before_compact!({ branchEntries: active,
        preparation: { firstKeptEntryId: [...active].reverse().find(e => e.type === "message" && e.message.role === "user")!.id,
          tokensBefore: 123, settings: { keepRecentTokens } },
        signal: new AbortController().signal }, context);
    },
  };
}

function compactionResponse(item: Record<string, unknown> = COMPACTION_ITEM): Response {
  return new Response([
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item] } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

function requestBody(init?: RequestInit): Record<string, any> {
  let raw = init!.body;
  if (new Headers(init?.headers).get("content-encoding") === "zstd") raw = zlib.zstdDecompressSync(raw as Buffer);
  return JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as Buffer).toString());
}

test("successful compaction retains only model-visible original users before a new-format opaque item", async () => {
  for (const kind of ["direct", "codex"] as const) {
    const branch: BranchEntry[] = [userEntry("u0", "discarded by ordinary compaction"),
      userEntry("u1", "kept wording", "u0"),
      { type: "compaction", id: "ordinary", parentId: "u1", firstKeptEntryId: "u1", summary: "synthetic summary" },
      { type: "branch_summary", id: "bs", parentId: "ordinary", summary: "synthetic branch summary" },
      userEntry("u2", "new wording", "bs")];
    const requests: Record<string, any>[] = [];
    const network = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      requests.push(requestBody(init)); return compactionResponse();
    });
    try {
      const h = compactionHarness(kind, branch);
      for (const keepRecentTokens of [0, 99_999]) {
        const result = await h.compact(keepRecentTokens);
        assert.equal(result.compaction.details.nativeReplayCheckpoint.format, "native-replay-checkpoint/2");
        assert.deepEqual(result.compaction.details.nativeReplayCheckpoint.replacementHistory, [
          { role: "user", content: [{ type: "input_text", text: "kept wording" }] },
          { role: "user", content: [{ type: "input_text", text: "new wording" }] }, COMPACTION_ITEM,
        ]);
        assert.equal(result.compaction.details.nativeReplayCheckpoint.producer.compactionCompatibilityClass, null);
        assert.match(JSON.stringify(requests.at(-1)!.input), /synthetic summary/);
        assert.equal(JSON.stringify(requests.at(-1)!.input).includes("discarded by ordinary compaction"), false);
      }
    } finally { network.mock.restore(); }
  }
});

test("64K retention follows source-backed text and enabled-image boundary fixtures without fitting input", async () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/retained-user-history.json", import.meta.url), "utf8"));
  for (const fixture of fixtures.cases) {
    const newest = "n".repeat((64_000 - fixture.remainingTokens) * 4);
    const boundary = userEntry("boundary", "unused", "old");
    boundary.message = { role: "user", content: fixture.content, timestamp: 2 };
    const h = compactionHarness("direct", [userEntry("old", "never backfill me"), boundary,
      userEntry("new", newest, "boundary")], model("direct", { input: ["text", "image"], contextWindow: 1000 }));
    let sent: Record<string, any> | undefined;
    const network = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      sent = requestBody(init); return compactionResponse();
    });
    try {
      const result = await h.compact();
      const expected = [...(fixture.expected ? [{ role: "user", content: fixture.expected }] : []),
        { role: "user", content: [{ type: "input_text", text: newest }] }, COMPACTION_ITEM];
      assert.deepEqual(result.compaction.details.nativeReplayCheckpoint.replacementHistory, expected, fixture.name);
      assert.equal(JSON.stringify(sent!.input).includes("never backfill me"), true);
      assert.equal(sent!.input[1].content.length, fixture.content.length, "full boundary reaches compaction endpoint");
      assert.equal(JSON.stringify(sent!.input).includes("tokens truncated"), false);
      assert.equal(h.notifications.length, 0);
      const c = result.compaction;
      h.session.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
      const replay = await realProviderPayload("direct", h.context.model,
        convertToLlm(h.session.buildSessionContext().messages) as Message[], undefined,
        payload => h.handlers.before_provider_request!({ payload }, h.context));
      assert.equal(h.aborts(), 0, fixture.name);
      assert.deepEqual(replay.input.filter((i: any) => i.role === "user"), expected.slice(0, -1), fixture.name);
      assert.equal(indexOfMarker(replay.input), -1);
    } finally { network.mock.restore(); }
  }
});

test("multi-item checkpoints survive reload and branch navigation without resurrecting discarded history", async (t) => {
  const directory = mkdtempSync(join(process.cwd(), ".test-retention-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const kind of ["direct", "codex"] as const) {
    const newest = "n".repeat(256_000);
    const snapshot = { role: "system", content: "BASE", timestamp: 1 } as SystemMessage;
    const h = compactionHarness(kind, [systemEntry("s0", null, snapshot),
      userEntry("old", "must never resurrect", "s0"), userEntry("new", newest, "old")]);
    const sent: Record<string, any>[] = [];
    const item = (n: number) => ({ type: "compaction", encrypted_content: `opaque-${n}`, unknown: { n } });
    const network = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      sent.push(requestBody(init)); return compactionResponse(item(sent.length));
    });
    try {
      const first = (await h.compact()).compaction;
      const firstId = h.session.appendCompaction(first.summary, null, first.tokensBefore, first.details, true);
      h.session.appendMessage({ role: "user", content: "later", timestamp: 3 });
      const file = join(directory, `${kind}.jsonl`);
      writeFileSync(file, [h.session.getHeader(), ...h.session.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n");
      const reloaded = SessionManager.open(file, directory);
      h.context.sessionManager = reloaded;
      const replay = async () => {
        const original = await realProviderPayload(kind, h.context.model,
          convertToLlm(reloaded.buildSessionContext().messages) as Message[]);
        const result = h.handlers.before_provider_request!({ payload: original }, h.context);
        assert.equal(h.aborts(), 0, h.notifications.join("\n"));
        assert.equal(JSON.stringify(result.input).includes("must never resurrect"), false);
        assert.equal(result.input.filter((i: any) => i.type === "compaction").length, 1);
        return result;
      };
      const replayed = await replay();
      assert.deepEqual(replayed.input.filter((i: any) => i.role === "user"), [
        { role: "user", content: [{ type: "input_text", text: newest }] },
        { role: "user", content: [{ type: "input_text", text: "later" }] },
      ]);
      const second = (await h.compact()).compaction;
      assert.deepEqual(sent[1]!.input, [...first.details.nativeReplayCheckpoint.replacementHistory,
        { role: "user", content: [{ type: "input_text", text: "later" }] }, { type: "compaction_trigger" }]);
      const secondId = reloaded.appendCompaction(second.summary, second.firstKeptEntryId, second.tokensBefore, second.details, true);
      reloaded.appendMessage({ role: "user", content: "end", timestamp: 4 });
      assert.ok((await replay()).input.some((i: any) => i.encrypted_content === "opaque-2"));
      const third = (await h.compact()).compaction;
      assert.deepEqual(sent[2]!.input, [...second.details.nativeReplayCheckpoint.replacementHistory,
        { role: "user", content: [{ type: "input_text", text: "end" }] }, { type: "compaction_trigger" }]);
      assert.equal(third.details.nativeReplayCheckpoint.replacementHistory.filter((i: any) => i.type === "compaction").length, 1);
      assert.equal(JSON.stringify(sent[2]!.input).includes("opaque-1"), false);
      assert.equal(JSON.stringify(sent[2]!.input).includes("must never resurrect"), false);
      assert.deepEqual(h.handlers.cache_warming_decision!({}, h.context), { action: "stop" });
      reloaded.branch(firstId);
      assert.ok((await replay()).input.some((i: any) => i.encrypted_content === "opaque-1"));
      reloaded.branch(secondId);
      assert.ok((await replay()).input.some((i: any) => i.encrypted_content === "opaque-2"));
      // Pi's retain-none boundary is the compaction entry itself.
      reloaded.appendCompaction("ordinary summary", null, 1);
      assert.equal(h.handlers.cache_warming_decision!({}, h.context), undefined);
      const ordinary = await realProviderPayload(kind, h.context.model, convertToLlm(reloaded.buildSessionContext().messages) as Message[]);
      assert.equal(h.handlers.before_provider_request!({ payload: ordinary }, h.context), undefined);
    } finally { network.mock.restore(); }
  }
});

test("old checkpoint readers retain single-item integrity and new checkpoints validate retained kinds and ordering", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected dispatch"); });
  const selected = model("direct");
  const user = { role: "user", content: [{ type: "input_text", text: "retained explicit wording" }] };
  for (const format of ["native-replay-checkpoint/1", "native-replay-checkpoint/2"]) {
    for (const history of [[], [COMPACTION_ITEM, COMPACTION_ITEM], [COMPACTION_ITEM, user],
      [{ role: "assistant", content: [{ type: "output_text", text: "not eligible" }] }, COMPACTION_ITEM],
      [{ ...user, content: [{ type: "input_image", image_url: "invalid", detail: "auto" }] }, COMPACTION_ITEM],
      [{ type: "compaction_trigger" }, COMPACTION_ITEM],
      [{ ...user, content: [] }, COMPACTION_ITEM], [user, COMPACTION_ITEM]]) {
      if (format.endsWith("/2") && history.length === 2 && history[0] === user) continue;
      const details = checkpointDetails(selected);
      Object.assign(details.nativeReplayCheckpoint, { format, replacementHistory: history });
      const branch = [userEntry("u0", "raw old wording"),
        checkpointEntry("c1", "u0", "u0", details, { role: "system", content: "BASE", timestamp: 1 }),
        userEntry("u1", "after", "c1")];
      const h = compactionHarness("direct", branch);
      assert.deepEqual(await h.compact(), { cancel: true });
      assert.equal(h.handlers.before_provider_request!({ payload: { input: [] } }, h.context), undefined);
      assert.equal(h.aborts(), 1);
      assert.deepEqual(h.handlers.cache_warming_decision!({}, h.context), { action: "stop" });
    }
  }
  assert.equal(network.mock.callCount(), 0);
});

test("overflow keeps the full compactable input and cancels without retaining partial history", async () => {
  for (const kind of ["direct", "codex"] as const) {
    const call = toolCallAssistantEntry("a1", "u1");
    const result = toolResultEntry("t1", "a1");
    const output = "unmodified tool output ".repeat(20_000);
    result.message = { ...result.message as any, content: [{ type: "text", text: output }] };
    const h = compactionHarness(kind, [userEntry("u1", "old user wording"), call, result,
      userEntry("u2", "latest", "t1")], model(kind, { contextWindow: 100 }));
    let sent: Record<string, any> | undefined;
    const network = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      sent = requestBody(init);
      return new Response(JSON.stringify({ error: { error: { code: "context_length_exceeded", message: "full input too large" } } }), { status: 503 });
    });
    try {
      const before = JSON.stringify(h.session.getEntries());
      assert.deepEqual(await h.compact(), { cancel: true });
      assert.equal(network.mock.callCount(), 1);
      assert.equal(sent!.input.find((i: any) => i.type === "function_call_output").output, output);
      assert.equal(JSON.stringify(h.session.getEntries()), before);
      assert.match(h.notifications.at(-1)!, /full input too large/);
    } finally { network.mock.restore(); }
  }
});

test("snapshot-bearing /1 records upgrade naturally without backfill and snapshot-less records replay only", async () => {
  const selected = model("direct");
  const original = checkpointDetails(selected, "2911");
  const before = JSON.stringify(original);
  for (const hasSnapshot of [false, true]) {
    const branch = [userEntry("u0", "do not backfill this"),
      checkpointEntry("c1", "u0", "u0", original,
        hasSnapshot ? { role: "system", content: "BASE", timestamp: 1 } : undefined),
      userEntry("u1", "later", "c1")];
    const h = compactionHarness("direct", branch);
    const network = mock.method(globalThis, "fetch", async () => compactionResponse());
    try {
      const payload = await realProviderPayload("direct", selected, payloadMessages(branch));
      assert.ok(h.handlers.before_provider_request!({ payload }, h.context));
      const result = await h.compact();
      if (hasSnapshot) {
        assert.equal(result.compaction.details.nativeReplayCheckpoint.format, "native-replay-checkpoint/2");
        assert.deepEqual(result.compaction.details.nativeReplayCheckpoint.replacementHistory, [
          { role: "user", content: [{ type: "input_text", text: "later" }] }, COMPACTION_ITEM,
        ]);
        assert.equal(network.mock.callCount(), 1);
      } else {
        assert.deepEqual(result, { cancel: true });
        assert.equal(network.mock.callCount(), 0);
      }
      assert.equal(JSON.stringify(original), before, "old records are never rewritten");
    } finally { network.mock.restore(); }
  }
});

test("settled real Codex failures return to the hook retry owner and persist only complete results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const selected = model("codex");
  const branch = [userEntry("u1", "compact me")];
  const handlers: Record<string, (event: any, context: any) => any> = {};
  extension({ on(name: string, handler: any) { handlers[name] = handler; } } as any);
  const requests: string[] = [];
  let cancelled = 0;
  const item = { type: "compaction", encrypted_content: "", future_field: { preserved: true } };
  const network = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests.push(Buffer.from(init!.body as any).toString("base64"));
    const wire = requests.length === 1 ? "" : requests.length === 2 ? "data: {bad JSON}\n\n" : [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.done", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(new ReadableStream({
      start(controller) { if (wire) controller.enqueue(new TextEncoder().encode(wire)); },
      cancel() { cancelled++; },
    }));
  });
  try {
    const context = { model: selected, sessionManager: { getSessionId: () => "retry-test" },
      hasUI: true, ui: { notify(message: string) { assert.fail(message); } }, getSystemPrompt: () => "BASE",
      modelRegistry: { async complete(actual: any, transcript: any, options: any) {
        assert.equal(options.maxRetries, 0);
        return codexResponsesStream(actual, normalizeContext(transcript), { ...options, apiKey: fakeJwt() }).result();
      } },
    };
    const pending = handlers.session_before_compact!({ branchEntries: branch,
      preparation: { firstKeptEntryId: "u1", tokensBefore: 42 }, signal: new AbortController().signal }, context);
    await new Promise(setImmediate);
    assert.equal(requests.length, 1);
    t.mock.timers.tick(300_000);
    await new Promise(setImmediate);
    t.mock.timers.tick(1_000);
    await new Promise(setImmediate);
    assert.equal(requests.length, 2);
    t.mock.timers.tick(1_000);
    await new Promise(setImmediate);
    const result = await pending;
    assert.equal(requests.length, 3);
    assert.equal(new Set(requests).size, 1);
    assert.deepEqual(result.compaction.details.nativeReplayCheckpoint.replacementHistory, [
      { role: "user", content: [{ type: "input_text", text: "compact me" }] }, item,
    ]);
    assert.equal(result.compaction.usage.totalTokens, 12);
    assert.equal(cancelled, 3);
  } finally { network.mock.restore(); }
});

test("production hooks preserve custom Codex routing and credentials through real Pi compaction and replay", async () => {
  const selected = model("codex", { provider: "custom-codex", id: "gpt-future",
    baseUrl: "https://custom-codex.example/backend-api", headers: { "x-custom-route": "selected" } });
  const handlers: Record<string, (event: any, context: any) => any> = {};
  extension({ on(name: string, handler: any) { handlers[name] = handler; } } as any);
  const branch = [userEntry("u1", "compact me")];
  let sent: Record<string, any> | undefined;
  const credential = fakeJwt();
  const fetchMock = mock.method(globalThis, "fetch", async (url: any, init: any) => {
    assert.match(String(url), /^https:\/\/custom-codex.example\//);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${credential}`);
    assert.equal(headers.get("x-custom-route"), "selected");
    let raw = init.body;
    if (headers.get("content-encoding") === "zstd") raw = zlib.zstdDecompressSync(raw);
    sent = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString());
    return new Response([
      { type: "response.output_item.done", output_index: 0, item: COMPACTION_ITEM },
      { type: "response.completed", response: { status: "completed", output: [COMPACTION_ITEM] } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
  });
  const context = {
    model: selected, hasUI: true, ui: { notify(message: string) { assert.fail(message); } },
    getSystemPrompt: () => "BASE", abort() { assert.fail("unexpected abort"); },
    sessionManager: { getBranch: () => branch, getSessionId: () => "custom-session" },
    modelRegistry: { async complete(actual: Model<any>, transcript: any, options: any) {
      assert.equal(actual, selected);
      return codexResponsesStream(actual, normalizeContext(transcript), { ...options, apiKey: credential }).result();
    } },
  };
  try {
    const result = await handlers.session_before_compact!({ branchEntries: branch,
      preparation: { firstKeptEntryId: "u1", tokensBefore: 42 }, signal: new AbortController().signal }, context);
    assert.ok(result.compaction);
    assert.equal(sent?.model, "gpt-future");
    assert.deepEqual(sent?.input.at(-1), { type: "compaction_trigger" });
    assert.equal(sent?.input.filter((item: any) => item.type === "compaction_trigger").length, 1);
    assert.equal(sent?.tools, undefined);
    assert.deepEqual(result.compaction.details.nativeReplayCheckpoint.producer, {
      modelKey: { provider: "custom-codex", api: "openai-codex-responses", id: "gpt-future" },
      compactionCompatibilityClass: null,
    });
    branch.push(checkpointEntry("c1", "u1", "u1", result.compaction.details,
      { role: "system", content: "BASE", timestamp: 1 }));
    branch.push(userEntry("u2", "continue", "c1"));
  } finally { fetchMock.mock.restore(); }
  for (const kind of ["direct", "codex"] as const) {
    const target = model(kind, { provider: `custom-${kind}`, id: "gpt-another" });
    const payload = await realProviderPayload(kind, target, payloadMessages(branch), undefined,
      payload => handlers.before_provider_request!({ payload }, { ...context, model: target }));
    assert.ok(payload.input.some((item: any) => item.encrypted_content === "opaque-item"));
    assert.equal(indexOfMarker(payload.input), -1);
  }
});

test("an ordinary provider rejection surfaces without stripping the replay item or retrying", async () => {
  const selected = model("direct", { id: "gpt-future" });
  const branch = replayBranch(model("codex", { provider: "custom-codex", id: "gpt-5.5" }), "continue");
  const handlers: Record<string, (event: any, context: any) => any> = {};
  extension({ on(name: string, handler: any) { handlers[name] = handler; } } as any);
  let requests = 0;
  const result = await directResponsesStream(selected, normalizeContext({ messages: payloadMessages(branch) }), {
    apiKey: "sk-fake", maxRetries: 0,
    onPayload: payload => handlers.before_provider_request!({ payload }, {
      model: selected, sessionManager: { getBranch: () => branch },
      hasUI: true, ui: { notify(message: string) { assert.fail(message); } },
      abort() { assert.fail("unexpected local abort"); },
    }),
    fetch: async (_url, init) => {
      requests++;
      const payload = JSON.parse(String(init?.body));
      assert.ok(payload.input.some((item: any) => item.encrypted_content === "opaque-item"));
      return new Response(JSON.stringify({ error: { message: "rejected compaction item" } }),
        { status: 400, headers: { "content-type": "application/json" } });
    },
  }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /rejected compaction item/);
  assert.equal(requests, 1);
});

test("installed replay hooks use current declarations for retained historical tool spans", async () => {
  const grammar = {
    name: "grammar", description: "grammar tool",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } },
  };
  const fn = { ...grammar, constrainedSampling: false };
  for (const kind of ["direct", "codex"] as const) {
    for (const mid of [false, true]) {
      for (const inverse of [false, true]) {
        for (const retainCall of [false, true]) {
          const selected = model(kind, { compat: {
            supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: mid,
          } });
          const snapshot = { role: "system", content: "BASE", timestamp: 1,
            toolsAdded: [inverse ? fn : grammar] } as SystemMessage;
          const call = assistantEntry("a1", "s1", {
            provider: selected.provider, api: selected.api, model: selected.id,
            content: [{ type: "toolCall", id: "call_1|ctc_1", name: "grammar", arguments: { code: "hello" } }],
          });
          const result = toolResultEntry("t1", "a1");
          result.message = { ...result.message as any, toolCallId: "call_1|ctc_1", toolName: "grammar" };
          const branch = [systemEntry("s1", null, snapshot), call, result,
            checkpointEntry("c1", "t1", retainCall ? "a1" : "t1", checkpointDetails(selected), snapshot),
            systemEntry("s2", "c1", { role: "system", content: "UPDATED", timestamp: 2,
              toolsAdded: [inverse ? grammar : fn] } as SystemMessage),
            userEntry("u2", "later user context", "s2"),
          ];
          const session = SessionManager.inMemory(process.cwd(), undefined, branch as never);
          const messages = convertToLlm(session.buildSessionContext().messages) as Message[];
          const original = await realProviderPayload(kind, selected, messages);
          const marker = indexOfMarker(original.input);
          assert.ok(marker >= 0);
          assert.ok(original.input.some((item: any) => item.type === (inverse ? "custom_tool_call_output" : "function_call_output")));
          const handlers: Record<string, (event: any, context: any) => any> = {};
          extension({ on(name: string, handler: any) { handlers[name] = handler; } } as any);
          let aborts = 0;
          const context = { model: selected, sessionManager: session, hasUI: true,
            ui: { notify() {} }, abort() { aborts++; } };
          const payload = await realProviderPayload(kind, selected, messages, undefined,
            payload => handlers.before_provider_request!({ payload }, context));
          assert.equal(aborts, 0, `${kind} mid=${mid} inverse=${inverse} retainCall=${retainCall}`);
          assert.deepEqual(payload.input, [
            ...original.input.slice(0, marker), COMPACTION_ITEM,
            ...original.input.slice(marker + (retainCall ? 3 : 2)),
          ]);
          assert.match(JSON.stringify(payload.input), /later user context/);
          for (const input of [original.input.filter((_: unknown, i: number) => i !== marker),
            [...original.input, ...original.input]]) {
            assert.equal(handlers.before_provider_request!({ payload: { ...original, input } }, context), undefined);
          }
          assert.equal(aborts, 2, "missing and ambiguous spans remain fail-closed");
        }
      }
    }
  }
});

// Keep this provider-boundary regression: function-only fixtures cannot detect
// custom wire types, and a retained result need not retain its originating call.
test("compaction and native replay preserve grammar-tool wire types", async () => {
  const grammarTool = {
    name: "grammar",
    description: "grammar tool",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } },
  };
  for (const kind of ["direct", "codex"] as const) {
    for (const { grammar, retainCall } of [
      { grammar: false, retainCall: true },
      { grammar: true, retainCall: true },
      { grammar: true, retainCall: false },
    ]) {
      const selected = model(kind, { compat: { supportsOpenAIGrammarTools: grammar } });
      const call = assistantEntry("a1", "s1", {
        provider: selected.provider, api: selected.api, model: selected.id,
        content: [{ type: "toolCall", id: "call_1|ctc_item_1", name: "grammar", arguments: { code: "hello" } }],
      });
      const result = toolResultEntry("t1", "a1");
      result.message = { ...result.message as any, toolCallId: "call_1|ctc_item_1", toolName: "grammar" };
      const snapshot = { role: "system", content: "BASE", timestamp: 1, toolsAdded: [grammarTool] } as SystemMessage;
      const before = [systemEntry("s1", null, snapshot), call, result];
      const ordinary = await realProviderPayload(kind, selected, payloadMessages(before));
      // On repeated compaction, only the checkpoint snapshot declares the tool.
      // The checkpoint and retained user precede the new call/result suffix.
      for (const update of retainCall ? [undefined, { ...grammarTool, constrainedSampling: false }] : []) {
        const repeated = [
          systemEntry("s0", null, snapshot),
          userEntry("u0", "before", "s0"),
          checkpointEntry("c0", "u0", "u0", checkpointDetails(selected), snapshot),
          ...(update ? [systemEntry("s2", "c0", {
            role: "system", content: "", timestamp: 2, toolsAdded: [update],
          } as SystemMessage)] : []),
          { ...call, parentId: update ? "s2" : "c0" }, result,
        ];
        const fullPayload = await realProviderPayload(kind, selected, payloadMessages(repeated));
        const repeatedPreparation = prepareCompactionReplay(repeated, selected);
        assert.equal(repeatedPreparation.kind, "ready");
        if (repeatedPreparation.kind !== "ready") continue;
        const toolItems = (items: readonly any[]) => items.filter((item) => item.call_id === "call_1");
        assert.deepEqual(
          repeatedPreparation.buildInput(),
          [COMPACTION_ITEM, ...toolItems(fullPayload.input), { type: "compaction_trigger" }],
          `${kind} repeated grammar=${grammar} redefined=${Boolean(update)}`,
        );
      }
      const compaction = prepareCompactionReplay(before, selected);
      assert.equal(compaction.kind, "ready");
      if (compaction.kind !== "ready") continue;
      assert.deepEqual(compaction.buildInput(), [
        ...stripProviderDeclarations(kind, ordinary.input), { type: "compaction_trigger" },
      ]);
      const branch = [
        ...before,
        checkpointEntry("c1", "t1", retainCall ? "a1" : "t1", checkpointDetails(selected), snapshot),
        userEntry("u2", "continue", "c1"),
      ];
      const payload = await realProviderPayload(kind, selected, payloadMessages(branch));
      assert.equal(payload.input.some((item: any) => item.type === (grammar ? "custom_tool_call" : "function_call")), retainCall);
      assert.ok(payload.input.some((item: any) => item.type === (grammar ? "custom_tool_call_output" : "function_call_output")));
      const preparation = prepareNativeReplay(branch, selected);
      assert.equal(preparation.kind, "compatible");
      if (preparation.kind !== "compatible") continue;
      const rewrite = preparation.rewrite(payload);
      assert.equal(rewrite.kind, "patched", `${kind} grammar=${grammar} retainCall=${retainCall}`);
      if (rewrite.kind !== "patched") continue;
      const markerIndex = indexOfMarker(payload.input);
      assert.deepEqual(rewrite.payload.input, [
        ...payload.input.slice(0, markerIndex), COMPACTION_ITEM,
        ...payload.input.slice(markerIndex + (retainCall ? 3 : 2)),
      ]);
    }
  }
});
