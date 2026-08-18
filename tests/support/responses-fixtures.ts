import type {
  CompactionItem,
  DirectResponsesAttempt,
  DirectResponsesAttemptOutcome,
  RemoteCompactionRequest,
} from "../../src/direct-responses-operation.ts";

export const firstCompactionItem: CompactionItem = {
  type: "compaction",
  id: "cmp-first",
  encrypted_content: "FIRST-OPAQUE",
  unknown_field: { preserved: true },
};

export const secondCompactionItem: CompactionItem = {
  type: "compaction",
  id: "cmp-second",
  encrypted_content: "SECOND-OPAQUE",
};

export function accepted(
  item: CompactionItem = firstCompactionItem,
  usage?: Extract<DirectResponsesAttemptOutcome, { kind: "accepted" }>["usage"],
): DirectResponsesAttemptOutcome {
  return { kind: "accepted", item, ...(usage ? { usage } : {}) };
}

export function retryable(message = "transient", retryAfterMs = 0): DirectResponsesAttemptOutcome {
  return { kind: "retryable", error: new Error(message), retryAfterMs };
}

export function terminal(message = "terminal"): DirectResponsesAttemptOutcome {
  return { kind: "terminal", error: new Error(message) };
}

export function recordingAttempt(outcomes: DirectResponsesAttemptOutcome[]): {
  attempt: DirectResponsesAttempt;
  requests: RemoteCompactionRequest[];
  contexts: Parameters<DirectResponsesAttempt>[1][];
} {
  const requests: RemoteCompactionRequest[] = [];
  const contexts: Parameters<DirectResponsesAttempt>[1][] = [];
  const attempt: DirectResponsesAttempt = async (request, context) => {
    requests.push(request);
    contexts.push(context);
    const outcome = outcomes.shift();
    if (!outcome) throw new Error("recording attempt exhausted");
    return outcome;
  };
  return { attempt, requests, contexts };
}
