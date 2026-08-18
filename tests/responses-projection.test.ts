import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  projectActiveFunctionTools,
  projectCompactableContext,
  UnrepresentableCompactableContextError,
} from "../src/responses-projection.ts";

function model(input: Array<"text" | "image"> = ["text", "image"]): Model<any> {
  return {
    provider: "example-provider",
    api: "openai-responses",
    id: "gpt-test",
    name: "Projection test model",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
  };
}

const signedReasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "private reasoning summary" }],
  encrypted_content: "SIGNED",
};

function ordinarySequence(): AgentMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    {
      role: "assistant",
      provider: "example-provider",
      api: "openai-responses",
      model: "gpt-test",
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify(signedReasoning),
        },
        {
          type: "text",
          text: "I will inspect it.",
          textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
        },
        {
          type: "toolCall",
          id: "call_1|fc_1",
          name: "read",
          namespace: "filesystem",
          arguments: { path: "README.md" },
        },
      ],
      stopReason: "toolUse",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_1|fc_1",
      toolName: "read",
      content: [
        { type: "text", text: "file text" },
        { type: "image", data: "BBBB", mimeType: "image/jpeg" },
      ],
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      provider: "example-provider",
      api: "openai-responses",
      model: "gpt-test",
      content: [
        {
          type: "toolCall",
          id: "call_2|fc_2",
          name: "search",
          arguments: { query: "needle" },
        },
      ],
      stopReason: "toolUse",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 4,
    },
  ];
}

test("projects the supported ordinary Responses message subset", () => {
  assert.deepEqual(projectCompactableContext(ordinarySequence(), model()), [
    {
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        {
          type: "input_image",
          detail: "auto",
          image_url: "data:image/png;base64,AAAA",
        },
      ],
    },
    signedReasoning,
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I will inspect it.", annotations: [] }],
      status: "completed",
      id: "msg_1",
      phase: "commentary",
    },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "read",
      arguments: '{"path":"README.md"}',
      namespace: "filesystem",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [
        { type: "input_text", text: "file text" },
        {
          type: "input_image",
          detail: "auto",
          image_url: "data:image/jpeg;base64,BBBB",
        },
      ],
    },
    {
      type: "function_call",
      id: "fc_2",
      call_id: "call_2",
      name: "search",
      arguments: '{"query":"needle"}',
    },
    {
      type: "function_call_output",
      call_id: "call_2",
      output: "No result provided",
    },
  ]);
});

test("uses Pi's ordinary non-vision image placeholders", () => {
  const items = projectCompactableContext(ordinarySequence(), model(["text"]));
  assert.deepEqual(items[0], {
    role: "user",
    content: [
      { type: "input_text", text: "look" },
      {
        type: "input_text",
        text: "(image omitted: model does not support images)",
      },
    ],
  });
  assert.deepEqual(items[4], {
    type: "function_call_output",
    call_id: "call_1",
    output: "file text\n(tool image omitted: model does not support images)",
  });
});

test("projects Pi built-in custom messages after public normalization", () => {
  const messages: AgentMessage[] = [
    {
      role: "custom",
      customType: "note",
      content: "CUSTOM-VISIBLE",
      display: true,
      details: { hidden: "DISPLAY-ONLY" },
      timestamp: 1,
    },
    {
      role: "bashExecution",
      command: "printf output",
      output: "BASH-VISIBLE",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 2,
    },
    {
      role: "branchSummary",
      summary: "BRANCH-VISIBLE",
      fromId: "entry-1",
      timestamp: 3,
    },
    {
      role: "compactionSummary",
      summary: "COMPACTION-VISIBLE",
      tokensBefore: 123,
      timestamp: 4,
    },
  ];

  const serialized = JSON.stringify(projectCompactableContext(messages, model()));
  for (const text of ["CUSTOM-VISIBLE", "BASH-VISIBLE", "BRANCH-VISIBLE", "COMPACTION-VISIBLE"]) {
    assert.equal(serialized.match(new RegExp(text, "g"))?.length, 1);
  }
  assert.doesNotMatch(serialized, /DISPLAY-ONLY|customType|fromId|tokensBefore/);
});

test("projects only active ordinary function tools in active order", () => {
  const tools = [
    {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "search",
      description: "Search text",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ] as unknown as ToolInfo[];

  assert.deepEqual(projectActiveFunctionTools(tools, ["search"]), [
    {
      type: "function",
      name: "search",
      description: "Search text",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ]);
});

test("omits a foreign Responses item identity when the call has no item-id segment", () => {
  const target = model();
  target.provider = "openai";
  const messages: AgentMessage[] = [
    {
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-test",
      content: [
        {
          type: "toolCall",
          id: "foreign call",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
      stopReason: "toolUse",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "foreign call",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 2,
    },
  ];

  assert.deepEqual(projectCompactableContext(messages, target), [
    {
      type: "function_call",
      call_id: "foreign_call",
      name: "read",
      arguments: '{"path":"README.md"}',
    },
    {
      type: "function_call_output",
      call_id: "foreign_call",
      output: "result",
    },
  ]);
});

test("projection identity is deterministic", () => {
  const messages: AgentMessage[] = [
    {
      role: "assistant",
      provider: "example-provider",
      api: "openai-responses",
      model: "gpt-test",
      content: [{ type: "text", text: "unsigned" }],
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1,
    },
  ];

  const first = projectCompactableContext(messages, model());
  assert.deepEqual(projectCompactableContext(messages, model()), first);
  assert.equal(first[0]?.id, "msg_pi_0");
});

test("fails closed on unrepresentable model-visible context", () => {
  const cases: Array<[string, AgentMessage[]]> = [
    ["unknown role", [{ role: "futureRole", content: "visible" } as unknown as AgentMessage]],
    [
      "unknown user content",
      [
        {
          role: "user",
          content: [{ type: "audio", data: "AAAA" }],
          timestamp: 1,
        } as unknown as AgentMessage,
      ],
    ],
    [
      "orphan result",
      [
        {
          role: "toolResult",
          toolCallId: "orphan|fc_orphan",
          toolName: "read",
          content: [{ type: "text", text: "visible" }],
          isError: false,
          timestamp: 1,
        },
      ],
    ],
  ];

  for (const [name, messages] of cases) {
    assert.throws(
      () => projectCompactableContext(messages, model()),
      UnrepresentableCompactableContextError,
      name,
    );
  }
});
