# Changelog

This changelog intentionally starts at **0.1.0**.

## Unreleased
- bound remote compaction requests to the selected model's context window by reducing oversized tool outputs first, preserving call/output pairs, and visibly truncating retained message boundaries
- align remote compaction with the selected model's reasoning map, exclude structured-output schemas, and include service-tier-adjusted usage in Pi's session totals
- preserve native replay across cancelled session navigation, rebuild it at successful lifecycle boundaries, and reject incomplete persisted replay details without breaking colon-bearing model IDs
- build remote compaction input from Pi's effective context with Pi-compatible Responses conversion, preserving prior summaries, contextual messages, shell output, assistant item metadata, tool compatibility, and exact native-replay model identity
- load through Pi 0.84's production extension resolver without importing an unsupported runtime subpath

## 0.6.0 - 2026-08-06
- support Pi 0.84 request auth for remote compaction, including null header deletion and credential-resolved Responses endpoints
- forward the observed `service_tier` for the same model key while keeping arbitrary sampling parameters out of remote compaction requests

## 0.5.0 - 2026-08-01
- align retained user-message replay with Codex's current 64K approximate-token budget
- retry transient Responses compaction v2 failures twice with abortable Codex-style backoff and incremental SSE validation
- cancel failed remote compaction instead of falling back to Pi's text compactor, preserving native replay semantics

## 0.4.0 - 2026-07-31
- run only the remote Responses compaction request on the successful path instead of concurrently generating a second local summary
- persist a fixed native replay checkpoint marker: `[Remote Responses compaction checkpoint]` plus its compatibility note
- return control to Pi's default compaction on remote failure and preserve explicit cancellation on abort, including while credentials are resolving
- update the compaction contract, validation plan, and architecture docs for native-continuity-first behavior

## 0.3.0 - 2026-07-31
- enable remote compaction by exact `model.api === "openai-responses"` instead of provider name or endpoint classification
- support custom providers and relays through their configured Responses base URL
- stop registering or overriding providers; replay remote replacement history through `before_provider_request`
- remove the extension-owned WebSocket client, provider stream override, socket lifecycle, and live `previous_response_id` continuation state
- remove ordinary-request mutation of `store`, `context_management`, and `previous_response_id`
- remove extension configuration and always enable remote compaction without activation notifications; Pi continues to own compaction thresholds
- remove direct `ws` and `@types/ws` dependencies
- make reduced-plaintext live replay provider-agnostic
- limit committed tests to the remote-compaction project's core contract and keep cross-extension transport validation external
- document the current raw transport capability gap: the compaction RPC remains HTTP/SSE until Pi exposes a provider-aware raw transport seam

## 0.2.0 - 2026-07-31
- target Pi 0.83.0 and the `@earendil-works/*` package namespace while leaving Pi peer dependencies unpinned
- align compaction fallback, Responses payload normalization, Codex identity headers, and WebSocket behavior with Pi 0.83.0
- replace the legacy `/responses/compact` call with Codex's current Responses compaction v2 protocol
- stream a normal Responses request with a trailing `compaction_trigger` and persist the returned `compaction` item
- retain recent user messages with the same 20K-token budget shape used by Codex while continuing to read legacy version 1 session artifacts
- add a reproducible native-vs-text compaction benchmark, retained GPT-5.6 Sol evidence, and a standalone report
- add a fixed-context, information-density-calibrated product-defaults benchmark comparing Pi's real default compactor with the extension's real native replay policy
- correct the earlier benchmark's same-budget interpretation: its text cap was selected after observing native output usage

During local development on 2026-04-09, the project used temporary internal version bumps while features, tests, docs, and packaging were being assembled. Those local-only bumps were collapsed before the first public push so the repository does not imply a longer tracked public release history than it actually has.

## 0.1.0 - 2026-04-09
- initial public release
- added hybrid Codex-style remote compaction for direct OpenAI Responses models
- added OpenAI `POST /v1/responses/compact` integration
- persisted opaque replacement history in Pi compaction details
- reconstructed remote compaction state across resume/reload/tree navigation
- added WS-backed continuation and conservative `previous_response_id` reuse
- tightened direct OpenAI continuation so unchanged request shapes send only incremental post-turn deltas instead of replaying full input alongside `previous_response_id`
- fixed reconstructed post-compaction remote replay to exclude turns completed by other models after later resume/tree reconstruction
- kept portable Pi text summaries as the readable fallback and non-OpenAI portability path
- hardened cross-model runtime state handling and remote output validation
- mirrored observed Responses `reasoning` and `text` tuning into remote compaction requests when available, with thinking-level fallback for reasoning
- fixed the direct OpenAI WS path to carry reasoning configuration and encrypted-reasoning inclusion like Pi's normal HTTP Responses path
- persisted remote compaction usage metadata when the backend returns it
- added a reduced-plaintext live replay regression with tiny Pi `keepRecentTokens`
- added a live Pi RPC regression harness in `tests/live/openai-compaction-rpc-live.ts`
- added a local smoke harness that bootstraps Pi peer-package links and runs small regression checks
- added `ARCHITECTURE.md`, testing docs, packaging polish, and MIT licensing
