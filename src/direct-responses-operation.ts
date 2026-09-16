import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import {
  remoteCompactionFailureOutcome,
  remoteCompactionPayload,
  validateRemoteCompactionResponse,
  type RemoteCompactionAttempt,
} from "./remote-compaction-operation.ts";

function applyHeaders(
  headers: Headers,
  values: Record<string, string | null> | undefined,
  deleted: Set<string>,
): void {
  for (const [name, value] of Object.entries(values ?? {})) {
    const normalized = name.toLowerCase();
    if (value === null) {
      headers.delete(name);
      deleted.add(normalized);
    } else {
      headers.set(name, value);
      deleted.delete(normalized);
    }
  }
}

function buildHeaders(
  model: Model<any>,
  apiKey: string | undefined,
  authHeaders: ProviderHeaders | undefined,
): Headers {
  const headers = new Headers();
  const deleted = new Set<string>();
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  applyHeaders(headers, model.headers, deleted);
  applyHeaders(headers, authHeaders, deleted);

  if (!deleted.has("accept") && !headers.has("accept")) {
    headers.set("Accept", "text/event-stream");
  }
  if (!deleted.has("content-type") && !headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
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
