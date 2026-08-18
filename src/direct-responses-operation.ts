import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
  remoteCompactionFailureOutcome,
  remoteCompactionPayload,
  validateRemoteCompactionResponse,
  type RemoteCompactionAttempt,
} from "./remote-compaction-operation.ts";

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

export const attemptDirectResponsesOperation: RemoteCompactionAttempt = async (
  request,
  context,
) => {
  const { signal } = context;
  if (signal.aborted) {
    return remoteCompactionFailureOutcome("terminal", signal.reason, "request was aborted", signal);
  }

  let auth: Awaited<ReturnType<typeof context.modelRegistry.getApiKeyAndHeaders>>;
  try {
    auth = await context.modelRegistry.getApiKeyAndHeaders(request.model);
  } catch (error) {
    return remoteCompactionFailureOutcome(
      "terminal",
      error,
      "authentication resolution failed",
      signal,
    );
  }
  if (signal.aborted) {
    return remoteCompactionFailureOutcome("terminal", signal.reason, "request was aborted", signal);
  }
  if (!auth.ok) {
    return remoteCompactionFailureOutcome("terminal", undefined, auth.error, signal);
  }

  let body: string;
  try {
    body = JSON.stringify(remoteCompactionPayload(request));
  } catch (error) {
    return remoteCompactionFailureOutcome(
      "terminal",
      error,
      "request serialization failed",
      signal,
    );
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
    return remoteCompactionFailureOutcome("retryable", error, "network request failed", signal);
  }

  return validateRemoteCompactionResponse(request, response, signal);
};
