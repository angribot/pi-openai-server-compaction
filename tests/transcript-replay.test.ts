import assert from "node:assert/strict";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { convertToLlm } from "@earendil-works/pi-agent-core";
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
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  compactionInstructions,
  NATIVE_REPLAY_CHECKPOINT_FORMAT,
  prepareCompactionReplay,
  prepareNativeReplay,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  type BranchEntry,
  type NativeReplayCheckpointDetails,
} from "../src/native-replay.ts";

// ---------------------------------------------------------------------------
// Pi 0.87 public-behavior oracle
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

  const options: Record<string, unknown> = { fetch: fetchMock };
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
      format: NATIVE_REPLAY_CHECKPOINT_FORMAT,
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

      const preparation = prepareCompactionReplay(branch, selectedModel, () => "2911");
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
      const preparation = prepareCompactionReplay(branch, selectedModel, () => "2911");
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

    const preparation = prepareCompactionReplay(branch, selectedModel, () => "2911");
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
    const preparation = prepareCompactionReplay(branch, withMidConvo("codex", true), () => "2911");
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

      const preparation = prepareNativeReplay(branch, selectedModel, () => undefined);
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

test("native replay follows a restored SessionManager branch after navigation", async () => {
  const selectedModel = withMidConvo("codex", false);
  const snapshot: SystemMessage = {
    role: "system",
    content: "BASE PROMPT",
    sections: { env: "ENV SECTION" },
    timestamp: 10,
  };
  const session = SessionManager.inMemory("/tmp", undefined, [
    userEntry("e1", "old"),
    userEntry("e2", "kept", "e1"),
    checkpointEntry("c1", "e2", "e2", checkpointDetails(selectedModel), snapshot),
  ] as never);
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
    const payload = await realProviderPayload("codex", selectedModel, messages);
    const preparation = prepareNativeReplay(branch, selectedModel, () => undefined);
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

  const preparation = prepareNativeReplay(branch, selectedModel, () => undefined);
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
