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

// Pi awaits cancellation when its consumer fails. A tee's cancellation waits
// for both readers, so let Pi release its reader before the raw owner settles.
function providerResponse(response: Response): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let cancelled = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (cancelled) return;
          if (chunk.done) {
            controller.close();
            reader.releaseLock();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          if (!cancelled) controller.error(error);
          reader.releaseLock();
        }
      },
      cancel() {
        cancelled = true;
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

export const attemptCodexResponsesOperation: RemoteCompactionAttempt = async (request, context) => {
  const { signal } = context;
  if (signal.aborted) {
    return remoteCompactionFailureOutcome("terminal", signal.reason, "request was aborted", signal);
  }

  const attempt = new AbortController();
  const onAbort = () => attempt.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const aborted = new Promise<undefined>((resolve) => {
    attempt.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    if (attempt.signal.aborted) resolve(undefined);
  });

  try {
    let rawOutcomePromise: ReturnType<typeof validateRemoteCompactionResponse> | undefined;
    let fetchFailure: unknown;
    const capturingFetch: typeof globalThis.fetch = async (input, init) => {
      try {
        attempt.signal.throwIfAborted();
        const fetched = await globalThis.fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([attempt.signal, init.signal]) : attempt.signal,
        });
        // Enforce cancellation for both consumers, including the provider's
        // HTTP error-body reader, which does not observe its call signal itself.
        const response = new Response(
          fetched.body?.pipeThrough(new TransformStream(), { signal: attempt.signal }) ?? null,
          { status: fetched.status, statusText: fetched.statusText, headers: fetched.headers },
        );
        rawOutcomePromise = validateRemoteCompactionResponse(
          request,
          response.clone(),
          attempt.signal,
        ).then((outcome) => {
          if (outcome.kind !== "accepted") attempt.abort(outcome.error);
          return outcome;
        });
        void rawOutcomePromise.catch(() => {});
        return providerResponse(response);
      } catch (error) {
        fetchFailure = error;
        throw error;
      }
    };

    const providerContext: Context = { messages: [] };
    let completion: AssistantMessage | undefined;
    let completionFailure: unknown;
    try {
      completion = await Promise.race([
        context.modelRegistry.complete(request.model, providerContext, {
          signal: attempt.signal,
          transport: "sse",
          maxRetries: 0,
          sessionId: context.sessionId,
          onPayload: (payload: unknown) => remoteCompactionPayload(request, payload),
          fetch: capturingFetch,
        }),
        aborted,
      ]);
    } catch (error) {
      completionFailure = error;
    }

    if (signal.aborted) {
      return remoteCompactionFailureOutcome(
        "terminal",
        signal.reason,
        "request was aborted",
        signal,
      );
    }
    if (!rawOutcomePromise) {
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

    if (
      completionFailure !== undefined ||
      completion?.stopReason === "error" ||
      completion?.stopReason === "aborted"
    ) {
      attempt.abort(completionFailure ?? providerCompletionError(completion!));
    }
    const rawOutcome = await rawOutcomePromise;
    if (signal.aborted) {
      return remoteCompactionFailureOutcome(
        "terminal",
        signal.reason,
        "request was aborted",
        signal,
      );
    }
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
  } finally {
    signal.removeEventListener("abort", onAbort);
    attempt.abort();
  }
};
