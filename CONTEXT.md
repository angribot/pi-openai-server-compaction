# Remote Responses Compaction

This context covers replacing accumulated Pi conversation context with a server-produced Responses item and replaying it in later requests. It exists to preserve server-native conversation continuity while keeping provider transport outside the extension.

## Language

**Remote compaction**:
A compaction operation performed by a Responses endpoint that replaces older conversation context with a server-produced compaction item.
_Avoid_: Server compaction, server-side compaction, Codex-style compaction

**Eligible model**:
A model whose API contract permits the extension to request remote compaction. Eligibility does not imply compatibility with an existing compaction item.
_Avoid_: Supported provider, compatible model

**Compatible model**:
A model with the same provider, API type, and model ID as the model that produced a compaction item. Only a compatible model can continue through native replay.
_Avoid_: Eligible model, supported model

**Compaction item**:
The opaque Responses output item that retains pre-compaction conversation context for later native replay.
_Avoid_: Remote artifact, native artifact, opaque artifact

**Replacement history**:
The replayable Responses item sequence produced by remote compaction, including the compaction item and any retained explicit items.
_Avoid_: Remote history, explicit remote history, native replay history

**Native replay**:
Conversation continuation that submits replacement history to a compatible model instead of translating it into a portable text summary.
_Avoid_: Remote replay, artifact replay

**Checkpoint marker**:
Fixed human-readable text marking where detailed earlier context moved into replacement history. It identifies native replay state but does not summarize that context.
_Avoid_: Checkpoint summary, native replay checkpoint, portable summary

**Model key**:
The provider, API type, and model ID considered together as the identity that determines native replay compatibility. Request-specific credentials and resolved endpoints are not part of this identity.
_Avoid_: Model ID, provider name

**Ordinary request**:
A model request that continues the conversation without asking the endpoint to compact it.
_Avoid_: Normal request, continuation request
