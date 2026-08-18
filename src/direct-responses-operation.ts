import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
  validateRemoteCompactionResponse,
  type RemoteCompactionAttempt,
  type RemoteCompactionAttemptOutcome,
  type RemoteCompactionRequest,
} from "./remote-compaction-operation.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown, fallback: string): string {
  if (isRecord(value) && typeof value.message === "string" && value.message) {
    return value.message;
  }
  return fallback;
}

function outcomeError(message: string): Error {
  return new Error(`Remote compaction v2: ${message}`);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

function terminal(message: string): RemoteCompactionAttemptOutcome {
  return { kind: "terminal", error: outcomeError(message) };
}

function retryable(message: string): RemoteCompactionAttemptOutcome {
  return { kind: "retryable", error: outcomeError(message) };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const expected = name.toLowerCase();
  for (const current of Object.keys(headers)) {
    if (current.toLowerCase() === expected) delete headers[current];
  }
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  deleteHeader(headers, name);
  headers[name] = value;
}

function applyHeaders(
  headers: Record<string, string>,
  values: Record<string, string | null> | undefined,
  deleted: Set<string>,
): void {
  for (const [name, value] of Object.entries(values ?? {})) {
    const normalized = name.toLowerCase();
    deleteHeader(headers, name);
    if (value === null) {
      deleted.add(normalized);
    } else {
      headers[name] = value;
      deleted.delete(normalized);
    }
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((current) => current.toLowerCase() === expected);
}

function buildHeaders(
  model: Model<any>,
  apiKey: string | undefined,
  authHeaders: ProviderHeaders | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const deleted = new Set<string>();
  if (apiKey) setHeader(headers, "Authorization", `Bearer ${apiKey}`);
  applyHeaders(headers, model.headers, deleted);
  applyHeaders(headers, authHeaders, deleted);

  if (!deleted.has("accept") && !hasHeader(headers, "accept")) {
    setHeader(headers, "Accept", "text/event-stream");
  }
  if (!deleted.has("content-type") && !hasHeader(headers, "content-type")) {
    setHeader(headers, "Content-Type", "application/json");
  }
  return headers;
}

function endpointUrl(model: Model<any>, resolvedBaseUrl: string | undefined): string {
  const baseUrl = (resolvedBaseUrl ?? model.baseUrl).replace(/\/+$/, "");
  return baseUrl.endsWith("/responses") ? baseUrl : `${baseUrl}/responses`;
}

function requestBody(request: RemoteCompactionRequest): Record<string, unknown> {
  return {
    model: request.model.id,
    input: request.input,
    instructions: request.instructions,
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    store: false,
    stream: true,
  };
}

export const attemptDirectResponsesOperation: RemoteCompactionAttempt = async (
  request,
  context,
) => {
  const { signal } = context;
  if (signal.aborted) return { kind: "terminal", error: abortError(signal) };

  let auth: Awaited<ReturnType<typeof context.modelRegistry.getApiKeyAndHeaders>>;
  try {
    throwIfAborted(signal);
    auth = await context.modelRegistry.getApiKeyAndHeaders(request.model);
    throwIfAborted(signal);
  } catch (error) {
    if (isAbort(error, signal)) {
      return { kind: "terminal", error: abortError(signal) };
    }
    return terminal(errorMessage(error, "authentication resolution failed"));
  }
  if (!auth.ok) return terminal(auth.error);

  let body: string;
  try {
    body = JSON.stringify(requestBody(request));
  } catch (error) {
    return terminal(errorMessage(error, "request serialization failed"));
  }

  let response: Response;
  try {
    response = await fetch(endpointUrl(request.model, auth.baseUrl), {
      method: "POST",
      headers: buildHeaders(request.model, auth.apiKey, auth.headers),
      body,
      signal,
    });
  } catch (error) {
    if (isAbort(error, signal)) {
      return { kind: "terminal", error: abortError(signal) };
    }
    return retryable(errorMessage(error, "network request failed"));
  }

  return validateRemoteCompactionResponse(request, response, signal);
};
