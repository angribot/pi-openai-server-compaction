import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attemptCodexResponsesOperation } from "./codex-responses-operation.ts";
import { attemptDirectResponsesOperation } from "./direct-responses-operation.ts";
import type { RemoteCompactionAttempt } from "./remote-compaction-operation.ts";
import { installRemoteCompaction } from "./remote-compaction.ts";

const attemptRemoteCompactionOperation: RemoteCompactionAttempt = (request, context) => {
  if (request.model.provider === "openai-codex" && request.model.api === "openai-codex-responses") {
    return attemptCodexResponsesOperation(request, context);
  }
  return attemptDirectResponsesOperation(request, context);
};

export default function openaiServerCompactionExtension(pi: ExtensionAPI): void {
  installRemoteCompaction(pi, attemptRemoteCompactionOperation);
}
