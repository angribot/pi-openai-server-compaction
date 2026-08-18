# Research: current Codex remote compaction v2 contract

Status: factual research for [issue #36](https://github.com/angribot/pi-openai-server-compaction/issues/36), under [map #35](https://github.com/angribot/pi-openai-server-compaction/issues/35). This document records evidence for a later human decision. It does not propose or implement a refactor.

## Executive summary

At the upstream pin inspected here, Codex's **remote compaction v2** is an internal client flow over the normal Responses create route, not the standalone public compact endpoint:

1. Codex takes the current model-facing history, performs a best-effort rewrite of trailing oversized tool outputs, appends exactly one `{ "type": "compaction_trigger" }`, and sends the result through its ordinary `/responses` request builder.
2. The operation is accepted only after the stream reaches `response.completed` and exactly one `compaction` output item was observed. Other completed output items may be present and are ignored. The compaction item is opaque replay state; Codex does not turn it into text.
3. Codex itself constructs replacement history from selected explicit input items plus the returned compaction item. The current retention policy is a newest-first 64,000 approximate-token budget over real user/hook messages, selected agent messages, their attached notices, and optionally client-authored developer messages. That exact selection and budget are client policy, not demonstrated wire requirements.
4. On success, Codex atomically replaces live history and persists the full replacement history as a compaction checkpoint. Reload/resume finds the newest surviving checkpoint, uses its replacement history as the complete base, and replays later rollout items. Later requests therefore continue by replaying replacement history plus new items; `previous_response_id` is an optional transport optimization, not required to stateless array replay.
5. Repeated compaction sends the current replacement history and post-compaction tail back through the same flow. The newly returned compaction item replaces the older compaction item in the next replacement history; the older item is not explicitly retained.
6. Codex retries retryable request/stream failures as whole requests and discards outputs from failed attempts. The remote-v2 stream retry layer is capped at two retries, but the HTTP request layer has a separate provider-configured retry budget, and WebSocket-to-HTTP fallback can add another transport path. The semantic invariant is atomic install after one successful validated attempt, not an exact universal attempt count.
7. A compaction input still has to fit the model context. Codex currently only rewrites a contiguous trailing run of function/custom-tool/tool-search outputs; if that is insufficient, it sends the request and may receive a fatal context-window error. It does not implement the repository's broader policy of deleting oldest history groups and truncating a boundary message.
8. In the selected v2 path, a terminal compaction failure stops that compaction/turn and does not fall back to local text compaction or persist partial replacement history. A normal sampling context-overflow error is surfaced and marks the context full; Codex does not automatically retry the same failed sample after compaction.

The most important classification result is:

- **Semantic core:** terminal trigger over current replayable context; completed response with exactly one opaque compaction item; client-defined replacement history that includes that item; exact replay/persistence of the installed replacement history; latest-checkpoint semantics for repeat/reload; atomic success; terminal failure without partial install.
- **Semantically relevant ordinary request context, but not v2-specific wire contract:** model, effective instructions, input items, and model-visible tool definitions. Omitting them can change what gets compacted, but Codex's exact serialization is not a compatibility target.
- **Policy, not protocol:** which explicit items to retain, the 64K budget, tool-output trimming strategy, retry classes/counts, model fallback, and validation stricter than “one deserializable compaction item.”
- **Incidental/transport/telemetry:** streaming versus unary transport, HTTP versus WebSocket, `store`, encrypted-reasoning `include`, prompt cache key, service tier, client metadata, Codex identity/window/turn headers, beta-feature advertisement, usage accounting, response ID, request tracing, and UI lifecycle events.

A material external fact is that the current official OpenAI compaction guide documents `context_management` and `POST /responses/compact`, not `compaction_trigger`. The public standalone endpoint returns a canonical compacted window that clients are told to replay **as-is**. Codex remote v2 instead receives one compaction item and constructs a retained window client-side. Therefore “current Codex v2 behavior” and “current officially documented public compaction contract” are related but distinct targets.

## Research pin and scope

| Item | Recorded value |
|---|---|
| Upstream repository | [`openai/codex`](https://github.com/openai/codex) |
| Default branch observed | `main` |
| Exact commit | [`ede5247893a50297a47c9aa5038e6ab28312ff50`](https://github.com/openai/codex/commit/ede5247893a50297a47c9aa5038e6ab28312ff50) |
| Commit time | `2026-08-18T01:00:48Z` |
| Retrieval time | `2026-08-18T02:23:56Z` |
| Current-repo comparison pin | [`558bc16f9819afff04127b45a760d9f422579f36`](https://github.com/angribot/pi-openai-server-compaction/commit/558bc16f9819afff04127b45a760d9f422579f36) (`0.7.0`) |
| Official docs accessed | `2026-08-18` |

The upstream pin was the latest reachable `main` commit returned by GitHub when research began. All GitHub source links below are commit-pinned. Official documentation links are live pages and are therefore not immutable; the access date above is part of the evidence record.

Scope follows map #35: linear continuation, reload/resume, and repeated compaction are core. Fork/tree/model-switch matrices, provider-aware transport, Codex telemetry/client metadata parity, and old repository persisted version 1 compatibility are not treated as product commitments.

## Evidence table

| Area | Factual finding | Classification | Primary evidence |
|---|---|---|---|
| Protocol selection | Codex distinguishes v1 (`/responses/compact`) from v2 (normal Responses plus trigger). Provider capability and a feature flag select the v2 implementation. | Selection policy, not response semantics | [`model-provider/src/provider.rs` L30-L38](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/model-provider/src/provider.rs#L30-L38), [`core/src/session/turn.rs` L1183-L1223](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/turn.rs#L1183-L1223) |
| Trigger construction | V2 starts from prompt-formatted current history and appends one payload-free `CompactionTrigger`; the trigger is removed before retained-input history is processed. | **Semantic core** | [`core/src/compact_remote_v2_attempt.rs` L41-L91](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2_attempt.rs#L41-L91), [L117-L139](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2_attempt.rs#L117-L139), [`protocol/src/models.rs` L1148-L1160](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/protocol/src/models.rs#L1148-L1160) |
| Request body | The ordinary builder supplies model, instructions, input, tools, `tool_choice: auto`, parallel tool calls, reasoning, `store: false`, `stream: true`, encrypted-reasoning include, service tier, prompt cache key, text controls, and client metadata. | Model/instructions/input/tools are semantically relevant; the rest is parity/quality/transport/metadata | [`core/src/client.rs` L844-L950](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/client.rs#L844-L950) |
| Endpoint/transport | V2 uses the ordinary `/responses` stream path and can run over WebSocket or HTTP with transport fallback. | Transport detail | [`core/src/client.rs` L1439-L1561](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/client.rs#L1439-L1561), [L1847-L1914](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/client.rs#L1847-L1914) |
| Completed response | Codex rejects a stream that closes before `response.completed`. | **Semantic core** for this streamed implementation | [`core/src/compact_remote_v2.rs` L400-L438](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L400-L438) |
| Output count | Exactly one `ResponseItem::Compaction` must be observed; zero or multiple is fatal. | **Semantic core** | [`core/src/compact_remote_v2.rs` L400-L456](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L400-L456) |
| Additional outputs | Output items other than the one compaction item are counted but ignored; a regression test deliberately accepts an assistant item before compaction and excludes it from follow-up history. | Incidental outputs, not replacement history | [`core/src/compact_remote_v2.rs` L403-L429](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L403-L429), [`core/tests/suite/compact_remote.rs` L1670-L1748](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/tests/suite/compact_remote.rs#L1670-L1748) |
| Compaction-item shape | The upstream type requires string `encrypted_content`, permits an optional ID and internal passthrough metadata, and aliases legacy `compaction_summary` to the same variant. The collector does not explicitly reject an empty string. | `type` plus opaque content is core; ID/metadata/alias and non-empty strictness are compatibility/validation policy | [`protocol/src/models.rs` L1147-L1164](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/protocol/src/models.rs#L1147-L1164), [`core/src/compact_remote_v2.rs` L400-L456](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L400-L456) |
| Replacement-history construction | Codex does not install the whole stream output. It filters selected original prompt items, truncates retained explicit messages to 64K approximate tokens, then appends the new compaction item last. | **Core shape**; exact filters/budget are policy | [`core/src/compact_remote_v2.rs` L459-L510](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L459-L510), [L512-L587](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L512-L587) |
| Explicit retained items | Current filters retain real user/hook messages, selected non-final agent messages no larger than 10K estimated tokens, attached notices, and optionally client-authored developer messages. Ordinary system/developer/assistant/tool/reasoning/old-compaction items are not generally retained. | Codex client policy; only applicable Pi item classes matter to this project | [`core/src/compact_remote_v2.rs` L471-L535](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L471-L535), [`core/src/compact_remote.rs` L354-L396](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote.rs#L354-L396) |
| Retention order | Retention walks item groups newest-to-oldest, preserves group adjacency, may truncate the oldest surviving boundary message, and restores chronological order. | Policy, not wire contract | [`core/src/compact_remote_v2.rs` L541-L587](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L541-L587) |
| Atomic install | History replacement and persisted `CompactedItem` creation occur only after request success, validation, replacement-history construction, and optional context reinjection. | **Semantic core** | [`core/src/compact_remote_v2.rs` L211-L341](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L211-L341), [`core/src/session/mod.rs` L3323-L3367](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/mod.rs#L3323-L3367) |
| Persisted state | The checkpoint persists the complete replacement history, window identifiers, and an empty text message for remote compaction. Missing item IDs are assigned before live and persisted histories are installed. | Replacement-history persistence is core; window IDs/item IDs are Codex persistence detail | [`core/src/session/mod.rs` L3323-L3367](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/mod.rs#L3323-L3367) |
| Reload/resume | Reconstruction scans newest-to-oldest for the newest surviving checkpoint, treats its replacement history as a complete base, then replays only the later suffix. A focused test expects replacement history verbatim. | **Semantic core** | [`core/src/session/rollout_reconstruction.rs` L111-L188](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/rollout_reconstruction.rs#L111-L188), [L320-L389](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/rollout_reconstruction.rs#L320-L389), [`core/src/session/tests.rs` L2020-L2069](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/tests.rs#L2020-L2069) |
| Replay/continuation | Subsequent prompts are built from replaced live history. HTTP stateless replay does not require `previous_response_id`; WebSocket may use it incrementally when request properties and cached state permit. | Full replacement-history replay is core; previous ID is transport optimization | [`core/src/client.rs` L308-L355](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/client.rs#L308-L355), [L1847-L1914](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/client.rs#L1847-L1914), [official WebSocket guide](https://developers.openai.com/api/docs/guides/websocket-mode) |
| Repeated compaction | The next compact request begins from current live history, which already contains replacement history and newer items. The previous compaction item is input to the request but is filtered out of the newly installed explicit retention; only the new compaction item is appended. | **Semantic core** latest-checkpoint behavior | [`core/src/compact_remote_v2_attempt.rs` L41-L84](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2_attempt.rs#L41-L84), [`core/src/compact_remote_v2.rs` L459-L535](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L459-L535) |
| Request overflow prevention | Before compacting, Codex estimates instructions plus grouped history and rewrites only a contiguous trailing sequence of function/custom-tool/tool-search outputs. It stops at the first non-rewritable trailing group, even if still oversized. | Client policy; input-fit-or-fail is semantic | [`core/src/compact_remote.rs` L399-L509](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote.rs#L399-L509) |
| Context overflow | A normal sampling `ContextWindowExceeded` marks token usage full and returns the error. A pre-turn/mid-turn compaction failure stops the turn; the same failed sample is not automatically retried after compaction. | Failure semantics | [`core/src/session/turn.rs` L440-L480](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/turn.rs#L440-L480), [L1000-L1025](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/turn.rs#L1000-L1025), [L1382-L1391](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/turn.rs#L1382-L1391) |
| Stream retry | Retryable v2 stream failures retry the whole operation with a cap of `min(provider stream retries, 2)`; failed partial compaction output is not installed. | Atomic whole-attempt retry is core; count/backoff is policy | [`core/src/compact_remote_v2.rs` L350-L398](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L350-L398), [`core/tests/suite/compact_remote.rs` L1570-L1668](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/tests/suite/compact_remote.rs#L1570-L1668) |
| Layered retry | Request-open retries are separate from stream retries. 503 overload is retried by the HTTP layer according to provider budget; rate-limit stream errors can retry and can use delay advice embedded in the error message. | Transport/retry policy | [`core/tests/suite/retry_after.rs` L388-L455](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/tests/suite/retry_after.rs#L388-L455), [L535-L622](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/tests/suite/retry_after.rs#L535-L622), [L773-L877](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/tests/suite/retry_after.rs#L773-L877) |
| Terminal error classes | Fatal, quota, invalid request, policy, context-window, usage-limit, and server-overloaded semantic errors are not stream-retryable after API error mapping. | Error classification policy | [`protocol/src/error.rs` L364-L405](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/protocol/src/error.rs#L364-L405) |
| Failure/no fallback | Once the v2 path is selected, an unrecovered error propagates; history install is not reached. Selection can choose legacy remote/local implementations in other capability configurations, but that is not fallback after a failed v2 attempt. | **Semantic core for selected path** | [`core/src/compact_remote_v2.rs` L131-L209](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L131-L209), [`core/src/session/turn.rs` L1183-L1236](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/turn.rs#L1183-L1236) |
| Abort | A stopped pre-compact hook aborts before the request. Ordinary task cancellation/abort prevents reaching install. A stopped post-compact hook occurs after successful install and does not roll history back. | Codex hook/UI lifecycle, not v2 wire semantics; atomicity caveat | [`core/src/compact_remote_v2.rs` L131-L209](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L131-L209), [L211-L341](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs#L211-L341) |
| Metadata | Trigger/reason/implementation/phase/strategy, installation/session/thread/window IDs, workspaces, sandbox, and related values are explicitly assembled as request metadata and analytics dimensions. | Telemetry/client metadata, outside semantic core | [`core/src/responses_metadata.rs` L88-L158](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/responses_metadata.rs#L88-L158), [L196-L275](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/responses_metadata.rs#L196-L275) |
| Official public contract | Current official docs describe automatic `context_management` and standalone `/responses/compact`. Standalone output is the canonical next context window and must be replayed as-is; the input must still fit the context window. | Separate public contract, not Codex v2 trigger contract | [OpenAI Compaction guide](https://developers.openai.com/api/docs/guides/compaction), [Compact API reference](https://developers.openai.com/api/reference/resources/responses/methods/compact/) |

## Actual upstream v2 flow

### 1. Trigger and request construction

Manual compaction captures a fresh step context; automatic compaction reuses the current step context. Both enter the same v2 inner flow with operation metadata such as manual/automatic trigger and phase. Those values drive hooks, analytics, and request metadata but do not change the `compaction_trigger` item itself.

The request attempt:

1. clones current live history;
2. obtains the session's base instructions;
3. runs the best-effort tool-output rewrite described under overflow below;
4. formats history for the selected model's input modalities;
5. appends one payload-free `CompactionTrigger`;
6. builds an ordinary prompt with current model-visible tools, `parallel_tool_calls: true`, no output schema, and base instructions;
7. routes it through the ordinary Responses request builder.

The ordinary request builder adds many fields because Codex intentionally reuses normal sampling infrastructure. Their presence does not by itself make them part of the minimum compaction protocol.

#### Minimum request fact

The mechanically supported minimum is:

- a selected model;
- the model-facing context to compact;
- a terminal `{ "type": "compaction_trigger" }` request control;
- enough ordinary semantic context to preserve the meaning of that input, especially effective instructions and referenced tool definitions.

The source does **not** demonstrate that exact Codex headers, client metadata, cache key, service tier, verbosity, reasoning summary mode, tool-choice value, stream options, or identity fields are required for a server to perform compaction. Some may affect quality, routing, billing, or endpoint enablement, but they are not replay semantics.

### 2. Response collection and validation

Codex consumes streamed Responses events and only gives special meaning to:

- `response.output_item.done` containing a `compaction` item;
- `response.completed`, from which it records response ID and optional token usage.

Success requires both completion and exactly one compaction item. Additional output items are deliberately tolerated and ignored. Usage and response ID are surfaced to accounting/events but are not installed into replacement history.

The current upstream validation boundary is narrower than this repository's:

- Rust deserialization requires `encrypted_content` to be a string.
- The collector checks only variant/count/completion.
- It does not explicitly require non-empty encrypted content.
- It does not require the server to supply a compaction item ID before install; Codex can assign missing item IDs during persistence.

Therefore “non-empty ciphertext” is reasonable defensive validation, but it is not established as required by the inspected Codex implementation.

### 3. Replacement history and retained explicit items

V2 differs from the public standalone endpoint. Codex does not receive and adopt a canonical output window. It receives the compaction item and constructs a window locally:

```text
selected explicit items from request input
+ exactly one newly returned compaction item
```

Current explicit-retention policy:

- retain real user messages and persisted hook prompts;
- preserve attached notices grouped with a retained source item;
- retain non-final `agent_message` items only if each is at most 10K estimated tokens;
- optionally retain client-authored developer messages behind a separate feature;
- reject ordinary developer, system, assistant-message, tool, reasoning, web/image-call, and old compaction items from explicit retention;
- apply a shared 64K approximate-token cap newest-first, possibly truncating the oldest surviving message;
- append the new compaction item last.

Two distinctions matter for the later decision:

1. **The replacement-history concept and preserving the returned compaction item are semantic.** Without them, continuation/reload cannot reproduce the compacted state.
2. **The exact retained classes and 64K cap are Codex product policy.** They are not encoded by `compaction_trigger`, and the official standalone contract follows a different rule: replay the server-returned canonical window as-is.

For Pi's scoped linear lifecycle, real user messages are the directly relevant overlap. Codex-specific `agent_message`, hook metadata, image-resize notices, and client-authored developer-message features are not automatically requirements for this project.

### 4. Atomic replacement and persistence

Only after successful request collection and validation does Codex:

1. build replacement history;
2. optionally inject fresh current context required by its mid-turn lifecycle;
3. advance its compaction-window identifiers;
4. replace live history;
5. persist a `CompactedItem` containing the same replacement history;
6. recompute token usage;
7. emit compaction completion.

There is no call to `replace_compacted_history` on a failed attempt. Failed partial output from a retry is discarded. This is the strongest mechanically established failure invariant and directly supports the map's standing decision: no partial replacement-history persistence and no text fallback after a failed selected v2 operation.

Codex's persisted checkpoint also contains window IDs, harness metadata sidecars, and generated item IDs. Those support Codex's broader rollout, tracing, fork, and world-state systems. The semantic persistence requirement is only that the latest successful replacement history can be recovered exactly and distinguished from older superseded history.

### 5. Replay, continuation, and reload

Live continuation is straightforward after history replacement: the next sampling prompt is built from replacement history plus later recorded items.

Cold reload/resume scans persisted rollout records newest-to-oldest. The newest surviving compaction checkpoint with replacement history becomes a complete base; older history cannot affect the rebuilt model context. Later rollout items are then replayed forward. An upstream test explicitly requires replacement history to be used verbatim.

This establishes the minimum reload assumption:

- persisted replacement history must be complete, ordered, and losslessly recoverable;
- the latest successful checkpoint supersedes older pre-checkpoint history;
- post-checkpoint items must remain appendable after reload.

It does **not** establish a need for the repository's current `modelKey`, provider key, fixed text marker, version-1 schema, or Codex window identifiers. Those are project/Codex persistence adapters around the core state.

For continuation transport, full-array stateless replay is sufficient. Official docs also recognize `previous_response_id` chaining, and Codex may use it on an active WebSocket. Neither the v2 collector nor persisted replacement history depends on a response ID. A cold reload with `store: false` necessarily relies on full replacement history rather than ephemeral previous-response state.

### 6. Repeated compaction

After one successful compaction, live history contains retained explicit items and the newest compaction item. New user/assistant/tool items are appended normally. A second compaction clones that current history and appends a fresh trigger.

When constructing the second replacement history:

- user/other eligible explicit items can be retained again;
- the old compaction item is not in the explicit retention set;
- the newly returned compaction item is appended last;
- the second persisted checkpoint becomes the newest complete base.

Thus repeated compaction is a linear “latest checkpoint replaces previous base” lifecycle. It is not a tree merge and does not require maintaining every prior compaction item after the new item has summarized the current compacted window.

### 7. Overflow behavior

There are two distinct overflow moments.

#### Before the compaction request

Codex estimates base instructions plus grouped history. If oversized, it walks groups from newest to oldest and rewrites only a contiguous trailing run of eligible outputs:

- function-call output becomes `Output exceeded the available model context and was truncated`;
- custom-tool output gets the same replacement text;
- tool-search output keeps status/execution but replaces its tools list with an empty list.

The walk stops when the context estimate fits **or** the next trailing group is not rewritable. Codex does not then delete arbitrary oldest history groups or truncate a user-message boundary. The request may still be oversized and fail at the server.

#### During ordinary sampling

If an ordinary request receives `ContextWindowExceeded`, Codex marks total tokens as full and returns the error. Automatic compaction is normally triggered proactively from token status before a turn or between model/tool follow-ups. It is not a generic catch-and-retry wrapper around the same overflowing sampling request.

Therefore the semantic fact is “a compaction request must fit or fail without corrupting history.” The exact local strategy for making it fit is not fixed by v2.

### 8. Retry, failure, and abort

#### Retry

Codex has layered retry behavior:

- the API client's HTTP request layer can retry request-open failures according to provider configuration;
- the remote-v2 stream layer retries retryable stream/collection failures with `min(provider_stream_max_retries, 2)`;
- after exhaustion, a WebSocket session may switch to HTTP and reset the stream retry counter;
- retry delay can come from mapped error detail or local backoff; current tests note that the outer HTTP `Retry-After` header is not always honored by the stream layer.

Every retry reruns the compaction request. No partial output from an unsuccessful attempt enters replacement history.

The exact “two retries” phrase is therefore only true for one layer, not the whole operation.

#### Terminal failure

Non-retryable errors, retry exhaustion, malformed response, missing completion, zero/multiple compaction items, and context overflow propagate as operation failure. In automatic mid-turn/pre-turn paths, that ends the current turn without issuing the intended post-compaction sample. In the chosen v2 path, Codex does not then invoke local text compaction.

#### Abort

A pre-compact hook can stop before any request. Runtime cancellation/turn abort similarly prevents the success path from installing history. A Codex-specific post-compact hook runs after replacement history has already been installed; if it stops, the task reports abort but does not roll back the successful checkpoint. Pi does not have to reproduce this hook ordering to reproduce v2 replay semantics.

## Semantic core versus incidental classification

### Required to preserve remote compaction v2 semantics

1. **Request-control discriminator:** submit a terminal `compaction_trigger` with no synthetic ciphertext payload.
2. **Current compactable context:** submit the ordered model-facing history that is intended to become the next compacted state. If the client already has replacement history, that history is part of the input to the next compaction.
3. **Effective semantic context:** preserve instructions and tool definitions when their omission would alter the interpretation of input items. This is ordinary prompt fidelity, not field-for-field Codex compatibility.
4. **Successful-response boundary:** do not install from a partial/failed/incomplete operation; in Codex's stream implementation, require `response.completed`.
5. **Unique compaction output:** accept exactly one compaction item as the opaque state carrier. Ignore unrelated output items rather than replaying them accidentally.
6. **Opaque preservation:** retain the compaction item without translating, summarizing, or editing its encrypted content.
7. **Replacement-history installation:** build or receive a canonical ordered next history containing the compaction item and any intentionally retained explicit items, then replace older live history with it.
8. **Atomicity:** install/persist once, only after validation. Failed retries and terminal failures must leave the prior successful history authoritative.
9. **Stateless replay:** later ordinary requests must be able to send replacement history plus later turns as a full input array. `previous_response_id` cannot be the only state.
10. **Reload/resume:** persist enough to recover the newest successful replacement history exactly and append the post-checkpoint suffix.
11. **Repeated compaction:** compact the current replacement base plus newer items and make the new successful checkpoint supersede the old base.
12. **Overflow failure safety:** if the complete compaction request cannot fit, fail without partial replacement or silent fallback to incompatible text state.

### Semantically relevant but product-policy choices

| Choice | Upstream observation | Why it is not mechanically required by v2 |
|---|---|---|
| Explicit retained item classes | Real user/hook messages, selected agent messages/notices, optional client developer messages | The trigger protocol does not encode this list; other clients and the official standalone endpoint use different window construction |
| 64K retained-message budget | Current Codex constant mirrors its compact-endpoint retained-message default | A quality/cost/latency choice; no server validation depends on it |
| Oldest boundary truncation | Codex truncates the oldest selected retained message when filling the 64K budget | Replacement-history policy after successful compaction |
| Pre-request overflow trimming | Codex rewrites only trailing tool outputs | A best-effort client strategy; endpoint only requires fit |
| Retry classes and exact counts | Separate HTTP and stream budgets; stream cap of two; optional transport fallback | Availability/latency policy, not replay correctness |
| Reasoning effort/summary and verbosity | Copied from the turn/model configuration | Can affect output quality/cost but not the meaning of a valid compaction item after it is returned |
| Custom compaction guidance | Not present as a separate Codex v2 field at the pin | A Pi/project product feature, not upstream contract |
| Strict non-empty ciphertext validation | Repository enforces it; upstream collector does not explicitly do so | Defensive validation beyond inspected source contract |
| Model compatibility key | Repository persists provider/API/model identity; upstream checkpoint does not | A project policy for preventing cross-model opaque replay; model-switch behavior is outside this map's core lifecycle |

### Telemetry, client metadata, transport, or incidental parity

The following observed Codex values are not necessary to the scoped semantic contract unless independent endpoint evidence proves otherwise:

- `x-codex-installation-id`, session/thread/window/turn IDs;
- `x-codex-turn-metadata` and body `client_metadata`;
- compaction trigger/reason/implementation/phase/strategy analytics values;
- `x-codex-beta-features: remote_compaction_v2` as a Codex feature-advertisement detail;
- prompt cache key;
- service tier;
- usage accounting and response ID;
- request tracing and rollout-trace checkpoint IDs;
- HTTP/SSE versus WebSocket transport, compression, sticky turn-state headers, and WebSocket-to-HTTP fallback;
- `store: false` as a ZDR/persistence choice;
- `stream: true` as Codex's collection method;
- `include: ["reasoning.encrypted_content"]`, because v2 history installation ignores non-compaction output from this operation;
- `tool_choice: "auto"` and `parallel_tool_calls` exact values;
- generated provider item IDs and Codex harness metadata sidecars;
- UI `ContextCompaction` started/completed events and compact hooks;
- model fallback during model-switch/downshift paths.

Caution: “incidental to replay semantics” does not prove an undocumented endpoint will accept a request without every header. In particular, the beta-feature header may have deployment-gating significance. The source only establishes that Codex sends it, not whether it is required by the server. That uncertainty belongs to endpoint capability/transport research, which map #35 places outside this task's core target.

## Comparison with the current repository

Comparison links below use repository commit [`558bc16`](https://github.com/angribot/pi-openai-server-compaction/commit/558bc16f9819afff04127b45a760d9f422579f36).

### Agreements with the upstream semantic core

| Repository behavior | Comparison |
|---|---|
| Builds a normal Responses body ending in one `compaction_trigger` | Agrees. [`src/remote-compaction.ts` L1009-L1031](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/remote-compaction.ts#L1009-L1031) |
| Requires completed SSE and exactly one compaction item | Agrees. [`src/remote-compaction.ts` L1439-L1501](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/remote-compaction.ts#L1439-L1501) |
| Ignores unrelated output items | Agrees with the upstream acceptance test. |
| Constructs replacement history from retained explicit user messages plus the new compaction item | Agrees with the relevant Pi subset of current upstream policy. [`src/remote-compaction.ts` L849-L865](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/remote-compaction.ts#L849-L865) |
| Uses a 64K newest-first retained-message budget | Matches current upstream policy, though this is policy rather than protocol. |
| Includes prior replacement history in a later compaction input and drops the old compaction from the newly built history | Agrees with linear repeated-compaction semantics. [`src/index.ts` L225-L245](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/index.ts#L225-L245) |
| Persists replacement history in Pi compaction details and reconstructs it after session lifecycle events | Agrees with the reload/resume requirement through a Pi-specific persistence adapter. [`src/remote-compaction.ts` L1775-L1839](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/remote-compaction.ts#L1775-L1839), [`src/index.ts` L176-L204](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/index.ts#L176-L204) |
| Replays replacement history in later full Responses input and removes stale `previous_response_id` | Agrees with stateless replay; narrower span-patching is a Pi composition mechanism, not Codex parity. [`src/openai.ts` L132-L159](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/openai.ts#L132-L159) |
| Retries whole requests, ignores failed partial outputs, and only returns successful replacement history | Agrees with atomic retry semantics. [`src/remote-compaction.ts` L1745-L1773](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/remote-compaction.ts#L1745-L1773) |
| On terminal failure, cancels Pi compaction instead of invoking text fallback | Agrees with the selected v2 path and map standing decision. [`src/index.ts` L288-L301](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/index.ts#L288-L301) |
| Gates project eligibility on exact `openai-responses` API | Intentional project policy from ADR 0001, not upstream parity. [`src/openai.ts` L52-L54](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/openai.ts#L52-L54) |

### Unsupported assumptions or incidental parity in the repository

1. **Codex identity and feature headers are not replay semantics.** The repository creates/reads a Codex installation ID and sends Codex identity/window headers plus `x-codex-beta-features`. Upstream classifies most of the corresponding information as metadata. These fields may be endpoint-gating hints, but source evidence does not make them semantic requirements.
2. **The fixed Pi checkpoint marker is project-specific.** Upstream remote v2 persists an empty compaction text message and the replacement history. It does not create a second human-readable checkpoint summary. The marker can be a Pi adapter, but should not be described as Codex-required semantics.
3. **The persisted `modelKey` is project policy.** Upstream persists replacement history without the repository's provider/API/model compatibility key. Strict compatibility may be prudent, but it is not established by the current upstream checkpoint contract.
4. **Custom compaction guidance is not upstream v2 parity.** The repository appends `event.customInstructions` to the system prompt. Current Codex v2 uses session base instructions and does not expose a separate custom-guidance request field.
5. **Observed reasoning, text verbosity, service tier, prompt cache key, usage pricing, and identity metadata are request-quality/accounting parity.** They can be retained as product choices, but the map explicitly excludes parity as an end in itself.
6. **`compaction_summary` support is legacy compatibility.** Current v2 emits `compaction`; accepting `compaction_summary` belongs to older protocol/persistence compatibility, which map #35 says is not required.
7. **Strict non-empty `encrypted_content` validation is stronger than current Codex.** The repository rejects empty content; upstream's collector does not explicitly perform that check.

### Stale claims or concrete divergences

#### 1. Overflow policy materially diverges

The README says the extension estimates the complete request, reduces tool outputs, then discards oldest complete history groups and may retain a head/tail-truncated boundary message ([README L61-L66](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/README.md#L61-L66)). The implementation does exactly that ([`src/remote-compaction.ts` L1295-L1364](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/src/remote-compaction.ts#L1295-L1364)).

Current Codex does not. It rewrites only a trailing contiguous run of eligible outputs and may still let the request fail. The repository's policy is more aggressive and can remove semantically meaningful old items before the server compacts them. This is not “incidental parity”; it is a real product behavior requiring human disposition.

#### 2. “Retries transient failures twice” is imprecise and the retry matrix differs

The README claims two transient retries. The repository's single retry loop is capped at two, but it treats all HTTP 429 responses and `server_is_overloaded`/`slow_down` as terminal. Current Codex:

- has separate HTTP request and stream retry layers;
- retries 503 overload at the HTTP layer according to provider budget;
- retries some streamed rate-limit failures and honors delay advice embedded in their messages;
- caps only the remote-v2 stream layer at two.

The semantic agreement is bounded whole-attempt retry with no partial install. Exact classes/counts are not aligned and should not be claimed as Codex-style without qualification.

#### 3. Official OpenAI documentation does not document `compaction_trigger`

The README presents Responses compaction v2 as an endpoint requirement for any plain `openai-responses` model. Current official docs instead document:

- automatic compaction via `context_management` on `/responses`;
- explicit compaction via `/responses/compact`;
- canonical replay of standalone compact output as-is.

This does not disprove that the Codex v2 endpoint works, but it means exact `openai-responses` API type is only a project eligibility gate. It is not evidence that an arbitrary provider implementing the public Responses API supports `compaction_trigger`.

#### 4. Persisted version 1 compatibility remains in code/docs despite map scope

The README says legacy version 1 details remain readable, and `extractRemoteCompactionDetails` accepts them. Map #35 explicitly says old persisted version 1 compatibility is not required. This is a concrete scope mismatch for the later refactor, though not an upstream semantic conflict.

#### 5. Package baseline is still 0.84.0, not the map's 0.84.2 target

`package.json` currently declares `0.84.0` development dependencies. Map #35 fixes the decision baseline at Pi 0.84.2. This research did not alter dependencies, but later planning should not infer 0.84.2 public API facts solely from the current lockless `0.84.0` declarations.

#### 6. “Exactly one valid compaction item” needs a defined validation boundary

The README's statement is directionally correct, but “valid” currently means non-empty ciphertext in this repository and only deserializable compaction variant/count in upstream Codex. A later spec must state its own minimum validation rather than citing Codex generically.

## Conflicts and open questions requiring HITL

These cannot be resolved mechanically from source because they choose product policy among valid behaviors.

### HITL 1: Is the target an undocumented Codex trigger flow or the current public OpenAI compaction contract?

Facts:

- Codex v2 at the pin uses `/responses` plus `compaction_trigger`.
- Official docs currently expose `context_management` and `/responses/compact`, not the trigger.
- Public standalone output is canonical and must not be pruned; Codex v2 constructs a retained window client-side.
- Map #35 names Codex as behavioral reference and plain `openai-responses` as eligibility, not field parity.

Question for the human decision session: should the refactor explicitly define an **undocumented Codex-v2 semantic subset with runtime endpoint capability required**, or should “plain Responses contract” mean only currently documented public compaction primitives? Research cannot merge these into one contract.

### HITL 2: What is the minimum explicit-retention policy?

Facts:

- Current Codex keeps a 64K newest-first subset including item classes Pi may not expose.
- The current repository keeps real user messages only, then the compaction item.
- Official standalone compaction says replay the server's full compacted output as-is.
- The trigger itself does not define retained explicit items.

Question: is “real Pi user messages plus the new compaction item” the desired semantic subset, is exact 64K retention a product commitment, or should the later design derive a smaller invariant independent of Codex's current constants? The answer affects persistence size, repeated compaction, and context quality.

### HITL 3: What overflow loss is acceptable before compaction?

Facts:

- The compact request must fit.
- Codex only rewrites trailing tool outputs and otherwise allows a terminal overflow.
- The repository additionally deletes oldest groups and truncates message boundaries to force fit.
- Deleting input before server compaction can change the information available to the compaction model.

Question: should the core contract prefer fail-safe refusal once non-semantic tool-output reduction is exhausted, or permit bounded deletion/truncation of semantic history? This is a quality/safety trade-off, not a parity question.

### HITL 4: What bounded retry contract should docs/tests promise?

Facts:

- Atomic whole-attempt retry is supported by both implementations.
- Codex has layered request/stream/transport retry and no single universal count.
- The repository has one two-retry loop and a different terminal/retryable error matrix.
- Exact backoff and `Retry-After` handling are transport policy.

Question: should the product promise only “bounded retries for selected retryable failures,” retain a fixed two-retry product rule, or define explicit status/error classes? Source parity cannot decide the user-facing availability/latency trade-off.

### HITL 5: What minimum compaction-item validation is required?

Facts:

- Both require one `compaction` item and completed operation.
- The repository additionally requires non-empty ciphertext.
- Upstream permits missing item ID and does not explicitly reject empty ciphertext.

Question: should the spec keep defensive non-empty validation, and are unknown extra fields/types preserved opaquely? This is likely a small decision, but it must be stated rather than attributed to upstream.

## Findings against the current ADRs

### ADR 0001: select models by API contract

- **Agreement with standing project decision:** exact `openai-responses` gating is a valid project eligibility policy and avoids provider-name coupling.
- **Unsupported implication:** current official public Responses support does not imply support for undocumented `compaction_trigger`. Eligibility must remain distinct from endpoint capability, as `CONTEXT.md` already says.
- **No upstream parity requirement:** current Codex itself uses provider capability rather than Pi API-type identity. The map has already chosen not to copy this provider-aware selection.

### ADR 0002: prefer native replay continuity

- **Supported:** Codex persists opaque replacement history and does not generate a second text summary for v2.
- **Supported for the selected v2 path:** terminal v2 failure propagates without local text fallback or partial history install.
- **Project-specific adapter:** the fixed checkpoint marker is not an upstream behavior; Codex's remote checkpoint text is empty.

### ADR 0003: keep provider transport independent

- **No semantic conflict:** Codex's WebSocket/HTTP selection and fallback are transport details. Full replacement-history replay does not require transport ownership.
- **Known limitation remains separate:** the repository's direct HTTP/SSE compaction RPC cannot inherit provider-aware raw transport. Map #35 already excludes that effort.

### ADR 0004: keep resolved endpoints out of model identity

- **Not established by Codex:** current Codex does not persist the repository's model key in replacement history.
- **No core-lifecycle conflict:** linear same-model continuation does not exercise endpoint/model identity changes.
- **Outside this research decision:** endpoint compatibility and model-switch matrices remain product policy, not v2 protocol facts.

## Decision-session fact sheet

A later specification can safely treat the following as established:

- `compaction_trigger` is a request control, never durable history.
- V2 uses current history and normal model-facing context.
- Success means completed operation plus exactly one compaction item.
- Additional output items are not replacement history.
- The returned compaction item is opaque and must survive exactly into later input.
- Replacement history is a complete new context base, not a patch over pre-checkpoint history.
- Reload/resume must recover the newest successful base and replay its suffix.
- Repeated compaction compacts the current base and supersedes the old compaction item.
- Failed attempts must not install partial output.
- A terminal selected-v2 failure does not become text compaction.
- Input overflow must fail safely if local reduction cannot produce an acceptable request.
- Full input-array replay is sufficient; response IDs, transport reuse, and Codex metadata are not core.

The later specification must make explicit human choices for:

- undocumented trigger versus documented public compaction target;
- retained explicit item classes and budget;
- overflow deletion/truncation policy;
- retry classes/counts;
- minimum compaction-item validation.

## Source index

### Upstream OpenAI/Codex, commit-pinned

- [Remote v2 lifecycle and history construction](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2.rs)
- [Remote v2 attempt/request construction](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote_v2_attempt.rs)
- [Ordinary Responses request builder and transports](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/client.rs)
- [Shared remote history filters and pre-request output trimming](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/compact_remote.rs)
- [Automatic compaction trigger and sampling overflow behavior](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/turn.rs)
- [Atomic live-history replacement and checkpoint persistence](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/mod.rs)
- [Rollout reload/reconstruction](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/session/rollout_reconstruction.rs)
- [Responses item definitions](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/protocol/src/models.rs)
- [Retryability mapping](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/protocol/src/error.rs)
- [Provider remote-compaction capability](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/model-provider/src/provider.rs)
- [Responses client/turn metadata](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/src/responses_metadata.rs)
- [Remote-v2 integration tests](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/tests/suite/compact_remote.rs)
- [Retry-layer integration tests](https://github.com/openai/codex/blob/ede5247893a50297a47c9aa5038e6ab28312ff50/codex-rs/core/tests/suite/retry_after.rs)

### Official OpenAI documentation

- [Compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [Compact a response API reference](https://developers.openai.com/api/reference/resources/responses/methods/compact/)
- [Create a model response API reference](https://developers.openai.com/api/reference/resources/responses/methods/create/)
- [WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [Reasoning models: preserving reasoning and handling context](https://developers.openai.com/api/docs/guides/reasoning)

### Current repository claims inspected

- [`CONTEXT.md`](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/CONTEXT.md)
- [`README.md`](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/README.md)
- [ADR 0001](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/docs/adr/0001-select-models-by-api-contract.md)
- [ADR 0002](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/docs/adr/0002-prefer-native-replay-continuity.md)
- [ADR 0003](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/docs/adr/0003-keep-provider-transport-independent.md)
- [ADR 0004](https://github.com/angribot/pi-openai-server-compaction/blob/558bc16f9819afff04127b45a760d9f422579f36/docs/adr/0004-keep-resolved-endpoints-out-of-model-identity.md)
