import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localNodeModules = join(repoRoot, "node_modules");

function packagePathSegments(packageName) {
  return packageName.split("/");
}

function npmGlobalRoot() {
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

function candidateRoots() {
  const roots = new Set();
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

function resolveInstalledPackageDir(packageName) {
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

function ensureLocalPeerLink(packageName) {
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

const { default: extensionFactory } = await import(pathToFileURL(join(repoRoot, "src", "index.ts")).href);
assert.equal(typeof extensionFactory, "function", "extension entrypoint should export a function");

const {
  buildRemoteCompactionHeaders,
  buildRemoteCompactionDetails,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  extractRemoteCompactionDetails,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  remoteCompactionV2EndpointUrl,
} = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
const {
  modelKey,
  supportsRemoteCompactionModel,
} = await import(pathToFileURL(join(repoRoot, "src", "openai.ts")).href);
const {
  clearAllRuntimeState,
  setRemoteCompactionState,
} = await import(pathToFileURL(join(repoRoot, "src", "state.ts")).href);

const targetModelKey = "openai:openai-responses:gpt-5.4-nano";
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
        model: "gpt-5.4-nano",
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
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
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
        model: "gpt-5.4-nano",
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
const v2History = buildRemoteCompactionV2History(
  [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retain user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "summarize assistant" }] },
  ],
  parsedV2Events.compactionItem,
);
assert.deepEqual(v2History.map((item) => item.type), ["message", "compaction"]);
assert.equal(v2History[0].role, "user");

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
  output: "aborted",
});
assert.equal(normalizedPromptItems[3].result, "");
assert.doesNotMatch(JSON.stringify(normalizedPromptItems), /orphan|ghost_snapshot/);

const compactedHistory = processCompactedHistory([
  { type: "message", role: "developer", content: [{ type: "input_text", text: "drop developer" }] },
  { type: "message", role: "user", content: [] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
  { type: "function_call", name: "read", call_id: "call-2", arguments: "{}" },
  { type: "compaction", encrypted_content: "keep" },
]);
assert.deepEqual(compactedHistory.map((item) => item.type), ["message", "message", "compaction"]);
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

const handlers = new Map();
const fakePi = {
  registerProvider() {
    assert.fail("remote compaction must not register or override providers");
  },
  on(name, handler) {
    handlers.set(name, handler);
  },
  getAllTools() {
    return [];
  },
  getActiveTools() {
    return [];
  },
  getThinkingLevel() {
    return undefined;
  },
};
extensionFactory(fakePi);

const beforeProviderRequest = handlers.get("before_provider_request");
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
      model: proxyResponsesModel.id,
      input: [{ type: "message", role: "user", content: "stale full history" }],
      messages: ["legacy"],
      previous_response_id: "resp_stale",
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

const sessionBeforeCompact = handlers.get("session_before_compact");
assert.equal(typeof sessionBeforeCompact, "function");
const requestBodies = [];
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === "string"
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : "";
    requestBodies.push(body);
    return new Response(JSON.stringify({ error: { message: "controlled failure" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  const message = {
    role: "user",
    content: [{ type: "text", text: "retain this context" }],
    timestamp: Date.now(),
  };
  const fallbackResult = await sessionBeforeCompact(
    {
      preparation: {
        firstKeptEntryId: "keep-after-fallback",
        messagesToSummarize: [message],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
      },
      branchEntries: [{ type: "message", id: "message-1", message }],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    {
      ...requestContext,
      model: {
        ...proxyResponsesModel,
        name: "Header-authenticated proxy",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4096,
      },
      modelRegistry: {
        async getApiKeyAndHeaders() {
          return { ok: true, headers: { Authorization: "Custom credential" } };
        },
      },
      getSystemPrompt() {
        return "system prompt";
      },
    },
  );
  assert.ok(requestBodies.some((body) => body.includes("compaction_trigger")));
  assert.equal(fallbackResult?.compaction?.details?.remoteCompaction, undefined);
} finally {
  globalThis.fetch = originalFetch;
}

clearAllRuntimeState();

console.log("smoke ok");
