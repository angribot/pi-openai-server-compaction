import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ResponsesFunctionTool, ResponsesItem } from "./responses-projection.ts";

export type CompactionItem = ResponsesItem & {
  type: "compaction";
  encrypted_content: string;
};

export type RemoteCompactionRequest = Readonly<{
  model: Model<any>;
  input: readonly ResponsesItem[];
  instructions: string;
  tools?: readonly ResponsesFunctionTool[];
  store: false;
}>;

export type RemoteCompactionAttemptContext = Readonly<{
  modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">;
  signal: AbortSignal;
}>;

export type RemoteCompactionAttemptOutcome =
  | { kind: "accepted"; item: CompactionItem; usage?: Usage }
  | { kind: "retryable"; error: Error; retryAfterMs?: number }
  | { kind: "terminal"; error: Error };

export type RemoteCompactionAttempt = (
  request: RemoteCompactionRequest,
  context: RemoteCompactionAttemptContext,
) => Promise<RemoteCompactionAttemptOutcome>;

const STREAM_IDLE_TIMEOUT_MS = 300_000;
const TRANSIENT_ERROR_CODES = new Set([
  "rate_limit_exceeded",
  "request_timeout",
  "server_error",
  "server_overloaded",
  "server_is_overloaded",
  "slow_down",
  "temporarily_unavailable",
  "overloaded",
]);
const TERMINAL_ERROR_CODES = new Set([
  "bio_policy",
  "billing_hard_limit_reached",
  "content_policy_violation",
  "context_length_exceeded",
  "context_window_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_prompt",
  "invalid_request",
  "invalid_request_error",
  "operation_not_supported",
  "policy_violation",
  "unsupported_operation",
  "usage_limit_reached",
  "usage_not_included",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown, fallback: string): string {
  if (isRecord(value) && typeof value.message === "string" && value.message) {
    return value.message;
  }
  return fallback;
}

function errorSemantics(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return [value.code, value.type, value.reason]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.toLowerCase());
}

function outcomeError(message: string): Error {
  return new Error(`Remote compaction v2: ${message}`);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function terminal(message: string): RemoteCompactionAttemptOutcome {
  return { kind: "terminal", error: outcomeError(message) };
}

function retryable(message: string, retryAfterMs?: number): RemoteCompactionAttemptOutcome {
  return {
    kind: "retryable",
    error: outcomeError(message),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export function remoteCompactionFailureOutcome(
  kind: "retryable" | "terminal",
  error: unknown,
  fallback: string,
  signal: AbortSignal,
  retryAfterMs?: number,
): RemoteCompactionAttemptOutcome {
  if (isAbort(error, signal)) return { kind: "terminal", error: abortError(signal) };
  const failure = outcomeError(errorMessage(error, fallback));
  if (kind === "retryable") {
    return {
      kind,
      error: failure,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  return { kind, error: failure };
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

function parseErrorPayload(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) && isRecord(parsed.error) ? parsed.error : parsed;
  } catch {
    return { message: text };
  }
}

function classifyFailure(failure: unknown): "retryable" | "terminal" {
  const semantics = errorSemantics(failure);
  if (semantics.some((semantic) => TERMINAL_ERROR_CODES.has(semantic))) return "terminal";
  if (semantics.some((semantic) => TRANSIENT_ERROR_CODES.has(semantic))) return "retryable";
  return "retryable";
}

function classifyHttpFailure(status: number, failure: unknown): "retryable" | "terminal" {
  const semantics = errorSemantics(failure);
  if (semantics.some((semantic) => TERMINAL_ERROR_CODES.has(semantic))) return "terminal";
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
    return "retryable";
  }
  if (status >= 400 && status < 500) return "terminal";
  if (semantics.some((semantic) => TRANSIENT_ERROR_CODES.has(semantic))) return "retryable";
  return "terminal";
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  throwIfAborted(signal);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => {
      void reader.cancel().catch(() => {});
      finish(() => reject(abortError(signal)));
    };
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      finish(() => reject(outcomeError("stream idle timeout")));
    }, STREAM_IDLE_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function readBodyText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): unknown | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return undefined;
  return JSON.parse(data) as unknown;
}

function isTerminalEvent(event: unknown): boolean {
  return (
    isRecord(event) &&
    (event.type === "error" ||
      event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete")
  );
}

async function readUntilTerminal(
  response: Response,
  signal: AbortSignal,
): Promise<{ events: unknown[]; terminal: unknown | undefined }> {
  if (!response.body) throw outcomeError("response body was empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";
  let skipLeadingLineFeed = false;

  const append = (value: string, final = false) => {
    let decoded = value;
    if (skipLeadingLineFeed && (decoded.length > 0 || final)) {
      if (decoded.startsWith("\n")) decoded = decoded.slice(1);
      skipLeadingLineFeed = false;
    }
    const trailingCarriageReturn = !final && decoded.endsWith("\r");
    if (trailingCarriageReturn) {
      decoded = decoded.slice(0, -1);
      skipLeadingLineFeed = true;
    }
    buffer += decoded.replace(/\r\n?/g, "\n");
    if (trailingCarriageReturn) buffer += "\n";
  };

  const drain = (): unknown | undefined => {
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const event = parseSseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event !== undefined) {
        events.push(event);
        if (isTerminalEvent(event)) return event;
      }
      boundary = buffer.indexOf("\n\n");
    }
    return undefined;
  };

  try {
    while (true) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) break;
      append(decoder.decode(chunk.value, { stream: true }));
      const terminalEvent = drain();
      if (terminalEvent !== undefined) {
        await reader.cancel().catch(() => {});
        return { events, terminal: terminalEvent };
      }
    }
    append(decoder.decode(), true);
    const terminalEvent = drain();
    return { events, terminal: terminalEvent };
  } finally {
    reader.releaseLock();
  }
}

function parseUsage(model: Model<any>, value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const finite = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate) ? Math.max(0, candidate) : 0;
  const inputTokens = finite(value.input_tokens);
  const outputTokens = finite(value.output_tokens);
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const cacheRead = finite(details.cached_tokens);
  const cacheWrite = finite(details.cache_creation_tokens ?? details.cache_write_tokens);
  const usage: Usage = {
    input: Math.max(0, inputTokens - cacheRead - cacheWrite),
    output: outputTokens,
    cacheRead,
    cacheWrite,
    totalTokens: finite(value.total_tokens) || inputTokens + outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function completedResult(
  request: RemoteCompactionRequest,
  events: readonly unknown[],
  completedEvent: Record<string, unknown>,
  signal: AbortSignal,
): RemoteCompactionAttemptOutcome {
  const response = isRecord(completedEvent.response) ? completedEvent.response : {};
  const compactionItems = events.flatMap((event) => {
    if (
      !isRecord(event) ||
      event.type !== "response.output_item.done" ||
      !isRecord(event.item) ||
      event.item.type !== "compaction"
    ) {
      return [];
    }
    return [event.item];
  });
  if (compactionItems.length !== 1) {
    return terminal(`completed response contained ${compactionItems.length} compaction items`);
  }
  const [item] = compactionItems;
  if (!item || typeof item.encrypted_content !== "string") {
    return terminal("completed response contained an invalid compaction item");
  }
  throwIfAborted(signal);
  const usage = parseUsage(request.model, response.usage);
  return {
    kind: "accepted",
    item: item as CompactionItem,
    ...(usage ? { usage } : {}),
  };
}

export async function validateRemoteCompactionResponse(
  request: RemoteCompactionRequest,
  response: Response,
  signal: AbortSignal,
): Promise<RemoteCompactionAttemptOutcome> {
  if (signal.aborted) return { kind: "terminal", error: abortError(signal) };

  if (!response.ok) {
    let text: string;
    try {
      text = await readBodyText(response, signal);
      throwIfAborted(signal);
    } catch (error) {
      if (isAbort(error, signal)) {
        return { kind: "terminal", error: abortError(signal) };
      }
      return retryable(errorMessage(error, "HTTP error body read failed"));
    }
    const failure = parseErrorPayload(text);
    const message = errorMessage(failure, text || response.statusText || `HTTP ${response.status}`);
    const classification = classifyHttpFailure(response.status, failure);
    if (classification === "terminal") return terminal(`HTTP ${response.status}: ${message}`);
    return retryable(
      `HTTP ${response.status}: ${message}`,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }

  let streamed: { events: unknown[]; terminal: unknown | undefined };
  try {
    streamed = await readUntilTerminal(response, signal);
    throwIfAborted(signal);
  } catch (error) {
    if (isAbort(error, signal)) {
      return { kind: "terminal", error: abortError(signal) };
    }
    return retryable(errorMessage(error, "stream read or parse failed"));
  }

  if (!isRecord(streamed.terminal)) {
    return retryable("stream ended before response.completed");
  }
  const event = streamed.terminal;
  if (event.type === "response.completed") {
    const outcome = completedResult(request, streamed.events, event, signal);
    if (signal.aborted) return { kind: "terminal", error: abortError(signal) };
    return outcome;
  }
  if (event.type === "response.incomplete") {
    const responsePayload = isRecord(event.response) ? event.response : undefined;
    const details =
      responsePayload && isRecord(responsePayload.incomplete_details)
        ? responsePayload.incomplete_details
        : undefined;
    return classifyFailure(details) === "terminal"
      ? terminal(errorMessage(details, "response was incomplete"))
      : retryable("response was incomplete");
  }

  let failure: unknown = event;
  if (event.type === "response.failed") {
    failure = isRecord(event.response) ? event.response.error : undefined;
  }
  const message = errorMessage(failure, "endpoint returned a failed response");
  return classifyFailure(failure) === "terminal" ? terminal(message) : retryable(message);
}
