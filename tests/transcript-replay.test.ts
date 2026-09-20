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
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
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
// Pi 0.86 public-behavior oracle
//
// These helpers drive Pi's real Responses providers with a mocked fetch. The
// captured body is what Pi would send on the wire, so replay alignment is
// checked against the provider payload rather than the extension's projection.
// ---------------------------------------------------------------------------

type ApiKind = "direct" | "codex";

const COMPACTION_ITEM = { type: "compaction", encrypted_content: "opaque-item" } as const;
const READ_TOOL = {
  name: "read",
  description: "read tool",
  parameters: { type: "object", properties: {} },
};

const SYSTEM_BASE: SystemMessage = {
  role: "system",
  content: "BASE PROMPT",
  sections: { env: "ENV SECTION", style: "STYLE SECTION" },
  toolsAdded: [READ_TOOL],
  timestamp: 1,
};

const SYSTEM_UPDATE: SystemMessage = {
  role: "system",
  content: "MID INSTRUCTIONS",
  sections: { style: null, extra: "EXTRA SECTION" },
  timestamp: 2,
};

const COLLAPSED_PROMPT = "BASE PROMPT\n\nMID INSTRUCTIONS\n\nENV SECTION\n\nEXTRA SECTION";
const MID_CONVO_LEADING = "BASE PROMPT\n\nENV SECTION\n\nSTYLE SECTION";
const MID_CONVO_UPDATE =
  'MID INSTRUCTIONS\n\nRemoved system prompt section "style".\n\nUpdated system prompt section "extra":\n\nEXTRA SECTION';

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
): Promise<Record<string, any>> {
  const transcript = normalizeContext({ messages: [...messages] });
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

function payloadMessages(branch: BranchEntry[], leafId?: string): Message[] {
  return convertToLlm(buildSessionContext(branch as never, leafId as never).messages) as Message[];
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

// ---------------------------------------------------------------------------
// Oracle characterization
// ---------------------------------------------------------------------------

test("Pi 0.86 places effective instructions per API contract and system-message capability", async () => {
  const transcriptMessages = convertToLlm([
    SYSTEM_BASE,
    SYSTEM_UPDATE,
    { role: "user", content: "hello", timestamp: 3 },
    assistantEntry("a1", "u1").message as never,
  ]) as Message[];

  const directCollapse = await realProviderPayload(
    "direct",
    withMidConvo("direct", false),
    transcriptMessages,
  );
  assert.equal(directCollapse.instructions, undefined);
  assert.deepEqual(directCollapse.input[0], { role: "developer", content: COLLAPSED_PROMPT });
  assert.equal(directCollapse.input.filter((item: any) => item.role === "developer").length, 1);
  assert.equal(directCollapse.tools?.[0]?.name, "read");

  const directMid = await realProviderPayload(
    "direct",
    withMidConvo("direct", true),
    transcriptMessages,
  );
  assert.equal(directMid.instructions, undefined);
  assert.deepEqual(directMid.input[0], { role: "developer", content: MID_CONVO_LEADING });
  assert.deepEqual(directMid.input[1], { role: "developer", content: MID_CONVO_UPDATE });

  const codexCollapse = await realProviderPayload(
    "codex",
    withMidConvo("codex", false),
    transcriptMessages,
  );
  assert.equal(codexCollapse.instructions, COLLAPSED_PROMPT);
  assert.equal(
    codexCollapse.input.some((item: any) => item.role === "developer"),
    false,
  );

  const codexMid = await realProviderPayload(
    "codex",
    withMidConvo("codex", true),
    transcriptMessages,
  );
  assert.equal(codexMid.instructions, MID_CONVO_LEADING);
  assert.deepEqual(codexMid.input[0], { role: "developer", content: MID_CONVO_UPDATE });
});

// ---------------------------------------------------------------------------
// Replay alignment against the real provider payload
// ---------------------------------------------------------------------------

for (const kind of ["direct", "codex"] as const) {
  for (const midConvo of [false, true]) {
    test(`native replay replaces exactly the checkpoint span in the real ${kind} payload (mid-convo=${midConvo})`, async () => {
      const selectedModel = withMidConvo(kind, midConvo);
      const snapshot: SystemMessage = {
        role: "system",
        content: "",
        sections: { env: "ENV SECTION" },
        toolsAdded: [READ_TOOL],
        timestamp: 10,
      };
      const branch: BranchEntry[] = [
        userEntry("e1", "discarded before first kept"),
        userEntry("e2", "retained before checkpoint", "e1"),
        checkpointEntry("c1", "e2", "e2", checkpointDetails(selectedModel), snapshot),
        userEntry("e3", "after checkpoint", "c1"),
      ];

      const payload = await realProviderPayload(kind, selectedModel, payloadMessages(branch));
      const markerIndex = indexOfMarker(payload.input);
      assert.ok(markerIndex >= 0, "the real payload must contain the checkpoint marker");
      // The span is the marker plus the single retained user entry.
      const retainedCount = 1;

      const preparation = prepareNativeReplay(branch, selectedModel, () => undefined);
      assert.equal(preparation.kind, "compatible");
      if (preparation.kind !== "compatible") return;

      const rewrite = preparation.rewrite(payload);
      assert.equal(rewrite.kind, "patched", JSON.stringify(rewrite));
      if (rewrite.kind !== "patched") return;

      const patchedInput = rewrite.payload.input as unknown[];
      const expected = [
        ...payload.input.slice(0, markerIndex),
        COMPACTION_ITEM,
        ...payload.input.slice(markerIndex + 1 + retainedCount),
      ];
      assert.deepEqual(patchedInput, expected);
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

test("native replay uses the active branch so resume and branch navigation keep the checkpoint suffix", async () => {
  const selectedModel = withMidConvo("codex", false);
  const snapshot: SystemMessage = {
    role: "system",
    content: "BASE PROMPT",
    timestamp: 10,
  };
  const checkpoint = checkpointEntry("c1", "e2", "e2", checkpointDetails(selectedModel), snapshot);

  for (const suffix of ["branch one after", "branch two after"]) {
    const branch: BranchEntry[] = [
      userEntry("e1", "old"),
      userEntry("e2", "kept", "e1"),
      checkpoint,
      userEntry("e3", suffix, "c1"),
    ];
    const payload = await realProviderPayload("codex", selectedModel, payloadMessages(branch));
    const preparation = prepareNativeReplay(branch, selectedModel, () => undefined);
    assert.equal(preparation.kind, "compatible");
    if (preparation.kind !== "compatible") continue;
    const rewrite = preparation.rewrite(payload);
    assert.equal(rewrite.kind, "patched");
    if (rewrite.kind !== "patched") continue;
    assert.equal(
      (rewrite.payload.input as unknown[]).some((item) => JSON.stringify(item).includes(suffix)),
      true,
    );
  }
});

test("native replay reads old checkpoints without a host snapshot and fails closed when the real span changes", async () => {
  const selectedModel = withMidConvo("codex", false);
  const branch: BranchEntry[] = [
    userEntry("e1", "old"),
    userEntry("e2", "retained", "e1"),
    checkpointEntry("c1", "e2", "e2", checkpointDetails(selectedModel)),
    userEntry("e3", "after", "c1"),
  ];
  const payload = await realProviderPayload("codex", selectedModel, payloadMessages(branch));

  const preparation = prepareNativeReplay(branch, selectedModel, () => undefined);
  assert.equal(preparation.kind, "compatible");
  if (preparation.kind !== "compatible") return;

  assert.equal(preparation.rewrite(payload).kind, "patched");

  const markerIndex = indexOfMarker(payload.input);
  const withoutMarker = {
    ...payload,
    input: payload.input.filter((_item: unknown, index: number) => index !== markerIndex),
  };
  assert.equal(preparation.rewrite(withoutMarker).kind, "span-missing-or-ambiguous");
});

test("old checkpoints without a host snapshot fall back to the live system prompt for repeated compaction", () => {
  const selectedModel = withMidConvo("direct", false);
  const branch: BranchEntry[] = [
    userEntry("e1", "old"),
    userEntry("e2", "retained", "e1"),
    checkpointEntry("c1", "e2", "e2", checkpointDetails(selectedModel)),
    userEntry("e3", "after", "c1"),
  ];
  assert.equal(
    compactionInstructions(branch, selectedModel, undefined, "recovered prompt"),
    "recovered prompt",
  );
});

test("native replay matches when the host drops system messages among retained entries", async () => {
  const selectedModel = withMidConvo("direct", false);
  const snapshot: SystemMessage = {
    role: "system",
    content: "BASE PROMPT",
    sections: { env: "ENV SECTION" },
    timestamp: 10,
  };
  const retainedSystem: SystemMessage = {
    role: "system",
    content: "",
    sections: { late: "LATE SECTION" },
    timestamp: 11,
  };
  const branch: BranchEntry[] = [
    userEntry("e1", "old"),
    userEntry("e2", "kept", "e1"),
    systemEntry("s2", "e2", retainedSystem),
    userEntry("e3", "kept two", "s2"),
    checkpointEntry("c1", "e3", "e2", checkpointDetails(selectedModel), snapshot),
    userEntry("e4", "after", "c1"),
  ];

  const payload = await realProviderPayload("direct", selectedModel, payloadMessages(branch));
  // The host omits the retained system message in favor of the checkpoint snapshot.
  assert.equal(JSON.stringify(payload.input).includes("LATE SECTION"), false);

  const preparation = prepareNativeReplay(branch, selectedModel, () => undefined);
  assert.equal(preparation.kind, "compatible");
  if (preparation.kind !== "compatible") return;
  assert.equal(preparation.rewrite(payload).kind, "patched");
});

test("Remote compaction never emits tool declaration items inherited from ordinary projection", async () => {
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
  const toolUpdate: SystemMessage = {
    role: "system",
    content: "",
    toolsAdded: [
      { name: "grep", description: "grep tool", parameters: { type: "object", properties: {} } },
    ],
    timestamp: 2,
  };
  const branch: BranchEntry[] = [
    systemEntry("s1", null, leading),
    userEntry("u1", "first", "s1"),
    systemEntry("s2", "u1", toolUpdate),
    userEntry("u2", "second", "s2"),
  ];

  const payload = await realProviderPayload("codex", selectedModel, payloadMessages(branch));
  assert.equal(
    payload.input.some((item: any) => item.type === "additional_tools"),
    true,
    "the ordinary provider projection declares added tools",
  );

  const preparation = prepareCompactionReplay(branch, selectedModel, () => "2911");
  assert.equal(preparation.kind, "ready");
  if (preparation.kind !== "ready") return;
  const input = preparation.buildInput();
  assert.equal(
    input.some((item) =>
      ["additional_tools", "tool_search_call", "tool_search_output"].includes(String(item.type)),
    ),
    false,
  );
});

test("system message text-array content is rendered like Pi and kept out of the leading input slot", async () => {
  const selectedModel = withMidConvo("direct", true);
  const leading: SystemMessage = {
    role: "system",
    content: [{ type: "text", text: "ARRAY BASE" }],
    sections: { env: "ENV SECTION" },
    timestamp: 1,
  };
  const update: SystemMessage = {
    role: "system",
    content: [{ type: "text", text: "ARRAY UPDATE" }],
    timestamp: 2,
  };
  const branch: BranchEntry[] = [
    systemEntry("s1", null, leading),
    userEntry("u1", "first", "s1"),
    systemEntry("s2", "u1", update),
    userEntry("u2", "second", "s2"),
  ];

  const payload = await realProviderPayload("direct", selectedModel, payloadMessages(branch));
  assert.deepEqual(payload.input[0], { role: "developer", content: "ARRAY BASE\n\nENV SECTION" });
  assert.deepEqual(payload.input[2], { role: "developer", content: "ARRAY UPDATE" });
  assert.equal(
    compactionInstructions(branch, selectedModel, undefined, ""),
    "ARRAY BASE\n\nENV SECTION",
  );

  const preparation = prepareCompactionReplay(branch, selectedModel, () => "2911");
  assert.equal(preparation.kind, "ready");
  if (preparation.kind !== "ready") return;
  const input = preparation.buildInput();
  assert.equal(JSON.stringify(input).includes("ARRAY UPDATE"), true);
  assert.equal(JSON.stringify(input).includes("ARRAY BASE"), false);
});

test("prompt-section replacement is rendered for collapse and mid-conversation", () => {
  const leading: SystemMessage = {
    role: "system",
    content: "BASE",
    sections: { env: "ENV OLD" },
    timestamp: 1,
  };
  const replacement: SystemMessage = {
    role: "system",
    content: "",
    sections: { env: "ENV NEW", added: "ADDED SECTION" },
    timestamp: 2,
  };
  const branch: BranchEntry[] = [
    systemEntry("s1", null, leading),
    systemEntry("s2", "s1", replacement),
    userEntry("u1", "question", "s2"),
  ];

  assert.equal(
    compactionInstructions(branch, withMidConvo("codex", false), undefined, ""),
    "BASE\n\nENV NEW\n\nADDED SECTION",
  );
  assert.equal(
    compactionInstructions(branch, withMidConvo("codex", true), undefined, ""),
    "BASE\n\nENV OLD",
  );

  const preparation = prepareCompactionReplay(branch, withMidConvo("codex", true), () => "2911");
  assert.equal(preparation.kind, "ready");
  if (preparation.kind !== "ready") return;
  const developer = preparation
    .buildInput()
    .find((item) => item.role === "developer" || item.role === "system");
  assert.deepEqual(developer, {
    role: "developer",
    content:
      'Updated system prompt section "env":\n\nENV NEW\n\nUpdated system prompt section "added":\n\nADDED SECTION',
  });
});

// ---------------------------------------------------------------------------
// Remote compaction input
// ---------------------------------------------------------------------------

function firstCompactionBranch(): BranchEntry[] {
  const leading: SystemMessage = {
    role: "system",
    content: "",
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

test("first Remote compaction preserves instructions, history and function calls without declarations", () => {
  for (const kind of ["direct", "codex"] as const) {
    for (const midConvo of [false, true]) {
      const selectedModel = withMidConvo(kind, midConvo);
      const branch = firstCompactionBranch();
      const preparation = prepareCompactionReplay(branch, selectedModel, () => "2911");
      assert.equal(preparation.kind, "ready");
      if (preparation.kind !== "ready") continue;

      const input = preparation.buildInput();
      assert.deepEqual(input.at(-1), { type: "compaction_trigger" });
      assert.equal(input.filter((item) => item.type === "compaction_trigger").length, 1);
      assert.equal(
        input.some((item) =>
          ["additional_tools", "tool_search_call", "tool_search_output"].includes(
            String(item.type),
          ),
        ),
        false,
      );
      assert.equal(
        input.some((item) => item.type === "function_call"),
        true,
      );
      assert.equal(
        input.some((item) => item.type === "function_call_output"),
        true,
      );
      const inputText = JSON.stringify(input);
      if (midConvo) {
        assert.equal(inputText.includes("MID INSTRUCTIONS"), true);
        assert.equal(
          inputText.includes("ENV SECTION"),
          false,
          "leading prompt must stay out of input",
        );
      } else {
        assert.equal(inputText.includes("MID INSTRUCTIONS"), false);
      }

      const instructions = compactionInstructions(branch, selectedModel, undefined, "");
      assert.equal(
        instructions,
        midConvo
          ? "ENV SECTION\n\nSTYLE SECTION"
          : "MID INSTRUCTIONS\n\nENV SECTION\n\nEXTRA SECTION",
      );
    }
  }
});

test("first Remote compaction appends custom instructions to the effective system prompt", () => {
  const selectedModel = withMidConvo("codex", true);
  const branch = firstCompactionBranch();
  assert.equal(
    compactionInstructions(branch, selectedModel, "  focus on the API  ", ""),
    "ENV SECTION\n\nSTYLE SECTION\n\nAdditional compaction instructions:\nfocus on the API",
  );
});

test("repeated Remote compaction keeps the replacement history plus the post-checkpoint suffix", () => {
  const selectedModel = withMidConvo("direct", true);
  const snapshot: SystemMessage = {
    role: "system",
    content: "BASE PROMPT",
    sections: { style: "STYLE SECTION" },
    timestamp: 10,
  };
  const update: SystemMessage = {
    role: "system",
    content: "",
    sections: { style: null, extra: "EXTRA SECTION" },
    timestamp: 11,
  };
  const branch: BranchEntry[] = [
    userEntry("e1", "old"),
    checkpointEntry("c1", "e1", "e1", checkpointDetails(selectedModel), snapshot),
    systemEntry("s2", "c1", update),
    userEntry("e2", "after checkpoint", "s2"),
  ];

  const preparation = prepareCompactionReplay(branch, selectedModel, () => "2911");
  assert.equal(preparation.kind, "ready");
  if (preparation.kind !== "ready") return;
  const input = preparation.buildInput();
  assert.deepEqual(input[0], COMPACTION_ITEM);
  assert.deepEqual(input.at(-1), { type: "compaction_trigger" });
  assert.equal(input.filter((item) => item.type === "compaction_trigger").length, 1);
  const developerItem = input.find((item) => item.role === "developer");
  assert.deepEqual(developerItem, {
    role: "developer",
    content:
      'Removed system prompt section "style".\n\nUpdated system prompt section "extra":\n\nEXTRA SECTION',
  });
  assert.equal(
    compactionInstructions(branch, selectedModel, undefined, ""),
    "BASE PROMPT\n\nSTYLE SECTION",
  );
});

test("repeated Remote compaction collapses updates for models without mid-conversation system messages", () => {
  const selectedModel = withMidConvo("codex", false);
  const snapshot: SystemMessage = {
    role: "system",
    content: "BASE PROMPT",
    sections: { style: "STYLE SECTION" },
    timestamp: 10,
  };
  const update: SystemMessage = {
    role: "system",
    content: "",
    sections: { style: null, extra: "EXTRA SECTION" },
    timestamp: 11,
  };
  const branch: BranchEntry[] = [
    userEntry("e1", "old"),
    checkpointEntry("c1", "e1", "e1", checkpointDetails(selectedModel), snapshot),
    systemEntry("s2", "c1", update),
    userEntry("e2", "after checkpoint", "s2"),
  ];

  const preparation = prepareCompactionReplay(branch, selectedModel, () => "2911");
  assert.equal(preparation.kind, "ready");
  if (preparation.kind !== "ready") return;
  const input = preparation.buildInput();
  assert.deepEqual(input[0], COMPACTION_ITEM);
  assert.equal(
    input.some((item) => item.role === "developer" || item.role === "system"),
    false,
  );
  assert.equal(
    compactionInstructions(branch, selectedModel, undefined, ""),
    "BASE PROMPT\n\nEXTRA SECTION",
  );
});
