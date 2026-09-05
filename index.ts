import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attemptCodexResponsesOperation } from "./src/codex-responses-operation.ts";
import { attemptDirectResponsesOperation } from "./src/direct-responses-operation.ts";
import type { RemoteCompactionAttempt } from "./src/remote-compaction-operation.ts";
import { installRemoteCompaction, remoteCompactionOperationKind } from "./src/remote-compaction.ts";

const attemptRemoteCompactionOperation: RemoteCompactionAttempt = (request, context) => {
  if (remoteCompactionOperationKind(request.model) === "pi-codex-responses") {
    return attemptCodexResponsesOperation(request, context);
  }
  return attemptDirectResponsesOperation(request, context);
};

export default function openaiServerCompactionExtension(pi: ExtensionAPI): void {
  installRemoteCompaction(pi, attemptRemoteCompactionOperation);
}
