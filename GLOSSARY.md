# Remote Responses Compaction

This context covers replacing accumulated Pi conversation context with a server-produced Responses item and replaying it in later requests. It exists to preserve server-native conversation continuity.

The [technical reference](docs/reference.md) owns eligibility, persistence, retention, and transport policy.

## Language

**Remote compaction**:
A compaction operation performed by a Responses endpoint that replaces older conversation context with a server-produced compaction item.
_Avoid_: Server compaction, server-side compaction, Codex-style compaction

**Remote compaction v2**:
The Codex protocol that sends the current compactable context to `/responses` with one terminal, payload-free `compaction_trigger`, then uses the returned compaction item to form replacement history.
_Avoid_: `/responses/compact`, public compact endpoint, Remote compaction v1

**Remote compaction v1**:
The standalone `/responses/compact` protocol whose response supplies the next compacted context window, distinct from the v2 trigger protocol.
_Avoid_: Remote compaction v2

**Eligible model**:
A model that satisfies the extension's local conditions for attempting Remote compaction or Native replay. Eligibility is distinct from endpoint capability and replay compatibility.
_Avoid_: Supported provider, compatible model, v2-capable endpoint

**Remote compaction capability**:
The selected endpoint's runtime ability to accept a Remote compaction v2 request and return a compaction item.
_Avoid_: Eligible model, compatible model

**Compatible model**:
A target model locally permitted to attempt Native replay of a particular checkpoint. Local compatibility is not proof of backend interoperability.
_Avoid_: Eligible model, supported model

**Compaction item**:
The opaque Responses output item that retains pre-compaction conversation context for later native replay.
_Avoid_: Remote artifact, native artifact, opaque artifact

**Compactable context**:
The ordered, persisted, compaction-aware conversation context of the active session branch that a Remote compaction request replaces.
_Avoid_: Final provider payload, last observed request, effective context

**Replacement history**:
The complete replayable Responses item sequence installed by a successful Remote compaction and substituted for the replay replacement span during native replay.
_Avoid_: Remote history, explicit remote history, native replay history

**Native replay**:
Conversation continuation that submits replacement history to a compatible model instead of translating it into a portable text summary.
_Avoid_: Remote replay, artifact replay

**Checkpoint marker**:
Fixed human-readable text marking where detailed earlier context moved into replacement history. It identifies native replay state but does not summarize that context.
_Avoid_: Checkpoint summary, native replay checkpoint, portable summary

**Replay replacement span**:
The contiguous portion of an ordinary request's Responses input containing the checkpoint marker and Pi-retained pre-compaction entries, for substitution with replacement history.
_Avoid_: Checkpoint history, Historical replay span, Checkpoint region, Pre-compaction span (when referring to this exact provider-input region)

**Compaction compatibility class**:
An upstream opaque identifier grouping compaction-compatible model configurations, called `comp_hash` by OpenAI Codex.
_Avoid_: Model family, model hash, Model key

**Model key**:
The provider, API type, and request model ID together identifying a checkpoint's producer.
_Avoid_: Model ID, provider name, Compaction compatibility class

**Native replay checkpoint record**:
The durable local record binding replacement history to its producer's identity. It is distinct from the Remote compaction v2 wire protocol.
_Avoid_: Remote compaction version, v3 details, checkpoint summary

**Ordinary request**:
A model request that continues the conversation without asking the endpoint to compact it.
_Avoid_: Normal request, continuation request
