import type { Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  compactionInstructions,
  hasActiveRemoteCompactionCheckpoint,
  prepareCompactionReplay,
  prepareNativeReplay,
  remoteCompactionOperationKind,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  resolveCodexCompactionCompatibilityClass,
  type BranchEntry,
  type CompactionCompatibilityResolver,
  type NativeReplayCheckpointDetails,
} from "./native-replay.ts";
import type {
  RemoteCompactionAttempt,
  RemoteCompactionAttemptOutcome,
  RemoteCompactionRequest,
} from "./remote-compaction-operation.ts";

export {
  NATIVE_REPLAY_CHECKPOINT_FORMAT,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  remoteCompactionOperationKind,
  resolveCodexCompactionCompatibilityClass,
  type CompactionCompatibilityResolver,
  type NativeReplayCheckpointDetails,
  type RemoteCompactionApi,
  type RemoteCompactionModelKey,
  type RemoteCompactionOperationKind,
} from "./native-replay.ts";

const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const BASE_RETRY_DELAY_MS = 200;

type HookContext = Pick<
  ExtensionContext,
  "model" | "hasUI" | "ui" | "getSystemPrompt" | "abort"
> & {
  modelRegistry: Parameters<RemoteCompactionAttempt>[1]["modelRegistry"];
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionId">;
};

function reportError(context: HookContext, message: string): void {
  if (context.hasUI) context.ui.notify(message, "error");
  else console.error(message);
}

function reportWarning(context: HookContext, message: string): void {
  if (context.hasUI) context.ui.notify(message, "warning");
  else console.warn(message);
}

function hardStop(context: HookContext, reason: string): undefined {
  reportError(
    context,
    `Remote compaction native replay stopped because ${reason}. Start a new session or return to a complete pre-checkpoint branch point.`,
  );
  context.abort();
  return undefined;
}

function retryDelay(
  outcome: Extract<RemoteCompactionAttemptOutcome, { kind: "retryable" }>,
  retry: number,
): number {
  if (typeof outcome.retryAfterMs === "number" && Number.isFinite(outcome.retryAfterMs)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, outcome.retryAfterMs));
  }
  const base = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.max(0, retry - 1));
  return Math.min(MAX_RETRY_DELAY_MS, Math.floor(base * (0.75 + Math.random() * 0.5)));
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function successResult(
  event: {
    preparation: { firstKeptEntryId: string; tokensBefore: number };
  },
  details: NativeReplayCheckpointDetails,
  accepted: Extract<RemoteCompactionAttemptOutcome, { kind: "accepted" }>,
): {
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    usage?: Usage;
    details: NativeReplayCheckpointDetails;
  };
} {
  return {
    compaction: {
      summary: REMOTE_COMPACTION_CHECKPOINT_MARKER,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      ...(accepted.usage ? { usage: accepted.usage } : {}),
      details,
    },
  };
}

export function installRemoteCompaction(
  pi: ExtensionAPI,
  attempt: RemoteCompactionAttempt,
  resolveCompatibilityClassForModel: CompactionCompatibilityResolver = resolveCodexCompactionCompatibilityClass,
): void {
  pi.on("session_before_compact", async (event, context) => {
    const model = context.model;
    if (!model || remoteCompactionOperationKind(model) === undefined) return undefined;
    if (event.signal.aborted) return { cancel: true };

    const branchEntries = event.branchEntries as BranchEntry[];
    const preparation = prepareCompactionReplay(
      branchEntries,
      model,
      resolveCompatibilityClassForModel,
    );
    if (preparation.kind === "invalid-model") {
      reportError(context, "Remote compaction requires a non-empty structured model identity.");
      return { cancel: true };
    }
    if (preparation.kind === "class-unavailable") {
      // No catalogued Compaction compatibility class: leave this model to Pi's
      // default compaction instead of attempting a null-class Remote compaction.
      return undefined;
    }
    if (preparation.kind === "broken") {
      reportError(context, `Remote compaction was cancelled because ${preparation.reason}.`);
      return { cancel: true };
    }
    if (preparation.kind === "invalidated") {
      reportError(
        context,
        "Remote compaction was cancelled because a persisted incompatible assistant turn invalidated native replay.",
      );
      return { cancel: true };
    }
    if (preparation.kind === "incompatible") {
      reportWarning(
        context,
        "Remote compaction was cancelled because the selected model is incompatible with the active checkpoint.",
      );
      return { cancel: true };
    }

    let request: RemoteCompactionRequest;
    try {
      // Remote compaction is a Responses protocol operation, not a model turn.
      // Do not send Pi's active tools: some built-in tool schemas use regex
      // lookaround, which OpenAI's Responses schema validator rejects.
      request = {
        model,
        input: preparation.buildInput(),
        instructions: compactionInstructions(
          branchEntries,
          model,
          event.customInstructions,
          context.getSystemPrompt(),
        ),
      };
    } catch (error) {
      if (!event.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(context, `Remote compaction preparation failed. ${message}`);
      }
      return { cancel: true };
    }

    for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex++) {
      if (event.signal.aborted) return { cancel: true };
      let outcome: RemoteCompactionAttemptOutcome;
      try {
        outcome = await attempt(request, {
          modelRegistry: context.modelRegistry,
          sessionId: context.sessionManager.getSessionId(),
          signal: event.signal,
        });
      } catch (error) {
        if (!event.signal.aborted) {
          reportError(
            context,
            `Remote compaction operation failed unexpectedly. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return { cancel: true };
      }

      if (event.signal.aborted) return { cancel: true };
      if (outcome.kind === "accepted") {
        return successResult(event, preparation.createCheckpointDetails(outcome.item), outcome);
      }
      if (outcome.kind === "terminal" || attemptIndex === MAX_ATTEMPTS - 1) {
        reportError(
          context,
          `Remote compaction failed; no text fallback was used. ${outcome.error.message}`,
        );
        return { cancel: true };
      }

      try {
        await abortableDelay(retryDelay(outcome, attemptIndex + 1), event.signal);
      } catch {
        return { cancel: true };
      }
    }

    return { cancel: true };
  });

  pi.on("cache_warming_decision", (_event, context) => {
    // A Remote compaction checkpoint owns context that Native replay must
    // reconstruct. Pi's warmer re-runs before_provider_request during a refresh
    // with its own abort controller, so the replay hook's fail-closed abort
    // cannot stop that refresh. Stop it here, before provider dispatch, instead.
    //
    // Protection is deliberately independent of model eligibility: it follows
    // the active branch, so a malformed, invalidated, incompatible, or legacy
    // checkpoint is protected too, and no replay or warming state is cached.
    const branch = context.sessionManager.getBranch();
    return hasActiveRemoteCompactionCheckpoint(branch) ? { action: "stop" } : undefined;
  });

  pi.on("before_provider_request", (event, context) => {
    const model = context.model;
    if (!model) return undefined;

    const branch = context.sessionManager.getBranch();
    const preparation = prepareNativeReplay(branch, model, resolveCompatibilityClassForModel);
    if (preparation.kind === "none") return undefined;
    if (preparation.kind === "broken") return hardStop(context, preparation.reason);
    if (preparation.kind === "invalidated") {
      return hardStop(
        context,
        "a persisted incompatible assistant turn invalidated the checkpoint",
      );
    }
    if (preparation.kind === "invalid-model") {
      return hardStop(context, "the selected model has an invalid structured identity");
    }
    if (preparation.kind === "incompatible") {
      reportWarning(
        context,
        "The selected model is incompatible with the active Remote compaction checkpoint. Pre-checkpoint context is unavailable; a successful assistant turn will invalidate native replay for this branch.",
      );
      return undefined;
    }

    const rewrite = preparation.rewrite(event.payload);
    if (rewrite.kind === "patched") return rewrite.payload;
    if (rewrite.kind === "payload-not-full-array") {
      return hardStop(
        context,
        "the ordinary request does not contain a full-array Responses input",
      );
    }
    if (rewrite.kind === "span-unavailable") {
      return hardStop(
        context,
        "the replay replacement span could not be reconstructed from the active branch",
      );
    }
    return hardStop(context, "the replay replacement span was missing or ambiguous");
  });
}
