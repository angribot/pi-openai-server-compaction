import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attemptDirectResponsesOperation } from "./direct-responses-operation.ts";
import { installRemoteCompaction } from "./remote-compaction.ts";

export default function openaiServerCompactionExtension(pi: ExtensionAPI): void {
  installRemoteCompaction(pi, attemptDirectResponsesOperation);
}
