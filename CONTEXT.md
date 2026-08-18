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
A model selected for attempting Remote compaction v2 either by the exact `openai-responses` API contract, or by Pi's built-in `openai-codex` provider together with the exact `openai-codex-responses` API contract. Eligibility does not guarantee that the selected endpoint accepts the v2 trigger or that the model is compatible with an existing compaction item.
_Avoid_: Supported provider, compatible model, v2-capable endpoint

**Remote compaction capability**:
The selected endpoint's runtime ability to accept a Remote compaction v2 request and return a compaction item. Capability is discovered through the operation's outcome rather than inferred from provider identity.
_Avoid_: Eligible model, compatible model

**Compatible model**:
An Eligible model whose resolved Compaction compatibility class equals the checkpoint producer's creation-time class, or whose exact Model key matches when either class is unavailable. Class equality may cross Pi providers and the two Eligible Responses API types.
_Avoid_: Eligible model, supported model

**Compaction item**:
The opaque Responses output item that retains pre-compaction conversation context for later native replay.
_Avoid_: Remote artifact, native artifact, opaque artifact

**Compactable context**:
The ordered, Pi-persisted, compaction-aware context of the active linear session that a Remote compaction v2 request replaces. Repeated Remote compaction starts from the latest replacement history plus later session entries; ephemeral `context` or provider-payload middleware mutations are not part of this context.
_Avoid_: Final provider payload, last observed request, effective context

**Unrepresentable compactable context**:
Compactable context containing model-visible semantics that cannot be faithfully reconstructed as Responses input through Pi 0.84.2 public APIs. Its presence cancels Remote compaction rather than permitting silent omission, approximation, or partial replacement.
_Avoid_: Unsupported Pi context, unsupported context, unconvertible context

**Replacement history**:
The complete replayable Responses item sequence installed by a successful Remote compaction and substituted for the replay replacement span during native replay. In this project's minimum v2 contract it contains exactly the one opaque compaction item and no retained explicit items.
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
An opaque provider-resolved identifier grouping model configurations that can share compaction history; OpenAI Codex calls this `comp_hash`. It is distinct from Model key, provider routing identity, and ordinary Responses item metadata compatibility.
_Avoid_: Model family, model hash, Model key

**Model key**:
The provider, API type, and model ID considered together as this project's conservative Native replay compatibility boundary when either Compaction compatibility class is unavailable. Request-specific credentials and resolved endpoints are not part of this boundary.
_Avoid_: Model ID, provider name, Compaction compatibility class

**Native replay checkpoint record**:
The durable local record that binds replacement history to its producer's Model key and creation-time Compaction compatibility class. It is distinct from the Remote compaction v2 wire protocol.
_Avoid_: Remote compaction version, v3 details, checkpoint summary

**Compatibility decision record**:
Branch-local evidence of the selected target identity, resolved class, and compatibility decision for an Ordinary request from a class-aware checkpoint. Its following assistant outcome determines whether Native replay continuity remains valid.
_Avoid_: Compatibility cache, invalidation tombstone, model-change event

**Ordinary request**:
A model request that continues the conversation without asking the endpoint to compact it.
_Avoid_: Normal request, continuation request
