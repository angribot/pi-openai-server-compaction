import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
  remoteCompactionFailureOutcome,
  remoteCompactionPayload,
  validateRemoteCompactionResponse,
  type RemoteCompactionAttempt,
} from "./remote-compaction-operation.ts";

function providerCompletionError(completion: AssistantMessage): Error {
  return new Error(
    completion.errorMessage || `Pi's Codex provider stopped with ${completion.stopReason}`,
  );
}

export const attemptCodexResponsesOperation: RemoteCompactionAttempt = async (request, context) => {
  const { signal } = context;
  if (signal.aborted) {
    return remoteCompactionFailureOutcome("terminal", signal.reason, "request was aborted", signal);
  }

  let capturedResponse: Response | undefined;
  let fetchFailure: unknown;
  const capturingFetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const response = await globalThis.fetch(input, init);
      capturedResponse = response.clone();
      return response;
    } catch (error) {
      fetchFailure = error;
      throw error;
    }
  };

  const providerContext: Context = { messages: [] };
  let completion: AssistantMessage | undefined;
  let completionFailure: unknown;
  try {
    completion = await context.modelRegistry.complete(request.model, providerContext, {
      signal,
      transport: "sse",
      maxRetries: 0,
      sessionId: context.sessionId,
      onPayload: (payload: unknown) => remoteCompactionPayload(request, payload),
      fetch: capturingFetch,
    });
  } catch (error) {
    completionFailure = error;
  }

  if (signal.aborted) {
    return remoteCompactionFailureOutcome("terminal", signal.reason, "request was aborted", signal);
  }
  if (!capturedResponse) {
    if (fetchFailure !== undefined) {
      return remoteCompactionFailureOutcome(
        "retryable",
        fetchFailure,
        "Codex network request failed",
        signal,
      );
    }
    const failure = completion ? providerCompletionError(completion) : completionFailure;
    return remoteCompactionFailureOutcome(
      "terminal",
      failure,
      "Pi's Codex provider completed without a captured HTTP response",
      signal,
    );
  }

  const rawOutcome = await validateRemoteCompactionResponse(request, capturedResponse, signal);
  if (rawOutcome.kind !== "accepted") return rawOutcome;
  if (completionFailure !== undefined) {
    return remoteCompactionFailureOutcome(
      "terminal",
      completionFailure,
      "Pi's Codex provider operation failed after raw completion",
      signal,
    );
  }
  if (!completion || completion.stopReason === "error" || completion.stopReason === "aborted") {
    return remoteCompactionFailureOutcome(
      "terminal",
      completion ? providerCompletionError(completion) : undefined,
      "Pi's Codex provider did not accept the completed response",
      signal,
    );
  }
  return rawOutcome;
};
