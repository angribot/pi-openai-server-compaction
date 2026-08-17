import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localNodeModules = join(repoRoot, "node_modules");

function packagePathSegments(packageName: string): string[] {
  return packageName.split("/");
}

function npmGlobalRoot(): string | undefined {
  try {
    return execFileSync("npm", ["root", "-g"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function candidateRoots(): string[] {
  const roots = new Set<string>();
  roots.add(localNodeModules);

  const globalRoot = npmGlobalRoot();
  if (globalRoot) roots.add(globalRoot);

  const voltaPiRoot = join(
    homedir(),
    ".volta",
    "tools",
    "image",
    "packages",
    "@earendil-works",
    "pi-coding-agent",
    "lib",
    "node_modules",
  );
  roots.add(voltaPiRoot);
  roots.add(join(voltaPiRoot, "@earendil-works", "pi-coding-agent", "node_modules"));

  return [...roots];
}

function resolveInstalledPackageDir(packageName: string): string | undefined {
  const segments = packagePathSegments(packageName);
  for (const root of candidateRoots()) {
    const dir = join(root, ...segments);
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      return dir;
    }
  }
  return undefined;
}

function ensureLocalPeerLink(packageName: string): void {
  const localDir = join(localNodeModules, ...packagePathSegments(packageName));
  if (existsSync(join(localDir, "package.json"))) {
    return;
  }

  const targetDir = resolveInstalledPackageDir(packageName);
  if (!targetDir) {
    throw new Error(
      `Unable to locate peer dependency ${packageName}. Install Pi or add the package locally before running smoke.`,
    );
  }

  mkdirSync(dirname(localDir), { recursive: true });
  if (existsSync(localDir)) {
    const stat = lstatSync(localDir);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(localDir, { recursive: true, force: true });
    }
  }
  symlinkSync(targetDir, localDir, "dir");
}

for (const packageName of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
]) {
  ensureLocalPeerLink(packageName);
}

const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
const loaderResult = await discoverAndLoadExtensions(
  [join(repoRoot, "index.ts")],
  repoRoot,
  join(repoRoot, "tests", ".pi-agent-loader-smoke"),
);
assert.deepEqual(
  loaderResult.errors,
  [],
  "extension should load through Pi's production jiti resolver",
);
assert.equal(loaderResult.extensions.length, 1);

const { default: extensionFactory } = await import(pathToFileURL(join(repoRoot, "src", "index.ts")).href);
assert.equal(typeof extensionFactory, "function", "extension entrypoint should export a function");

const {
  budgetRemoteCompactionInput,
  buildRemoteCompactionHeaders,
  buildRemoteCompactionDetails,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  callRemoteCompactionEndpoint,
  CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
  estimateRemoteCompactionRequestTokens,
  extractRemoteCompactionDetails,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  remoteCompactionV2EndpointUrl,
  REMOTE_COMPACTION_CHECKPOINT_SUMMARY,
} = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
const {
  modelKey,
  supportsRemoteCompactionModel,
} = await import(pathToFileURL(join(repoRoot, "src", "openai.ts")).href);
const {
  clearAllRuntimeState,
  clearRemoteCompactionState,
  clearResponsesRequestShapeState,
  getRemoteCompactionState,
  getResponsesRequestShapeState,
  setRemoteCompactionState,
  setResponsesRequestShapeState,
} = await import(pathToFileURL(join(repoRoot, "src", "state.ts")).href);

const targetModelKey = "openai:openai-responses:gpt-5.4-nano:variant";
const reconstructed = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    {
      type: "compaction",
      id: "cmp-1",
      details: {
        remoteCompaction: {
          version: 1,
          provider: "openai-responses-compact",
          modelKey: targetModelKey,
          replacementHistory: [
            {
              type: "compaction",
              encrypted_content: "ENCRYPTED",
            },
          ],
        },
      },
    },
    {
      type: "message",
      id: "user-a1",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_ONE" }],
      },
    },
    {
      type: "message",
      id: "assistant-a1",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano:variant",
        content: [{ type: "text", text: "KEEP_REPLY_ONE" }],
      },
    },
    {
      type: "message",
      id: "user-b1",
      message: {
        role: "user",
        content: [{ type: "text", text: "DROP_ME" }],
      },
    },
    {
      type: "message",
      id: "assistant-b1",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-codex-responses",
        model: "gpt-5.4-nano:variant",
        content: [{ type: "text", text: "DROP_REPLY" }],
      },
    },
    {
      type: "message",
      id: "user-a2",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_TWO" }],
      },
    },
    {
      type: "message",
      id: "assistant-a2",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano:variant",
        content: [{ type: "text", text: "KEEP_REPLY_TWO" }],
      },
    },
  ],
});
assert.ok(reconstructed, "expected reconstructed remote compaction state");
const reconstructedJson = JSON.stringify(reconstructed.explicitHistory);
assert.match(reconstructedJson, /KEEP_ME_ONE/);
assert.match(reconstructedJson, /KEEP_REPLY_ONE/);
assert.match(reconstructedJson, /KEEP_ME_TWO/);
assert.match(reconstructedJson, /KEEP_REPLY_TWO/);
assert.doesNotMatch(reconstructedJson, /DROP_ME/);
assert.doesNotMatch(reconstructedJson, /DROP_REPLY/);

const requestBody = buildRemoteCompactionRequestBody({
  model: {
    id: "gpt-5.4-nano",
  },
  input: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
  instructions: "system",
  tools: [{ type: "function", name: "read" }],
  parallelToolCalls: true,
  reasoning: { effort: "high", summary: "auto" },
  text: { verbosity: "medium" },
});
assert.equal(requestBody.model, "gpt-5.4-nano");
assert.equal(requestBody.stream, true);
assert.equal(requestBody.store, false);
assert.equal(requestBody.tool_choice, "auto");
assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
assert.deepEqual(requestBody.input.at(-1), { type: "compaction_trigger" });
assert.deepEqual(requestBody.reasoning, { effort: "high", summary: "auto" });
assert.deepEqual(requestBody.text, { verbosity: "medium" });
assert.equal("service_tier" in requestBody, false);
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  }),
  "https://api.openai.com/v1/responses",
);
const proxyResponsesModel = {
  provider: "example-provider",
  api: "openai-responses",
  id: "gpt-5.4-nano",
  baseUrl: "https://proxy.example.com/v1",
};
assert.equal(supportsRemoteCompactionModel(proxyResponsesModel), true);
assert.equal(
  remoteCompactionV2EndpointUrl(proxyResponsesModel),
  "https://proxy.example.com/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl(proxyResponsesModel, "https://tenant.example.com/openai/v1/"),
  "https://tenant.example.com/openai/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl(proxyResponsesModel, undefined),
  "https://proxy.example.com/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl({
    ...proxyResponsesModel,
    baseUrl: "https://proxy.example.com/gateway",
  }),
  "https://proxy.example.com/gateway/responses",
);
assert.equal(
  supportsRemoteCompactionModel({
    provider: "openai-codex",
    api: "openai-codex-responses",
  }),
  false,
);
assert.throws(
  () => remoteCompactionV2EndpointUrl({
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  }),
  /requires an openai-responses model/,
);

const parsedV2Events = parseRemoteCompactionV2Events([
  {
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "V2_ENCRYPTED" },
  },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  },
]);
assert.equal(parsedV2Events.compactionItem.type, "compaction");
assert.throws(
  () => parseRemoteCompactionV2Events([
    { type: "response.completed", response: {} },
  ]),
  /expected exactly one compaction item, got 0/,
);
assert.throws(
  () => parseRemoteCompactionV2Events([
    { type: "response.output_item.done", item: { type: "compaction" } },
    { type: "response.completed", response: {} },
  ]),
  /invalid compaction item/,
);
assert.throws(
  () => parseRemoteCompactionV2Events([
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "FIRST" },
    },
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "SECOND" },
    },
    { type: "response.completed", response: {} },
  ]),
  /expected exactly one compaction item, got 2/,
);
assert.throws(
  () => parseRemoteCompactionV2Events([{
    type: "response.incomplete",
    response: { incomplete_details: { reason: "max_output_tokens" } },
  }]),
  /incomplete response: max_output_tokens/,
);
assert.throws(
  () => parseRemoteCompactionV2Events([{
    type: "response.failed",
    response: { error: { code: "context_length_exceeded", message: "too large" } },
  }]),
  /too large/,
);
assert.throws(
  () => parseRemoteCompactionV2Events([{
    type: "error",
    code: "insufficient_quota",
    message: "quota exhausted",
  }]),
  /quota exhausted/,
);
const v2History = buildRemoteCompactionV2History(
  [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retain user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "summarize assistant" }] },
  ],
  parsedV2Events.compactionItem,
);
assert.deepEqual(v2History.map((item: { type: string }) => item.type), ["message", "compaction"]);
assert.equal(v2History[0].role, "user");

const retainedBudgetHistory = buildRemoteCompactionV2History(
  [
    { type: "message", role: "user", content: [{ type: "input_text", text: "o".repeat(160_000) }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "n".repeat(160_000) }] },
  ],
  parsedV2Events.compactionItem,
);
assert.deepEqual(
  retainedBudgetHistory.map((item: { type: string }) => item.type),
  ["message", "message", "compaction"],
);
assert.equal(retainedBudgetHistory[0].content[0].text.length, 96_000);
assert.equal(retainedBudgetHistory[1].content[0].text.length, 160_000);

const retainedStringBudgetHistory = buildRemoteCompactionV2History(
  [{ type: "message", role: "user", content: "s".repeat(300_000) }],
  parsedV2Events.compactionItem,
);
assert.equal(retainedStringBudgetHistory[0].content.length, 256_000);

const retainedEmojiStringHistory = buildRemoteCompactionV2History(
  [{ type: "message", role: "user", content: "😀".repeat(300_000) }],
  parsedV2Events.compactionItem,
);
assert.ok(retainedEmojiStringHistory[0].content.length <= 256_000);
assert.doesNotMatch(
  retainedEmojiStringHistory[0].content,
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
);

const normalizedPromptItems = normalizeResponseItemsForPrompt(
  [
    { type: "ghost_snapshot", data: "hidden" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    },
    { type: "function_call", name: "read", call_id: "call-1", arguments: "{}" },
    { type: "function_call_output", call_id: "orphan", output: "drop" },
    { type: "image_generation_call", result: "base64" },
  ],
  { input: ["text"] },
);
assert.equal(normalizedPromptItems[0].type, "message");
assert.deepEqual(normalizedPromptItems[0].content, [
  { type: "input_text", text: "image content omitted because you do not support image input" },
]);
assert.deepEqual(normalizedPromptItems[2], {
  type: "function_call_output",
  call_id: "call-1",
  output: "No result provided",
});
assert.equal(normalizedPromptItems[3].result, "");
assert.doesNotMatch(JSON.stringify(normalizedPromptItems), /orphan|ghost_snapshot/);

const promptNormalizationModel = {
  provider: "example-provider",
  api: "openai-responses",
  id: "gpt-5.4-nano",
  name: "Budget test model",
  baseUrl: "https://proxy.example.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 300,
  maxTokens: 64,
};
const ordinaryBudgetInput = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "ordinary history" }] },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "ordinary reply" }],
  },
];
const ordinaryBudgetParams = {
  model: promptNormalizationModel,
  input: ordinaryBudgetInput,
  instructions: "system",
  tools: [],
  parallelToolCalls: true,
};
assert.equal(
  budgetRemoteCompactionInput(ordinaryBudgetParams),
  ordinaryBudgetInput,
  "in-budget remote-compaction history must not be rewritten",
);

const oversizedToolBudgetParams = {
  ...ordinaryBudgetParams,
  input: [
    ordinaryBudgetInput[0],
    { type: "function_call", name: "read", call_id: "budget-call", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "budget-call",
      output: `TOOL_OUTPUT_START${"x".repeat(4_000)}TOOL_OUTPUT_END`,
    },
    ordinaryBudgetInput[1],
  ],
};
const budgetedToolInput = budgetRemoteCompactionInput(oversizedToolBudgetParams);
assert.ok(
  estimateRemoteCompactionRequestTokens({
    ...oversizedToolBudgetParams,
    input: budgetedToolInput,
  }) <= promptNormalizationModel.contextWindow,
  "budgeted remote-compaction request must fit the selected model context window",
);
assert.deepEqual(
  budgetedToolInput.find((item: { type?: string }) => item.type === "function_call_output"),
  {
    type: "function_call_output",
    call_id: "budget-call",
    output: CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
  },
  "oversized tool output must be reduced before conversation messages are discarded",
);
assert.equal(budgetedToolInput.length, oversizedToolBudgetParams.input.length);
assert.deepEqual(budgetedToolInput[0], ordinaryBudgetInput[0]);
assert.deepEqual(budgetedToolInput.at(-1), ordinaryBudgetInput[1]);
assert.equal(
  budgetedToolInput.filter((item: { type?: string }) => item.type === "function_call").length,
  budgetedToolInput.filter((item: { type?: string }) => item.type === "function_call_output")
    .length,
  "budgeting must preserve call/output pairs",
);
assert.deepEqual(
  budgetRemoteCompactionInput({ ...oversizedToolBudgetParams, input: budgetedToolInput }),
  budgetedToolInput,
  "budgeting must remain stable when repeated",
);

const droppedPairBudgetInput = budgetRemoteCompactionInput({
  ...ordinaryBudgetParams,
  input: [
    {
      type: "function_call",
      name: "read",
      call_id: "oversized-arguments-call",
      arguments: JSON.stringify({ path: "a".repeat(4_000) }),
    },
    { type: "function_call_output", call_id: "oversized-arguments-call", output: "old result" },
    { type: "function_call", name: "read", call_id: "recent-call", arguments: "{}" },
    { type: "function_call_output", call_id: "recent-call", output: "recent result" },
    ordinaryBudgetInput[1],
  ],
});
assert.deepEqual(
  droppedPairBudgetInput
    .filter((item: { type?: string }) => item.type === "function_call")
    .map((item: { call_id?: string }) => item.call_id),
  ["recent-call"],
);
assert.deepEqual(
  droppedPairBudgetInput
    .filter((item: { type?: string }) => item.type === "function_call_output")
    .map((item: { call_id?: string }) => item.call_id),
  ["recent-call"],
  "discarding history must remove calls and outputs as a pair",
);

const syntheticPromptItems = normalizeResponseItemsForPrompt(
  [
    {
      type: "function_call",
      id: "fc-stable",
      name: "read",
      call_id: "stable-call",
      arguments: "{}",
    },
  ],
  { input: ["text"] },
);
assert.deepEqual(
  normalizeResponseItemsForPrompt(syntheticPromptItems, { input: ["text"] }),
  syntheticPromptItems,
  "synthetic outputs must remain stable across repeated prompt normalization",
);

const longMessageText = `MESSAGE_BEGIN_${"m".repeat(2_000)}_MESSAGE_END`;
const longMessageBudgetParams = {
  ...ordinaryBudgetParams,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: longMessageText }] },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "recent reply ".repeat(20) }],
    },
  ],
};
const budgetedMessageInput = budgetRemoteCompactionInput(longMessageBudgetParams);
const partiallyRetainedMessage = budgetedMessageInput.find(
  (item: { type?: string; role?: string }) => item.type === "message" && item.role === "user",
);
assert.ok(partiallyRetainedMessage, "the boundary message should be retained partially");
const partiallyRetainedText = partiallyRetainedMessage.content[0].text;
assert.match(partiallyRetainedText, /^MESSAGE_BEGIN_/);
assert.match(partiallyRetainedText, /_MESSAGE_END$/);
assert.match(partiallyRetainedText, /truncated/i);
assert.ok(
  estimateRemoteCompactionRequestTokens({
    ...longMessageBudgetParams,
    input: budgetedMessageInput,
  }) <= promptNormalizationModel.contextWindow,
);

const stringMessageBudgetParams = {
  ...ordinaryBudgetParams,
  input: [
    { type: "message", role: "user", content: `STRING_BEGIN_${"s".repeat(2_000)}_STRING_END` },
    ordinaryBudgetInput[1],
  ],
};
const budgetedStringMessage = budgetRemoteCompactionInput(stringMessageBudgetParams).find(
  (item: { type?: string; role?: string }) => item.type === "message" && item.role === "user",
);
assert.equal(typeof budgetedStringMessage?.content, "string");
assert.match(String(budgetedStringMessage?.content), /^STRING_BEGIN_/);
assert.match(String(budgetedStringMessage?.content), /_STRING_END$/);
assert.match(String(budgetedStringMessage?.content), /truncated/i);

const unicodeMessageBudgetParams = {
  ...ordinaryBudgetParams,
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `UNICODE_BEGIN_${"😀".repeat(1_000)}_UNICODE_END` }],
    },
    ordinaryBudgetInput[1],
  ],
};
const budgetedUnicodeInput = budgetRemoteCompactionInput(unicodeMessageBudgetParams);
const budgetedUnicodeMessage = budgetedUnicodeInput.find(
  (item: { type?: string; role?: string }) => item.type === "message" && item.role === "user",
);
const budgetedUnicodeText = budgetedUnicodeMessage?.content[0].text ?? "";
assert.match(budgetedUnicodeText, /^UNICODE_BEGIN_/);
assert.match(budgetedUnicodeText, /_UNICODE_END$/);
assert.doesNotMatch(
  budgetedUnicodeText,
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
  "message truncation must not split Unicode surrogate pairs",
);

const multimodalBudgetParams = {
  ...ordinaryBudgetParams,
  model: {
    ...promptNormalizationModel,
    input: ["text", "image"],
    contextWindow: 1_800,
  },
  input: [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `IMAGE_TEXT_BEGIN_${"b".repeat(3_000)}` },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        { type: "input_text", text: `${"e".repeat(3_000)}_IMAGE_TEXT_END` },
      ],
    },
    ordinaryBudgetInput[1],
  ],
};
const budgetedMultimodalInput = budgetRemoteCompactionInput(multimodalBudgetParams);
const budgetedMultimodalMessage = budgetedMultimodalInput.find(
  (item: { type?: string; role?: string }) => item.type === "message" && item.role === "user",
);
assert.deepEqual(
  budgetedMultimodalMessage?.content.map((part: { type?: string }) => part.type),
  ["input_text", "input_image", "input_text"],
  "message truncation must preserve multimodal content ordering",
);
assert.match(budgetedMultimodalMessage.content[0].text, /^IMAGE_TEXT_BEGIN_/);
assert.match(budgetedMultimodalMessage.content[0].text, /truncated/i);
assert.match(budgetedMultimodalMessage.content[2].text, /_IMAGE_TEXT_END$/);

const opaqueReplayInput = [
  { type: "compaction", encrypted_content: "c".repeat(4_000) },
  { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
];
const opaqueReplayParams = {
  ...ordinaryBudgetParams,
  model: { ...promptNormalizationModel, contextWindow: 800 },
  input: opaqueReplayInput,
};
assert.ok(
  estimateRemoteCompactionRequestTokens(opaqueReplayParams) <=
    opaqueReplayParams.model.contextWindow,
);
assert.equal(
  budgetRemoteCompactionInput(opaqueReplayParams),
  opaqueReplayInput,
  "opaque compaction items should use model-visible rather than encoded size estimates",
);

const foreignToolHistory = messagesToResponseItems(
  [
    {
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: "REDACTED",
          redacted: true,
        },
        { type: "text", text: "FOREIGN_TEXT\uD800" },
        {
          type: "toolCall",
          id: "call weird|foreign.item",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "call weird|foreign.item",
      toolName: "read",
      content: [{ type: "text", text: "FOREIGN\uD800_TOOL_RESULT" }],
      isError: false,
      timestamp: 2,
    },
  ],
  {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
    input: ["text"],
  },
);
const foreignToolCall = foreignToolHistory.find((item: { type?: string }) => (
  item.type === "function_call"
));
const foreignToolResult = foreignToolHistory.find((item: { type?: string }) => (
  item.type === "function_call_output"
));
assert.equal(foreignToolCall?.call_id, "call_weird");
assert.match(String(foreignToolCall?.id), /^fc_/);
assert.equal(foreignToolResult?.call_id, foreignToolCall?.call_id);
assert.equal(foreignToolResult?.output, "FOREIGN_TOOL_RESULT");
const foreignToolHistoryJson = JSON.stringify(foreignToolHistory);
assert.doesNotMatch(foreignToolHistoryJson, /Reasoning redacted|\\ud800/i);
assert.match(foreignToolHistoryJson, /FOREIGN_TEXT/);

const compactedHistory = processCompactedHistory([
  { type: "message", role: "developer", content: [{ type: "input_text", text: "drop developer" }] },
  { type: "message", role: "user", content: [] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
  { type: "function_call", name: "read", call_id: "call-2", arguments: "{}" },
  { type: "compaction", encrypted_content: "keep" },
]);
assert.deepEqual(
  compactedHistory.map((item: { type: string }) => item.type),
  ["message", "message", "compaction"],
);
assert.equal(compactedHistory[0].role, "user");
assert.equal(compactedHistory[1].role, "assistant");

const compactionHeaders = buildRemoteCompactionHeaders({
  model: {
    provider: "example-provider",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  apiKey: "sk-test",
  sessionId: "session-123",
  headers: { "x-extra": "yes" },
});
assert.equal(compactionHeaders.authorization, "Bearer sk-test");
assert.equal(compactionHeaders.session_id, "session-123");
assert.equal(compactionHeaders["x-codex-window-id"], "session-123:0");
assert.match(compactionHeaders["x-codex-installation-id"], /^[0-9a-f-]{36}$/);
assert.equal(compactionHeaders["x-extra"], "yes");
assert.equal(compactionHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal(compactionHeaders.accept, "text/event-stream");

const headerAuthenticatedCompactionHeaders = buildRemoteCompactionHeaders({
  model: proxyResponsesModel,
  headers: { Authorization: "Custom credential" },
});
assert.equal(headerAuthenticatedCompactionHeaders.Authorization, "Custom credential");
assert.equal("authorization" in headerAuthenticatedCompactionHeaders, false);

const configuredAuthorizationHeaders = buildRemoteCompactionHeaders({
  model: proxyResponsesModel,
  apiKey: "ignored-api-key",
  headers: { Authorization: "Custom credential" },
});
assert.equal(configuredAuthorizationHeaders.Authorization, "Custom credential");
assert.equal("authorization" in configuredAuthorizationHeaders, false);

const deletedAuthorizationHeaders = buildRemoteCompactionHeaders({
  model: proxyResponsesModel,
  apiKey: "must-not-be-used",
  headers: { Authorization: null },
});
assert.equal(
  Object.keys(deletedAuthorizationHeaders).some((name) => name.toLowerCase() === "authorization"),
  false,
  "a null ProviderHeaders value must delete API-key fallback authorization case-insensitively",
);
assert.equal(
  Object.values(deletedAuthorizationHeaders).includes("null"),
  false,
  "a null ProviderHeaders value must never be serialized as a header string",
);

const deletedTransportHeaders = buildRemoteCompactionHeaders({
  model: proxyResponsesModel,
  headers: {
    ACCEPT: null,
    "Content-Type": null,
    "X-CoDeX-BeTa-FeAtUrEs": null,
  },
});
for (const deletedName of ["accept", "content-type", "x-codex-beta-features"]) {
  assert.equal(
    Object.keys(deletedTransportHeaders).some((name) => name.toLowerCase() === deletedName),
    false,
    `null ProviderHeaders values must delete ${deletedName} case-insensitively`,
  );
}

const detailsRoundTrip = extractRemoteCompactionDetails({
  remoteCompaction: buildRemoteCompactionDetails(
    {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.4-nano",
    },
    [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
    {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  ),
});
assert.ok(detailsRoundTrip, "expected remote compaction details round trip");
assert.equal(detailsRoundTrip.usage?.cacheWrite, 40);
assert.equal(detailsRoundTrip.usage?.cost.total, 10);

const validLegacyDetails = extractRemoteCompactionDetails({
  remoteCompaction: {
    version: 1,
    provider: "openai-responses-compact",
    modelKey: "openai:openai-responses:legacy:model",
    replacementHistory: [{ type: "compaction_summary", encrypted_content: "LEGACY_ENCRYPTED" }],
  },
});
assert.equal(validLegacyDetails?.version, 1);
assert.equal(validLegacyDetails?.modelKey, "openai:openai-responses:legacy:model");

for (const [name, remoteCompaction] of [
  [
    "missing model key",
    {
      version: 2,
      provider: "openai-responses-compaction",
      replacementHistory: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
    },
  ],
  [
    "blank model key",
    {
      version: 2,
      provider: "openai-responses-compaction",
      modelKey: "   ",
      replacementHistory: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
    },
  ],
  [
    "missing replacement history",
    {
      version: 2,
      provider: "openai-responses-compaction",
      modelKey: targetModelKey,
    },
  ],
  [
    "empty replacement history",
    {
      version: 2,
      provider: "openai-responses-compaction",
      modelKey: targetModelKey,
      replacementHistory: [],
    },
  ],
  [
    "partially malformed replacement history",
    {
      version: 2,
      provider: "openai-responses-compaction",
      modelKey: targetModelKey,
      replacementHistory: [
        { type: "compaction", encrypted_content: "ENCRYPTED" },
        { malformed: true },
      ],
    },
  ],
  [
    "replacement history without a valid compaction item",
    {
      version: 2,
      provider: "openai-responses-compaction",
      modelKey: targetModelKey,
      replacementHistory: [
        { type: "message", role: "user", content: [] },
        { type: "compaction", encrypted_content: "" },
      ],
    },
  ],
] as const) {
  assert.equal(
    extractRemoteCompactionDetails({ remoteCompaction }),
    undefined,
    `${name} must fail closed`,
  );
}

type Hook = (...args: any[]) => any;

let currentThinkingLevel: unknown;
const handlers = new Map<string, Hook>();
const fakePi = {
  registerProvider() {
    assert.fail("remote compaction must not register or override providers");
  },
  on(name: string, handler: Hook) {
    handlers.set(name, handler);
  },
  getAllTools(): unknown[] {
    return [];
  },
  getActiveTools(): string[] {
    return [];
  },
  getThinkingLevel() {
    return currentThinkingLevel;
  },
};
extensionFactory(fakePi);

const beforeProviderRequest = handlers.get("before_provider_request")!;
assert.equal(typeof beforeProviderRequest, "function");
const sessionId = "provider-agnostic-session";
const injectedHistory = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] },
  { type: "compaction", encrypted_content: "OPAQUE" },
];
setRemoteCompactionState(sessionId, {
  compactionEntryId: "cmp-provider-agnostic",
  modelKey: modelKey(proxyResponsesModel),
  replacementHistory: injectedHistory,
  explicitHistory: injectedHistory,
});
const requestContext = {
  cwd: repoRoot,
  model: proxyResponsesModel,
  hasUI: false,
  ui: { notify() {} },
  sessionManager: {
    getSessionId() {
      return sessionId;
    },
  },
};
const patchedPayload = beforeProviderRequest(
  {
    payload: {
      model: "sampling-override-model",
      input: [{ type: "message", role: "user", content: "stale full history" }],
      instructions: "sampling override instructions",
      tools: [{ type: "function", name: "sampling_override" }],
      parallel_tool_calls: false,
      tool_choice: "none",
      stream: false,
      store: true,
      include: [],
      prompt_cache_key: "sampling-override-cache-key",
      messages: ["legacy"],
      previous_response_id: "resp_stale",
      context_management: [{ type: "compaction", compact_threshold: 1 }],
      temperature: 1.7,
      top_p: 0.1,
      unknown_provider_field: "must-not-forward",
      samplingParams: { service_tier: "flex", store: true },
      service_tier: "priority",
    },
  },
  requestContext,
);
assert.deepEqual(patchedPayload.input, injectedHistory);
assert.equal("messages" in patchedPayload, false);
assert.equal("previous_response_id" in patchedPayload, false);

const untouchedCodexPayload = beforeProviderRequest(
  { payload: { model: "gpt-5.4-nano", input: [] } },
  {
    ...requestContext,
    model: {
      provider: "openai-codex",
      api: "openai-codex-responses",
      id: "gpt-5.4-nano",
    },
  },
);
assert.equal(untouchedCodexPayload, undefined);
clearRemoteCompactionState(sessionId);

const lifecycleSessionId = "native-replay-lifecycle-session";
const lifecycleHistory = [
  { type: "compaction", encrypted_content: "LIFECYCLE_ENCRYPTED" },
];
const lifecycleState = {
  compactionEntryId: "lifecycle-compaction",
  modelKey: modelKey(proxyResponsesModel),
  replacementHistory: lifecycleHistory,
  explicitHistory: lifecycleHistory,
};
const lifecycleContext = (branchEntries: unknown[] = []) => ({
  ...requestContext,
  sessionManager: {
    getSessionId() {
      return lifecycleSessionId;
    },
    getBranch() {
      return branchEntries;
    },
  },
});
const persistedLifecycleBranch = (entryId: string, encryptedContent: string) => [{
  type: "compaction",
  id: entryId,
  details: {
    remoteCompaction: {
      version: 2,
      provider: "openai-responses-compaction",
      modelKey: modelKey(proxyResponsesModel),
      replacementHistory: [{ type: "compaction", encrypted_content: encryptedContent }],
    },
  },
}];

for (const eventName of [
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
]) {
  clearAllRuntimeState();
  setRemoteCompactionState(lifecycleSessionId, lifecycleState);
  setResponsesRequestShapeState(lifecycleSessionId, {
    modelKey: modelKey(proxyResponsesModel),
    updatedAt: 1,
    serviceTier: "priority",
  });

  await handlers.get(eventName)?.({}, lifecycleContext());

  assert.deepEqual(
    getRemoteCompactionState(lifecycleSessionId),
    lifecycleState,
    `${eventName} must not clear native replay before the action succeeds`,
  );
  assert.equal(
    getResponsesRequestShapeState(lifecycleSessionId)?.serviceTier,
    "priority",
    `${eventName} must not clear the observed request shape before the action succeeds`,
  );
  assert.deepEqual(
    beforeProviderRequest(
      { payload: { model: proxyResponsesModel.id, input: [] } },
      lifecycleContext(),
    )?.input,
    lifecycleHistory,
    `${eventName} must leave native replay active when another extension cancels the action`,
  );
}

const sessionShutdown = handlers.get("session_shutdown")!;
const sessionStart = handlers.get("session_start")!;
const sessionTree = handlers.get("session_tree")!;
const sessionCompact = handlers.get("session_compact")!;
assert.equal(typeof sessionShutdown, "function");
assert.equal(typeof sessionStart, "function");
assert.equal(typeof sessionTree, "function");
assert.equal(typeof sessionCompact, "function");

setRemoteCompactionState(lifecycleSessionId, lifecycleState);
setResponsesRequestShapeState(lifecycleSessionId, {
  modelKey: modelKey(proxyResponsesModel),
  updatedAt: 2,
  serviceTier: "priority",
});
await sessionShutdown();
assert.equal(getRemoteCompactionState(lifecycleSessionId), undefined);
assert.equal(getResponsesRequestShapeState(lifecycleSessionId), undefined);

await sessionStart({}, lifecycleContext(persistedLifecycleBranch("start-compaction", "START")));
assert.equal(
  getRemoteCompactionState(lifecycleSessionId)?.replacementHistory[0]?.encrypted_content,
  "START",
  "session start must rebuild native replay after a successful switch or fork",
);
assert.equal(getResponsesRequestShapeState(lifecycleSessionId), undefined);

setResponsesRequestShapeState(lifecycleSessionId, {
  modelKey: modelKey(proxyResponsesModel),
  updatedAt: 3,
  serviceTier: "priority",
});
await sessionTree({}, lifecycleContext());
assert.equal(
  getRemoteCompactionState(lifecycleSessionId),
  undefined,
  "successful tree navigation must clear native replay when the selected branch has no persisted details",
);
assert.equal(getResponsesRequestShapeState(lifecycleSessionId), undefined);

setResponsesRequestShapeState(lifecycleSessionId, {
  modelKey: modelKey(proxyResponsesModel),
  updatedAt: 4,
  serviceTier: "priority",
});
await sessionTree({}, lifecycleContext(persistedLifecycleBranch("tree-compaction", "TREE")));
assert.equal(
  getRemoteCompactionState(lifecycleSessionId)?.replacementHistory[0]?.encrypted_content,
  "TREE",
  "successful tree navigation must rebuild native replay from the selected branch",
);
assert.equal(
  getResponsesRequestShapeState(lifecycleSessionId),
  undefined,
  "successful tree navigation must clear the prior branch request shape",
);

await sessionCompact({}, lifecycleContext(persistedLifecycleBranch("new-compaction", "COMPACT")));
assert.equal(
  getRemoteCompactionState(lifecycleSessionId)?.replacementHistory[0]?.encrypted_content,
  "COMPACT",
  "successful compaction must rebuild native replay from the new compaction entry",
);
clearAllRuntimeState();
beforeProviderRequest(
  {
    payload: {
      model: proxyResponsesModel.id,
      input: [],
      service_tier: "priority",
      reasoning: { effort: "high", summary: "detailed" },
      text: {
        verbosity: "high",
        format: {
          type: "json_schema",
          name: "ordinary_response",
          schema: { type: "object" },
        },
      },
    },
  },
  requestContext,
);

const sessionBeforeCompact = handlers.get("session_before_compact")!;
assert.equal(typeof sessionBeforeCompact, "function");
const requestBodies: string[] = [];
const requestUrls: string[] = [];
const requestHeaders: Headers[] = [];
const originalFetch = globalThis.fetch;
try {
  let responsePlan: Array<Response | Error> = [];
  const sseResponse = (
    encryptedContent: string,
    completed = true,
    completedResponse: Record<string, unknown> = {
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  ) => new Response([
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: encryptedContent },
    })}\n\n`,
    ...(completed
      ? [`data: ${JSON.stringify({
          type: "response.completed",
          response: completedResponse,
        })}\n\n`]
      : []),
  ].join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const httpError = (status: number, message: string, code?: string) => new Response(
    JSON.stringify({ error: { message, ...(code ? { code } : {}) } }),
    { status, headers: { "content-type": "application/json" } },
  );

  const streamingResponse = (chunks: string[], keepOpen = false) => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!keepOpen) controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const pendingResponse = (status = 200) => new Response(new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  }), { status, headers: { "content-type": "text/event-stream" } });

  globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === "string"
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : "";
    requestBodies.push(body);
    requestUrls.push(input instanceof Request ? input.url : String(input));
    requestHeaders.push(new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ));
    const next = responsePlan.shift();
    if (next instanceof Error) throw next;
    assert.ok(next instanceof Response, "missing planned compaction response");
    return next;
  };

  const message = {
    role: "user",
    content: [{ type: "text", text: "retain this context" }],
    timestamp: Date.now(),
  };
  const compactEvent = {
    preparation: {
      firstKeptEntryId: "keep-after-remote-compaction",
      messagesToSummarize: [message],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
    },
    branchEntries: [{ type: "message", id: "message-1", message }],
    reason: "manual",
    customInstructions: "compact guidance",
    willRetry: false,
    signal: new AbortController().signal,
  };
  const notifications: Array<{ message: string; type?: string }> = [];
  const compactContext = {
    ...requestContext,
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
    model: {
      ...proxyResponsesModel,
      name: "Header-authenticated proxy",
      reasoning: true,
      thinkingLevelMap: { minimal: "low", max: "max" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return {
          ok: true,
          baseUrl: "https://tenant.example.com/openai/v1",
          headers: { Authorization: "Custom credential" },
        };
      },
    },
    getSystemPrompt() {
      return "system prompt";
    },
  };

  currentThinkingLevel = "minimal";
  responsePlan = [sseResponse("SUCCESS_ENCRYPTED")];
  const successResult = await sessionBeforeCompact(compactEvent, compactContext);
  assert.equal(requestBodies.length, 1);
  assert.equal(requestUrls[0], "https://tenant.example.com/openai/v1/responses");
  assert.equal(requestHeaders[0].get("authorization"), "Custom credential");
  assert.ok(requestBodies[0].includes("compaction_trigger"));
  assert.ok(requestBodies[0].includes("compact guidance"));
  const successfulRequestBody = JSON.parse(requestBodies[0]);
  assert.equal(successfulRequestBody.model, compactContext.model.id);
  assert.deepEqual(successfulRequestBody.input.at(-1), { type: "compaction_trigger" });
  assert.equal(
    successfulRequestBody.instructions,
    "system prompt\n\nAdditional user guidance for this compaction request:\ncompact guidance",
  );
  assert.deepEqual(successfulRequestBody.tools, []);
  assert.equal(successfulRequestBody.service_tier, "priority");
  assert.equal(successfulRequestBody.stream, true);
  assert.equal(successfulRequestBody.store, false);
  assert.equal(successfulRequestBody.tool_choice, "auto");
  assert.equal(successfulRequestBody.parallel_tool_calls, true);
  assert.deepEqual(successfulRequestBody.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(
    successfulRequestBody.reasoning,
    { effort: "high", summary: "detailed" },
    "observed ordinary-request reasoning must take precedence over fallback inference",
  );
  assert.deepEqual(successfulRequestBody.text, { verbosity: "high" });
  assert.equal(successfulRequestBody.prompt_cache_key, sessionId);
  for (const field of [
    "messages",
    "previous_response_id",
    "context_management",
    "temperature",
    "top_p",
    "unknown_provider_field",
    "samplingParams",
  ]) {
    assert.equal(
      field in successfulRequestBody,
      false,
      `${field} must not be copied into remote compaction requests`,
    );
  }
  assert.equal(successResult?.compaction?.summary, REMOTE_COMPACTION_CHECKPOINT_SUMMARY);
  assert.deepEqual(successResult?.compaction?.usage, {
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.equal(successResult?.compaction?.details?.remoteCompaction?.version, 2);
  assert.deepEqual(
    successResult?.compaction?.details?.remoteCompaction?.usage,
    successResult?.compaction?.usage,
    "persisted usage and Pi's standard compaction usage field must describe the same operation",
  );
  assert.equal(
    successResult?.compaction?.details?.remoteCompaction?.modelKey,
    modelKey(compactContext.model),
    "credential-resolved endpoints must not change persisted model identity",
  );

  requestBodies.length = 0;
  responsePlan = [sseResponse("OVERFLOW_RECOVERED")];
  const oversizedToolOutput = `OVERFLOW_OUTPUT_START${"z".repeat(8_000)}OVERFLOW_OUTPUT_END`;
  const overflowModel = { ...compactContext.model, contextWindow: 600 };
  const overflowResult = await callRemoteCompactionEndpoint({
    model: overflowModel,
    apiKey: "sk-test",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "read the oversized result" }],
      },
      {
        type: "function_call",
        id: "fc_overflow_call",
        call_id: "overflow-call",
        name: "read",
        arguments: JSON.stringify({ path: "large.log" }),
      },
      {
        type: "function_call_output",
        call_id: "overflow-call",
        output: oversizedToolOutput,
      },
    ],
    instructions: "system prompt",
    tools: [],
    parallelToolCalls: true,
  });
  assert.equal(overflowResult.output.at(-1)?.type, "compaction");
  const overflowRequestBody = JSON.parse(requestBodies[0]);
  assert.ok(
    Math.ceil(requestBodies[0].length / 4) <= overflowModel.contextWindow,
    "the complete overflow-recovery request should fit the selected context window",
  );
  assert.deepEqual(
    overflowRequestBody.input.find(
      (item: { type?: string }) => item.type === "function_call_output",
    ),
    {
      type: "function_call_output",
      call_id: "overflow-call",
      output: CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
    },
  );
  assert.equal(
    overflowRequestBody.input.filter((item: { type?: string }) => item.type === "function_call")
      .length,
    1,
  );
  assert.equal(
    overflowRequestBody.input.filter(
      (item: { type?: string }) => item.type === "function_call_output",
    ).length,
    1,
  );

  clearResponsesRequestShapeState(sessionId);
  requestBodies.length = 0;
  responsePlan = [sseResponse("MAPPED_MINIMAL_ENCRYPTED")];
  const mappedMinimalResult = await sessionBeforeCompact(compactEvent, compactContext);
  assert.equal(mappedMinimalResult?.compaction?.details?.remoteCompaction?.version, 2);
  assert.deepEqual(JSON.parse(requestBodies[0]).reasoning, {
    effort: "low",
    summary: "auto",
  });

  currentThinkingLevel = "max";
  requestBodies.length = 0;
  responsePlan = [sseResponse("MAX_REASONING_ENCRYPTED")];
  const maxReasoningResult = await sessionBeforeCompact(compactEvent, compactContext);
  assert.equal(maxReasoningResult?.compaction?.details?.remoteCompaction?.version, 2);
  assert.deepEqual(JSON.parse(requestBodies[0]).reasoning, {
    effort: "max",
    summary: "auto",
  });

  currentThinkingLevel = "off";
  requestBodies.length = 0;
  responsePlan = [sseResponse("OFF_REASONING_ENCRYPTED")];
  const offReasoningResult = await sessionBeforeCompact(compactEvent, compactContext);
  assert.equal(offReasoningResult?.compaction?.details?.remoteCompaction?.version, 2);
  assert.deepEqual(JSON.parse(requestBodies[0]).reasoning, { effort: "none" });
  currentThinkingLevel = "minimal";

  const meteredCost = { input: 2, output: 10, cacheRead: 1, cacheWrite: 3 };
  const meteredUsage = {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    output_tokens: 5,
  };
  const runMeteredCompaction = async (
    model: typeof compactContext.model,
    serviceTier: string,
    responseServiceTier?: string,
  ) => {
    setResponsesRequestShapeState(sessionId, {
      modelKey: modelKey(model),
      updatedAt: Date.now(),
      serviceTier,
    });
    requestBodies.length = 0;
    responsePlan = [sseResponse("METERED_USAGE_ENCRYPTED", true, {
      ...(responseServiceTier ? { service_tier: responseServiceTier } : {}),
      usage: meteredUsage,
    })];
    const result = await sessionBeforeCompact(compactEvent, {
      ...compactContext,
      model,
    });
    return result?.compaction?.usage;
  };

  const priorityUsage = await runMeteredCompaction(
    { ...compactContext.model, id: "gpt-5.5", cost: meteredCost },
    "priority",
  );
  assert.deepEqual(
    {
      input: priorityUsage?.input,
      output: priorityUsage?.output,
      cacheRead: priorityUsage?.cacheRead,
      cacheWrite: priorityUsage?.cacheWrite,
      totalTokens: priorityUsage?.totalTokens,
    },
    { input: 70, output: 5, cacheRead: 20, cacheWrite: 10, totalTokens: 105 },
  );
  assert.ok(
    Math.abs((priorityUsage?.cost.total ?? 0) - 0.0006) < 1e-12,
    "gpt-5.5 priority compaction usage must use Pi's 2.5x pricing adjustment",
  );

  const flexUsage = await runMeteredCompaction(
    { ...compactContext.model, cost: meteredCost },
    "flex",
    "flex",
  );
  assert.ok(
    Math.abs((flexUsage?.cost.total ?? 0) - 0.00012) < 1e-12,
    "flex compaction usage must use Pi's 0.5x pricing adjustment",
  );

  setResponsesRequestShapeState(sessionId, {
    modelKey: modelKey(compactContext.model),
    updatedAt: Date.now(),
    reasoning: { effort: "high", summary: "detailed" },
    text: { verbosity: "high" },
    serviceTier: "priority",
  });

  requestBodies.length = 0;
  responsePlan = [sseResponse("EFFECTIVE_CONTEXT_ENCRYPTED")];
  const effectiveContextResult = await sessionBeforeCompact(
    {
      ...compactEvent,
      branchEntries: [
        {
          type: "message",
          id: "old-user",
          parentId: null,
          timestamp: "2026-08-07T00:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "DROP_OLD_CONTEXT" }],
            timestamp: 1,
          },
        },
        {
          type: "message",
          id: "kept-user",
          parentId: "old-user",
          timestamp: "2026-08-07T00:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "KEEP_RETAINED_TAIL" }],
            timestamp: 2,
          },
        },
        {
          type: "branch_summary",
          id: "branch-summary",
          parentId: "kept-user",
          timestamp: "2026-08-07T00:00:02.000Z",
          fromId: "old-user",
          summary: "KEEP_BRANCH_SUMMARY",
        },
        {
          type: "custom_message",
          id: "custom-message",
          parentId: "branch-summary",
          timestamp: "2026-08-07T00:00:03.000Z",
          customType: "test-context",
          content: "KEEP_CUSTOM_CONTEXT",
          display: false,
        },
        {
          type: "message",
          id: "bash-execution",
          parentId: "custom-message",
          timestamp: "2026-08-07T00:00:04.000Z",
          message: {
            role: "bashExecution",
            command: "printf KEEP_SHELL_COMMAND",
            output: "KEEP_SHELL_OUTPUT",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: 3,
          },
        },
        {
          type: "compaction",
          id: "pi-compaction",
          parentId: "bash-execution",
          timestamp: "2026-08-07T00:00:05.000Z",
          summary: "KEEP_PI_COMPACTION_SUMMARY",
          firstKeptEntryId: "kept-user",
          tokensBefore: 1234,
        },
        {
          type: "message",
          id: "post-compaction-user",
          parentId: "pi-compaction",
          timestamp: "2026-08-07T00:00:06.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "KEEP_POST_COMPACTION" }],
            timestamp: 4,
          },
        },
      ],
    },
    compactContext,
  );
  assert.equal(effectiveContextResult?.compaction?.details?.remoteCompaction?.version, 2);
  const effectiveContextBody = requestBodies[0];
  assert.match(effectiveContextBody, /KEEP_PI_COMPACTION_SUMMARY/);
  assert.match(effectiveContextBody, /KEEP_RETAINED_TAIL/);
  assert.match(effectiveContextBody, /KEEP_BRANCH_SUMMARY/);
  assert.match(effectiveContextBody, /KEEP_CUSTOM_CONTEXT/);
  assert.match(effectiveContextBody, /KEEP_SHELL_COMMAND/);
  assert.match(effectiveContextBody, /KEEP_SHELL_OUTPUT/);
  assert.match(effectiveContextBody, /KEEP_POST_COMPACTION/);
  assert.doesNotMatch(effectiveContextBody, /DROP_OLD_CONTEXT/);

  requestBodies.length = 0;
  responsePlan = [sseResponse("PI_RESPONSES_CONVERSION_ENCRYPTED")];
  const originalGetAllToolsForConversion = fakePi.getAllTools;
  const originalGetActiveToolsForConversion = fakePi.getActiveTools;
  fakePi.getAllTools = () => [
    {
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ];
  fakePi.getActiveTools = () => ["read"];
  const priorReplacementHistory = [
    {
      type: "compaction",
      encrypted_content: "PRIOR_REMOTE_COMPACTION",
    },
  ];
  setRemoteCompactionState(sessionId, {
    compactionEntryId: "prior-remote-compaction",
    modelKey: modelKey(compactContext.model),
    replacementHistory: priorReplacementHistory,
    explicitHistory: [
      ...priorReplacementHistory,
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "STALE_SERIALIZED_HISTORY" }],
      },
    ],
  });
  try {
    const conversionResult = await sessionBeforeCompact(
      {
        ...compactEvent,
        branchEntries: [
          {
            type: "compaction",
            id: "prior-remote-compaction",
            parentId: null,
            timestamp: "2026-08-07T00:59:59.000Z",
            summary: REMOTE_COMPACTION_CHECKPOINT_SUMMARY,
            firstKeptEntryId: "prior-user",
            tokensBefore: 1000,
          },
          {
            type: "message",
            id: "different-api-user",
            parentId: "prior-remote-compaction",
            timestamp: "2026-08-07T01:00:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "DROP_DIFFERENT_API_USER" }],
              timestamp: 5,
            },
          },
          {
            type: "message",
            id: "different-api-assistant",
            parentId: "different-api-user",
            timestamp: "2026-08-07T01:00:01.000Z",
            message: {
              role: "assistant",
              provider: compactContext.model.provider,
              api: "openai-codex-responses",
              model: compactContext.model.id,
              content: [{ type: "text", text: "DROP_DIFFERENT_API_ASSISTANT" }],
              stopReason: "stop",
              timestamp: 6,
            },
          },
          {
            type: "message",
            id: "multi-phase-assistant",
            parentId: "different-api-assistant",
            timestamp: "2026-08-07T01:00:02.000Z",
            message: {
              role: "assistant",
              provider: compactContext.model.provider,
              api: compactContext.model.api,
              model: compactContext.model.id,
              content: [
                {
                  type: "text",
                  text: "COMMENTARY_BLOCK",
                  textSignature: JSON.stringify({
                    v: 1,
                    id: "msg_commentary_1",
                    phase: "commentary",
                  }),
                },
                {
                  type: "thinking",
                  thinking: "",
                  thinkingSignature: JSON.stringify({
                    type: "reasoning",
                    id: "rs_reasoning_1",
                    summary: [{ type: "summary_text", text: "REASONING_SUMMARY" }],
                    encrypted_content: "ENCRYPTED_REASONING",
                  }),
                },
                {
                  type: "toolCall",
                  id: "call_read_1|fc_read_1",
                  name: "read",
                  namespace: "filesystem",
                  arguments: { path: "README.md" },
                },
                {
                  type: "text",
                  text: "FINAL_BLOCK",
                  textSignature: JSON.stringify({
                    v: 1,
                    id: "msg_final_1",
                    phase: "final_answer",
                  }),
                },
              ],
              stopReason: "toolUse",
              timestamp: 5,
            },
          },
          {
            type: "message",
            id: "multi-phase-tool-result",
            parentId: "multi-phase-assistant",
            timestamp: "2026-08-07T01:00:03.000Z",
            message: {
              role: "toolResult",
              toolCallId: "call_read_1|fc_read_1",
              toolName: "read",
              content: [{ type: "text", text: "TOOL_RESULT" }],
              isError: false,
              timestamp: 6,
            },
          },
          {
            type: "message",
            id: "post-tool-assistant",
            parentId: "multi-phase-tool-result",
            timestamp: "2026-08-07T01:00:04.000Z",
            message: {
              role: "assistant",
              provider: compactContext.model.provider,
              api: compactContext.model.api,
              model: compactContext.model.id,
              content: [{
                type: "text",
                text: "POST_TOOL_BLOCK",
                textSignature: JSON.stringify({ v: 1, id: "msg_post_tool_1" }),
              }],
              stopReason: "stop",
              timestamp: 7,
            },
          },
        ],
      },
      {
        ...compactContext,
        model: {
          ...compactContext.model,
          compat: { supportsStrictMode: true },
        },
      },
    );
    assert.equal(conversionResult?.compaction?.details?.remoteCompaction?.version, 2);
    const conversionBody = JSON.parse(requestBodies[0]);
    const convertedInput = conversionBody.input as Array<{
      encrypted_content?: string;
      id?: string;
      type?: string;
    }>;
    assert.equal(
      convertedInput.find((item) => item.type === "compaction")?.encrypted_content,
      "PRIOR_REMOTE_COMPACTION",
    );
    assert.doesNotMatch(requestBodies[0], /STALE_SERIALIZED_HISTORY/);
    assert.doesNotMatch(requestBodies[0], /DROP_DIFFERENT_API/);
    assert.deepEqual(
      convertedInput.filter((item) => item.id === "msg_commentary_1" || item.id === "msg_final_1"),
      [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "COMMENTARY_BLOCK", annotations: [] }],
          status: "completed",
          id: "msg_commentary_1",
          phase: "commentary",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "FINAL_BLOCK", annotations: [] }],
          status: "completed",
          id: "msg_final_1",
          phase: "final_answer",
        },
      ],
    );
    assert.equal(convertedInput.find((item) => item.type === "reasoning")?.id, "rs_reasoning_1");
    assert.deepEqual(
      convertedInput.find((item) => item.type === "function_call"),
      {
        type: "function_call",
        id: "fc_read_1",
        call_id: "call_read_1",
        name: "read",
        namespace: "filesystem",
        arguments: JSON.stringify({ path: "README.md" }),
      },
    );
    assert.deepEqual(
      convertedInput.find((item) => item.type === "function_call_output"),
      {
        type: "function_call_output",
        call_id: "call_read_1",
        output: "TOOL_RESULT",
      },
    );
    assert.deepEqual(conversionBody.tools, [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: false,
      },
    ]);
  } finally {
    clearRemoteCompactionState(sessionId);
    fakePi.getAllTools = originalGetAllToolsForConversion;
    fakePi.getActiveTools = originalGetActiveToolsForConversion;
  }

  requestBodies.length = 0;
  responsePlan = [sseResponse("MODEL_SWITCH_ENCRYPTED")];
  const switchedModelResult = await sessionBeforeCompact(compactEvent, {
    ...compactContext,
    model: { ...compactContext.model, id: "gpt-5.4-nano-other" },
  });
  assert.equal(switchedModelResult?.compaction?.details?.remoteCompaction?.version, 2);
  assert.equal(
    "service_tier" in JSON.parse(requestBodies[0]),
    false,
    "observed request controls must not cross model keys",
  );

  requestBodies.length = 0;
  requestUrls.length = 0;
  requestHeaders.length = 0;
  responsePlan = [sseResponse("NULL_AUTH_ENCRYPTED")];
  const deletedAuthResult = await sessionBeforeCompact(compactEvent, {
    ...compactContext,
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return {
          ok: true,
          apiKey: "must-not-be-used",
          headers: { Authorization: null },
        };
      },
    },
  });
  assert.equal(deletedAuthResult?.compaction?.details?.remoteCompaction?.version, 2);
  assert.equal(requestUrls[0], "https://proxy.example.com/v1/responses");
  assert.equal(
    requestHeaders[0].has("authorization"),
    false,
    "null ProviderHeaders values must delete matching headers before fetch",
  );
  assert.equal([...requestHeaders[0].values()].includes("null"), false);

  requestBodies.length = 0;
  responsePlan = [streamingResponse([
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "CRLF_SPLIT" },
    })}\r`,
    "\n\r",
    "\n",
    `data: ${JSON.stringify({ type: "response.completed", response: {} })}\r\r`,
  ], true)];
  const streamedResult = await sessionBeforeCompact(compactEvent, compactContext);
  assert.equal(
    streamedResult?.compaction?.details?.remoteCompaction?.replacementHistory?.at(-1)?.encrypted_content,
    "CRLF_SPLIT",
  );
  assert.equal(requestBodies.length, 1, "terminal SSE event must finish without waiting for stream close");

  requestBodies.length = 0;
  notifications.length = 0;
  responsePlan = [
    httpError(500, "first compact open failed"),
    sseResponse("DISCARDED_PARTIAL", false),
    sseResponse("RETRIED_ENCRYPTED"),
  ];
  const retriedResult = await sessionBeforeCompact(compactEvent, compactContext);
  assert.equal(requestBodies.length, 3);
  assert.equal(new Set(requestBodies).size, 1, "compaction retries must resend the same payload");
  assert.equal(JSON.parse(requestBodies[0]).service_tier, "priority");
  assert.equal(
    retriedResult?.compaction?.details?.remoteCompaction?.replacementHistory?.at(-1)?.encrypted_content,
    "RETRIED_ENCRYPTED",
  );
  assert.equal(notifications.filter(({ type }) => type === "warning").length, 2);

  beforeProviderRequest(
    { payload: { model: proxyResponsesModel.id, input: [] } },
    requestContext,
  );
  requestBodies.length = 0;
  responsePlan = [sseResponse("DEFAULT_TIER_ENCRYPTED")];
  const defaultTierResult = await sessionBeforeCompact(compactEvent, compactContext);
  assert.equal(defaultTierResult?.compaction?.details?.remoteCompaction?.version, 2);
  assert.equal(
    "service_tier" in JSON.parse(requestBodies[0]),
    false,
    "remote compaction must omit service_tier when the latest ordinary request omitted it",
  );

  for (const failureResponse of [
    httpError(400, "invalid compaction request"),
    httpError(429, "rate limit reached"),
    httpError(503, "quota exhausted", "insufficient_quota"),
    streamingResponse([
      `data: ${JSON.stringify({
        type: "error",
        code: "context_length_exceeded",
        message: "top-level context failure",
      })}\n\n`,
    ]),
    new Response([
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "compaction" },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`,
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }),
  ]) {
    requestBodies.length = 0;
    notifications.length = 0;
    responsePlan = [failureResponse];
    assert.deepEqual(await sessionBeforeCompact(compactEvent, compactContext), { cancel: true });
    assert.equal(requestBodies.length, 1, "fatal compaction errors must not retry");
    assert.match(notifications.at(-1)?.message ?? "", /local fallback was skipped/);
  }

  requestBodies.length = 0;
  responsePlan = [httpError(401, "expired credential"), sseResponse("RETRIED_AFTER_STATUS")];
  const statusRetriedResult = await sessionBeforeCompact(compactEvent, compactContext);
  assert.equal(requestBodies.length, 2, "Codex-classified unexpected statuses should retry");
  assert.equal(
    statusRetriedResult?.compaction?.details?.remoteCompaction?.replacementHistory?.at(-1)?.encrypted_content,
    "RETRIED_AFTER_STATUS",
  );

  requestBodies.length = 0;
  responsePlan = [
    httpError(500, "failure one"),
    httpError(500, "failure two"),
    httpError(500, "failure three"),
  ];
  assert.deepEqual(await sessionBeforeCompact(compactEvent, compactContext), { cancel: true });
  assert.equal(requestBodies.length, 3, "v2 compaction must stop after two retries");

  requestBodies.length = 0;
  const retryAbortController = new AbortController();
  responsePlan = [httpError(500, "abort during backoff")];
  const abortingContext = {
    ...compactContext,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
        if (type === "warning") retryAbortController.abort();
      },
    },
  };
  assert.deepEqual(
    await sessionBeforeCompact(
      { ...compactEvent, signal: retryAbortController.signal },
      abortingContext,
    ),
    { cancel: true },
  );
  assert.equal(requestBodies.length, 1, "abort during backoff must prevent another attempt");

  requestBodies.length = 0;
  notifications.length = 0;
  const streamAbortController = new AbortController();
  responsePlan = [pendingResponse()];
  const streamAbortPromise = sessionBeforeCompact(
    { ...compactEvent, signal: streamAbortController.signal },
    compactContext,
  );
  setTimeout(() => streamAbortController.abort(), 0);
  assert.deepEqual(await streamAbortPromise, { cancel: true });
  assert.equal(requestBodies.length, 1);
  assert.equal(notifications.filter(({ type }) => type === "warning").length, 0);

  requestBodies.length = 0;
  notifications.length = 0;
  const errorBodyAbortController = new AbortController();
  responsePlan = [pendingResponse(503)];
  const errorBodyAbortPromise = sessionBeforeCompact(
    { ...compactEvent, signal: errorBodyAbortController.signal },
    compactContext,
  );
  setTimeout(() => errorBodyAbortController.abort(), 0);
  assert.deepEqual(await errorBodyAbortPromise, { cancel: true });
  assert.equal(requestBodies.length, 1);
  assert.equal(notifications.filter(({ type }) => type === "warning").length, 0);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.deepEqual(
    await sessionBeforeCompact(
      { ...compactEvent, signal: alreadyAborted.signal },
      compactContext,
    ),
    { cancel: true },
  );
  assert.equal(requestBodies.length, 1);

  requestBodies.length = 0;
  const originalGetAllTools = fakePi.getAllTools;
  fakePi.getAllTools = () => {
    throw new Error("controlled request preparation failure");
  };
  try {
    assert.deepEqual(await sessionBeforeCompact(compactEvent, compactContext), { cancel: true });
    assert.equal(requestBodies.length, 0, "request preparation failure must not reach fetch");
  } finally {
    fakePi.getAllTools = originalGetAllTools;
  }

  for (const authOutcome of ["failure", "error"]) {
    requestBodies.length = 0;
    const authContext = {
      ...compactContext,
      modelRegistry: {
        async getApiKeyAndHeaders() {
          if (authOutcome === "failure") return { ok: false, error: "controlled auth failure" };
          throw new Error("controlled auth error");
        },
      },
    };
    assert.deepEqual(await sessionBeforeCompact(compactEvent, authContext), { cancel: true });
    assert.equal(requestBodies.length, 0);
  }
} finally {
  globalThis.fetch = originalFetch;
}

clearAllRuntimeState();

console.log("smoke ok");
