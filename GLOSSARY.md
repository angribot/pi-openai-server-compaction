# Remote Responses Compaction

This context covers replacing accumulated Pi conversation context with a server-produced Responses item and replaying it in later requests. It exists to preserve server-native conversation continuity while keeping provider transport outside the extension.

## Language

**Remote compaction**:
A compaction operation performed by a Responses endpoint that replaces older conversation context with a server-produced compaction item.
_Avoid_: Server compaction, server-side compaction, Codex-style compaction

**Remote compaction v2**:
The Codex protocol that sends the current compactable context to `/responses` with one terminal, payload-free `compaction_trigger`, then uses the returned compaction item to form replacement history.
_Avoid_: `/responses/compact`, public compact endpoint, Remote compaction v1

**Remote compaction v1**:
The standalone `/responses/compact` protocol whose response supplies the next compacted context window. It is distinct from the v2 trigger protocol and is not implemented by this project.
_Avoid_: Remote compaction v2

**Eligible model**:
A model permitted to attempt Remote compaction v2 with a valid nonempty provider identity, exact `openai-responses` or `openai-codex-responses` API, and a request model ID beginning with literal lowercase `gpt-`. Eligibility is provider-independent and does not prove endpoint capability.
_Avoid_: Supported provider, compatible model, v2-capable endpoint

**Remote compaction capability**:
The selected endpoint's runtime ability to accept a Remote compaction v2 request and return a compaction item. Capability is discovered through the operation's outcome rather than inferred from provider identity.
_Avoid_: Eligible model, compatible model

**Compatible model**:
An eligible target locally permitted to attempt Native replay of an eligible producer's checkpoint, subject to checkpoint integrity and branch continuity. This optimistic permission is not proof of backend interoperability across models or endpoints.
_Avoid_: Eligible model, supported model

**Compaction item**:
The opaque Responses output item that retains pre-compaction conversation context for later native replay.
_Avoid_: Remote artifact, native artifact, opaque artifact

**Compactable context**:
The ordered, Pi-persisted, compaction-aware context of the active linear session that a Remote compaction v2 request replaces. Repeated Remote compaction starts from the latest replacement history plus later session entries; ephemeral `context` or provider-payload middleware mutations are not part of this context.
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
The unique contiguous portion of an ordinary request's final Responses input that contains the checkpoint marker and Pi-retained pre-compaction entries. Native replay replaces only this span with replacement history so surrounding provider items remain unchanged.
_Avoid_: Checkpoint history, Historical replay span, Checkpoint region, Pre-compaction span (when referring to this exact provider-input region)

**Compaction compatibility class**:
An upstream opaque identifier grouping compaction-compatible model configurations, called `comp_hash` by OpenAI Codex. In this project it is historical checkpoint metadata, not a local replay permission boundary.
_Avoid_: Model family, model hash, Model key

**Model key**:
The provider, API type, and request model ID together identifying a checkpoint's producer. It is persisted identity, not a cross-model replay boundary; credentials and resolved endpoints remain routing data.
_Avoid_: Model ID, provider name, Compaction compatibility class

**Native replay checkpoint record**:
The durable local record binding replacement history to its producer's Model key and historical compatibility-class metadata. It is distinct from the Remote compaction v2 wire protocol.
_Avoid_: Remote compaction version, v3 details, checkpoint summary

**Ordinary request**:
A model request that continues the conversation without asking the endpoint to compact it.
_Avoid_: Normal request, continuation request
