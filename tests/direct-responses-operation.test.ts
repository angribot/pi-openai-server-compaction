import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { attemptCodexResponsesOperation } from "../src/codex-responses-operation.ts";
import { attemptDirectResponsesOperation } from "../src/direct-responses-operation.ts";
import {
  validateRemoteCompactionResponse,
  type RemoteCompactionAttemptContext,
  type RemoteCompactionAttemptOutcome,
  type RemoteCompactionRequest,
} from "../src/remote-compaction-operation.ts";

function model(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    provider: "example-provider",
    api: "openai-responses",
    id: "gpt-test",
    name: "Direct operation test model",
    baseUrl: "https://model.example/v1/",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
    contextWindow: 100_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

function codexModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return model({
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    ...overrides,
  });
}

function request(selectedModel = model()): RemoteCompactionRequest {
  return {
    model: selectedModel,
    input: [
      { role: "user", content: [{ type: "input_text", text: "compact me" }] },
      { type: "compaction_trigger" },
    ],
    instructions: "system instructions",
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object" },
      },
    ],
    store: false,
  };
}

function context(
  signal: AbortSignal = new AbortController().signal,
  auth: Record<string, unknown> = { ok: true, apiKey: "sk-default" },
): RemoteCompactionAttemptContext {
  return {
    signal,
    sessionId: "test-session",
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return auth as any;
      },
      async complete() {
        throw new Error("complete must not be called by the direct adapter");
      },
    },
  };
}

function codexContext(
  complete: RemoteCompactionAttemptContext["modelRegistry"]["complete"],
  signal: AbortSignal = new AbortController().signal,
): RemoteCompactionAttemptContext {
  return {
    signal,
    sessionId: "codex-session",
    modelRegistry: {
      async getApiKeyAndHeaders() {
        throw new Error("getApiKeyAndHeaders must not be called by the Codex adapter");
      },
      complete,
    },
  };
}

function providerCompletion(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function streamResponse(chunks: string[], options: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, ...options },
  );
}

function openStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      },
    }),
    { status: 200 },
  );
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\r\n\r\n`;
}

async function withFetch(
  implementation: typeof globalThis.fetch,
  run: () => Promise<void>,
): Promise<void> {
  const fetchMock = mock.method(globalThis, "fetch", implementation);
  try {
    await run();
  } finally {
    fetchMock.mock.restore();
  }
}

function assertOutcome(
  outcome: RemoteCompactionAttemptOutcome,
  kind: RemoteCompactionAttemptOutcome["kind"],
): void {
  assert.equal(outcome.kind, kind, outcome.kind === "accepted" ? undefined : outcome.error.message);
}

test("runs built-in Codex through Pi while owning only the compaction payload", async () => {
  const selectedModel = codexModel();
  const compactionRequest = request(selectedModel);
  const providerPayload = {
    model: "provider-model",
    input: [{ role: "user", content: "provider input" }],
    instructions: "provider instructions",
    tools: [{ type: "function", name: "provider-tool" }],
    store: true,
    stream: false,
    messages: ["legacy"],
    previous_response_id: "resp-old",
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "provider-cache-key",
    tool_choice: "auto",
    parallel_tool_calls: true,
    future_provider_field: { preserved: true },
  };
  let operationOptions: Record<string, any> | undefined;
  let patchedPayload: unknown;
  let forwardedInput: RequestInfo | URL | undefined;
  let forwardedInit: RequestInit | undefined;
  const signal = new AbortController().signal;

  await withFetch(
    async (input, init) => {
      forwardedInput = input;
      forwardedInit = init;
      return streamResponse([
        sse({
          type: "response.output_item.done",
          item: { type: "compaction", id: "cmp-codex", encrypted_content: "opaque-codex" },
        }),
        sse({ type: "response.done", response: { status: "completed" } }),
      ]);
    },
    async () => {
      const outcome = await attemptCodexResponsesOperation(
        compactionRequest,
        codexContext(async (selected, _providerContext, options) => {
          assert.equal(selected, compactionRequest.model);
          operationOptions = options as Record<string, any>;
          patchedPayload = await options?.onPayload?.(providerPayload, selected);
          const response = await options?.fetch?.(
            "https://provider-owned.example/codex/responses",
            {
              method: "POST",
              headers: { "x-provider-owned": "yes" },
              body: "provider-owned-body",
              signal: options.signal,
            },
          );
          assert.ok(response);
          await response.text();
          return providerCompletion();
        }, signal),
      );
      assert.equal(outcome.kind, "accepted");
      if (outcome.kind === "accepted") {
        assert.deepEqual(outcome.item, {
          type: "compaction",
          id: "cmp-codex",
          encrypted_content: "opaque-codex",
        });
      }
    },
  );

  assert.equal(operationOptions?.transport, "sse");
  assert.equal(operationOptions?.maxRetries, 0);
  assert.equal(operationOptions?.sessionId, "codex-session");
  assert.equal(operationOptions?.signal, signal);
  assert.deepEqual(patchedPayload, {
    model: "gpt-codex",
    input: compactionRequest.input,
    instructions: "system instructions",
    tools: compactionRequest.tools,
    store: false,
    stream: true,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "provider-cache-key",
    tool_choice: "auto",
    parallel_tool_calls: true,
    future_provider_field: { preserved: true },
  });
  assert.equal(String(forwardedInput), "https://provider-owned.example/codex/responses");
  assert.equal(forwardedInit?.body, "provider-owned-body");
  assert.equal(new Headers(forwardedInit?.headers).get("x-provider-owned"), "yes");
});

test("requires Codex provider completion and raw capture to agree", async () => {
  const selectedModel = codexModel();

  await withFetch(
    async () =>
      streamResponse([
        sse({
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "opaque" },
        }),
        sse({ type: "response.completed", response: {} }),
      ]),
    async () => {
      const outcome = await attemptCodexResponsesOperation(
        request(selectedModel),
        codexContext(async (selected, _providerContext, options) => {
          const response = await options?.fetch?.("https://provider.example/codex/responses");
          assert.ok(response);
          await response.text();
          return providerCompletion({ stopReason: "error", errorMessage: "provider rejected" });
        }),
      );
      assertOutcome(outcome, "terminal");
    },
  );

  const uncaptured = await attemptCodexResponsesOperation(
    request(selectedModel),
    codexContext(async () => providerCompletion()),
  );
  assertOutcome(uncaptured, "terminal");
});

test("leaves Codex network retry to the shared budget and stops before work on abort", async () => {
  const selectedModel = codexModel();
  await withFetch(
    async () => {
      throw new TypeError("connection reset");
    },
    async () => {
      const outcome = await attemptCodexResponsesOperation(
        request(selectedModel),
        codexContext(async (selected, _providerContext, options) => {
          try {
            await options?.fetch?.("https://provider.example/codex/responses");
          } catch {
            return providerCompletion({ stopReason: "error", errorMessage: "connection reset" });
          }
          throw new Error("expected fetch to fail");
        }),
      );
      assertOutcome(outcome, "retryable");
    },
  );

  const controller = new AbortController();
  controller.abort();
  let completeCalls = 0;
  const outcome = await attemptCodexResponsesOperation(
    request(selectedModel),
    codexContext(async () => {
      completeCalls++;
      return providerCompletion();
    }, controller.signal),
  );
  assertOutcome(outcome, "terminal");
  assert.equal(completeCalls, 0);
});

test("resolves routing and header precedence and sends the minimal HTTP/SSE body once", async () => {
  const selectedModel = model({
    headers: {
      Authorization: "model credential",
      "X-Model": "model",
      "Content-Type": "application/custom+json",
    },
  });
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  let fetchCalls = 0;

  await withFetch(
    async (input, init) => {
      fetchCalls++;
      capturedUrl = String(input);
      capturedInit = init;
      return streamResponse([
        sse({
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "opaque" },
        }),
        sse({ type: "response.completed", response: {} }),
      ]);
    },
    async () => {
      const outcome = await attemptDirectResponsesOperation(
        request(selectedModel),
        context(undefined, {
          ok: true,
          apiKey: "sk-default",
          baseUrl: "https://resolved.example/openai/v1/",
          headers: {
            authorization: "resolved credential",
            "x-model": null,
            ACCEPT: null,
            "X-Resolved": "yes",
          },
        }),
      );
      assertOutcome(outcome, "accepted");
    },
  );

  assert.equal(capturedUrl, "https://resolved.example/openai/v1/responses");
  assert.equal(fetchCalls, 1);
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), "resolved credential");
  assert.equal(headers.has("x-model"), false);
  assert.equal(headers.has("accept"), false);
  assert.equal(headers.get("content-type"), "application/custom+json");
  assert.equal(headers.get("x-resolved"), "yes");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: "gpt-test",
    input: [
      { role: "user", content: [{ type: "input_text", text: "compact me" }] },
      { type: "compaction_trigger" },
    ],
    instructions: "system instructions",
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object" },
      },
    ],
    store: false,
    stream: true,
  });
});

test("validates captured split CRLF SSE at explicit completion without waiting for close", async () => {
  const item = {
    type: "compaction",
    id: "cmp_1",
    encrypted_content: "",
    future_field: { preserved: true },
  };
  const wire = [
    sse({ type: "response.unknown", ignored: true }),
    sse({ type: "response.output_item.done", item: { type: "message", role: "assistant" } }),
    sse({ type: "response.output_item.done", item }),
    sse({
      type: "response.completed",
      response: {
        output: [],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 2 },
        },
      },
    }),
  ].join("");
  const chunks = [wire.slice(0, 7), wire.slice(7, 39), wire.slice(39, 113), wire.slice(113)];

  const outcome = await validateRemoteCompactionResponse(
    request(),
    openStreamResponse(chunks),
    new AbortController().signal,
  );
  assert.equal(outcome.kind, "accepted");
  if (outcome.kind !== "accepted") return;
  assert.deepEqual(outcome.item, item);
  assert.deepEqual(outcome.usage, {
    input: 8,
    output: 4,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 14,
    cost: {
      input: 0.000008,
      output: 0.000008,
      cacheRead: 0.000001,
      cacheWrite: 0,
      total: 0.000017,
    },
  });
});

test("requires response.completed and classifies pre-completion stream failures as retryable", async () => {
  const cases: Array<[string, string[]]> = [
    ["done sentinel", ["data: [DONE]\n\n"]],
    [
      "seen item then EOF",
      [
        sse({
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "opaque" },
        }),
      ],
    ],
    ["malformed JSON", ["data: {not-json}\n\n"]],
    ["incomplete", [sse({ type: "response.incomplete", response: {} })]],
  ];

  for (const [_name, chunks] of cases) {
    await withFetch(
      async () => streamResponse(chunks),
      async () => {
        const outcome = await attemptDirectResponsesOperation(request(), context());
        assertOutcome(outcome, "retryable");
      },
    );
  }
});

test("treats completed-response compaction item validation as terminal", async () => {
  const cases: Array<[string, unknown[]]> = [
    ["zero", []],
    [
      "multiple",
      [
        { type: "compaction", encrypted_content: "one" },
        { type: "compaction", encrypted_content: "two" },
      ],
    ],
    ["invalid ciphertext", [{ type: "compaction", encrypted_content: 1 }]],
    ["wrong type", [{ type: "compaction_summary", encrypted_content: "old" }]],
  ];

  for (const [_name, items] of cases) {
    await withFetch(
      async () =>
        streamResponse([
          ...items.map((item) => sse({ type: "response.output_item.done", item })),
          sse({ type: "response.completed", response: {} }),
        ]),
      async () => {
        const outcome = await attemptDirectResponsesOperation(request(), context());
        assertOutcome(outcome, "terminal");
      },
    );
  }
});

test("classifies transient and terminal HTTP failures with semantic overrides", async () => {
  const cases: Array<[string, number, unknown, "retryable" | "terminal"]> = [
    ["timeout", 408, { error: { code: "request_timeout", message: "later" } }, "retryable"],
    ["conflict", 409, {}, "retryable"],
    ["too early", 425, {}, "retryable"],
    ["rate limit", 429, { error: { code: "rate_limit_exceeded" } }, "retryable"],
    ["server", 503, {}, "retryable"],
    ["bad request", 400, {}, "terminal"],
    ["bad request transient code", 400, { error: { code: "server_error" } }, "terminal"],
    ["unauthorized", 401, {}, "terminal"],
    ["forbidden", 403, {}, "terminal"],
    ["not found", 404, {}, "terminal"],
    ["unprocessable", 422, {}, "terminal"],
    ["overflow", 500, { error: { code: "context_length_exceeded" } }, "terminal"],
    ["type override", 503, { error: { type: "invalid_request_error" } }, "terminal"],
    ["quota override", 429, { error: { code: "insufficient_quota" } }, "terminal"],
  ];

  for (const [_name, status, body, expected] of cases) {
    await withFetch(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      async () => {
        const outcome = await attemptDirectResponsesOperation(request(), context());
        assertOutcome(outcome, expected);
      },
    );
  }
});

test("classifies streamed failed and error terminals", async () => {
  const cases: Array<[unknown, "retryable" | "terminal"]> = [
    [{ type: "response.failed", response: { error: { code: "server_error" } } }, "retryable"],
    [{ type: "error", code: "server_overloaded", message: "busy" }, "retryable"],
    [{ type: "error", type_alias: "ignored", code: "invalid_prompt", message: "bad" }, "terminal"],
    [{ type: "error", error: "ignored", message: "bad", code: "policy_violation" }, "terminal"],
    [
      {
        type: "response.failed",
        response: { error: { type: "invalid_request_error", message: "bad request" } },
      },
      "terminal",
    ],
    [
      {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "context_length_exceeded" } },
      },
      "terminal",
    ],
    [{ type: "response.failed", response: { error: { code: "usage_limit_reached" } } }, "terminal"],
  ];

  for (const [event, expected] of cases) {
    await withFetch(
      async () => streamResponse([sse(event)]),
      async () => {
        const outcome = await attemptDirectResponsesOperation(request(), context());
        assertOutcome(outcome, expected);
      },
    );
  }
});

test("returns standard Retry-After values on retryable HTTP outcomes", async () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const cases: Array<[string, number | undefined]> = [
    ["1.5", 1_500],
    [future, 60_000],
    ["invalid", undefined],
  ];

  for (const [header, expected] of cases) {
    await withFetch(
      async () =>
        new Response("busy", {
          status: 429,
          headers: { "retry-after": header },
        }),
      async () => {
        const outcome = await attemptDirectResponsesOperation(request(), context());
        assert.equal(outcome.kind, "retryable");
        if (outcome.kind !== "retryable") return;
        if (expected === undefined) assert.equal(outcome.retryAfterMs, undefined);
        else assert.ok(Math.abs((outcome.retryAfterMs ?? 0) - expected) < 2_000);
      },
    );
  }
});

test("classifies network and success/error body read failures as retryable", async () => {
  await withFetch(
    async () => {
      throw new TypeError("connection reset");
    },
    async () => {
      const outcome = await attemptDirectResponsesOperation(request(), context());
      assertOutcome(outcome, "retryable");
    },
  );

  for (const status of [200, 503]) {
    await withFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body read failed"));
            },
          }),
          { status },
        ),
      async () => {
        const outcome = await attemptDirectResponsesOperation(request(), context());
        assertOutcome(outcome, "retryable");
      },
    );
  }
});

test("stream idle timeout is retryable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withFetch(
    async () =>
      new Response(
        new ReadableStream({
          start() {
            // Deliberately leave the stream idle.
          },
        }),
        { status: 200 },
      ),
    async () => {
      const promise = attemptDirectResponsesOperation(request(), context());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      t.mock.timers.tick(300_000);
      const outcome = await promise;
      assertOutcome(outcome, "retryable");
    },
  );
});

test("caller abort is terminal before fetch and during success or error body reads", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return streamResponse([]);
    },
    async () => {
      const outcome = await attemptDirectResponsesOperation(request(), context(preAborted.signal));
      assertOutcome(outcome, "terminal");
    },
  );
  assert.equal(calls, 0);

  const duringRead = new AbortController();
  await withFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: "));
          },
        }),
        { status: 200 },
      ),
    async () => {
      const promise = attemptDirectResponsesOperation(request(), context(duringRead.signal));
      queueMicrotask(() => duringRead.abort());
      const outcome = await promise;
      assertOutcome(outcome, "terminal");
    },
  );

  const duringErrorRead = new AbortController();
  await withFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("busy"));
          },
        }),
        { status: 429 },
      ),
    async () => {
      const promise = attemptDirectResponsesOperation(request(), context(duringErrorRead.signal));
      queueMicrotask(() => duringErrorRead.abort());
      const outcome = await promise;
      assertOutcome(outcome, "terminal");
    },
  );
});
