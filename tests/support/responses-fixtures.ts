import type {
  CompactionItem,
  RemoteCompactionAttempt,
  RemoteCompactionAttemptOutcome,
  RemoteCompactionRequest,
} from "../../src/remote-compaction-operation.ts";

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
  usage?: Extract<RemoteCompactionAttemptOutcome, { kind: "accepted" }>["usage"],
): RemoteCompactionAttemptOutcome {
  return { kind: "accepted", item, ...(usage ? { usage } : {}) };
}

export function retryable(message = "transient", retryAfterMs = 0): RemoteCompactionAttemptOutcome {
  return { kind: "retryable", error: new Error(message), retryAfterMs };
}

export function terminal(message = "terminal"): RemoteCompactionAttemptOutcome {
  return { kind: "terminal", error: new Error(message) };
}

export function recordingAttempt(outcomes: RemoteCompactionAttemptOutcome[]): {
  attempt: RemoteCompactionAttempt;
  requests: RemoteCompactionRequest[];
  contexts: Parameters<RemoteCompactionAttempt>[1][];
} {
  const requests: RemoteCompactionRequest[] = [];
  const contexts: Parameters<RemoteCompactionAttempt>[1][] = [];
  const attempt: RemoteCompactionAttempt = async (request, context) => {
    requests.push(request);
    contexts.push(context);
    const outcome = outcomes.shift();
    if (!outcome) throw new Error("recording attempt exhausted");
    return outcome;
  };
  return { attempt, requests, contexts };
}
