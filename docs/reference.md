# Technical reference

For installation, everyday use, and recovery guidance, start with the [README](../README.md). This document describes the detailed protocol and implementation contract.

> **Status:** experimental. Install project-local first and keep rollback easy.

## Requirements

- Node `>=22`
- Pi `1.4.0` as the implementation and validation baseline (not a guarantee about every later patch); see [Transport boundary and limitations](#transport-boundary-and-limitations).
- a selected GPT-prefix model using either supported API type on any configured provider
- working Pi-managed credentials for that model
- a Responses endpoint that accepts the Remote compaction v2 trigger and can replay the returned compaction item

The extension does not infer Remote compaction capability from API type, model naming, or endpoint hostname. Custom providers on either API retain their selected identity, Pi-managed credentials, and routing; custom transport composition beyond the existing adapter contracts remains unsupported.

## Eligibility and authentication

Eligible models have a nonempty structured provider/API/model identity, either exact case-sensitive API `openai-responses` or `openai-codex-responses`, and a request model ID starting with literal lowercase `gpt-`. Any nonempty provider identity is allowed; display names and endpoints are irrelevant to eligibility. No trimming, case folding, namespace stripping, alias resolution, catalog lookup, or version validation occurs. Thus `gpt-` is eligible but `GPT-example`, `openai/gpt-example`, and `codex-auto-review` are not. Ineligible models leave new compaction to Pi. Eligibility permits only an attempt; endpoint acceptance is a runtime outcome.

Exact provider `openai` additionally defers new and repeated compaction when `context.modelRegistry.isUsingOAuth(model)` reports OAuth. The hook returns `undefined` before checkpoint preparation, credential resolution, or adapter dispatch; Native replay and other providers do not use this gate. This is an operation-specific exclusion, not a change to model eligibility or a fallback after a failed operation. Deferral leaves existing checkpoint data untouched, but a later ordinary Pi compaction can supersede it as before.

Pi's public status reflects its managed auth lifecycle: runtime API keys override stored OAuth and removing the override restores OAuth status; stored OAuth wins over configured/environment keys. The gate does not inspect tokens, read credential files, resolve auth twice, or refresh OAuth. A false status does not certify usable API-key credentials; ordinary operation credential validation remains responsible for missing or invalid auth. No additional atomicity is promised for concurrent out-of-band credential-file edits.

## Alignment and local policy

- **Codex alignment:** Remote compaction v2 uses `/responses` with a terminal trigger, not v1's `/responses/compact`. Retained explicit user history follows the [audited retention policy](#bounded-explicit-user-history); active tool declarations follow Pi's projection, aligning with [Codex's declaration-bearing compaction requests](https://github.com/openai/codex/blob/e89b7c442c0433ad5167e72a5a25bb6d0712766a/codex-rs/core/src/compact_remote_v2_attempt.rs#L166).
- **Deliberate local choices:** optimistic [Native replay](#native-replay), versioned [checkpoint persistence](#persistence), and fail-closed [failure handling](#retry-and-failure-behavior) are extension policies, not restrictions imposed by Pi. No preflight lossy input fitting, portable summary fallback, or automatic tool execution is implemented.
- **Pi capability boundaries:** the remaining raw-operation, loader/projection, and warming constraints are described under [Transport boundary and limitations](#transport-boundary-and-limitations). Public stream observation simplifies Codex success capture but does not replace raw failure supervision. These claims are scoped to the Pi `1.4.0` baseline, not every future release or backend.

[Historical capability-gap tracking #51](https://github.com/angribot/pi-openai-server-compaction/issues/51) predates the removal of compatibility catalogs and request-time decision records. Those mechanisms are no longer current requirements; the remaining adapter rationale is recorded in [ADR 0003](adr/0003-keep-provider-transport-independent.md).

## Remote compaction contract

On `session_before_compact`, an eligible model receives one read-only logical request containing only:

- the selected model;
- Pi's persisted, compaction-aware active linear-session compactable context projected into ordinary Responses input and model-visible tool declarations;
- the effective system instructions plus supplied custom compaction instructions; and
- exactly one terminal, payload-free `{ "type": "compaction_trigger" }`.

A model outside the eligibility policy is not eligible for an attempt: the handler returns `undefined`, no adapter runs, and Pi's default compaction proceeds.

Tool state comes from Pi's persisted transcript and checkpoint-owned snapshot, not the registry of every discoverable tool. Projection follows Pi `1.4.0`'s three transport support modes: `none` places the current tool set in the top-level `tools` field; `additions` keeps the set through the last non-additive change there and carries later additions in place as paired client `tool_search_call`/`tool_search_output` items; and `changes` leaves `tools` empty and declares every batch, including the initial one, as in-place `additional_tools`, with Pi's incremental notice and text announcement of true removals. A redefinition replaces an earlier declaration under the same name. A checkpoint-owned snapshot is the leading declaration position of a repeated-compaction context, so inherited declarations are emitted in place when the selected capability requires them. Function and grammar/custom declarations and historical call/result forms follow Pi, including its strict-mode capability defaults and constrained-sampling projection; ordinary schemas, including regex lookahead, are not independently repaired. Empty and whitespace-only tool outputs, including image-bearing results, use Pi's placeholder and image projection rather than the raw whitespace. An actual schema or unsupported-operation rejection is terminal, with no tool-free retry. Declarations do not execute returned tool calls: compaction still requires exactly one valid compaction item and explicit completion, and unrelated output does not start an agent turn.

The shared payload builder unconditionally sets `store: false` and `stream: true` for both adapters; these fixed wire fields are not part of the logical request. The direct `openai-responses` adapter sends that protocol payload with projected declarations when present. For Codex Responses, the extension runs Pi's public provider operation with the current session ID, forced SSE, and provider retries disabled. Pi continues to own Codex authentication, account headers, endpoint routing, compression, and envelope fields such as `text`, `include`, `prompt_cache_key`, `tool_choice`, and `parallel_tool_calls`; the extension replaces only the model, projected input, instructions, `store`, `stream`, and transcript-owned `tools` protocol invariants and removes competing `messages` and `previous_response_id` fields. Empty transcript-owned tool state removes unrelated inherited envelope declarations. The extension performs no preflight context fitting or tool-output rewriting. The complete supported compactable context reaches the endpoint; only successful replacement history is retention-budgeted afterward. Endpoint context overflow remains terminal.

Success requires an explicit raw `response.completed` or `response.done` event, Pi's Codex provider completion when applicable, and exactly one output item with `type: "compaction"` and string `encrypted_content`. Empty ciphertext is valid, an item `id` is optional, unknown item fields are preserved, and unrelated output items are ignored. Parseable usage is returned only through Pi's standard compaction usage field.

A successful operation returns one atomic custom compaction. It never calls `appendEntry()`, generates a second text summary, persists intermediate state, or falls back to Pi's text compactor.

## Bounded explicit user history

After validated Remote compaction, replacement history contains eligible original user messages followed by exactly one newly accepted compaction item. Eligibility is selected from Pi's compaction-aware context before provider conversion: synthetic compaction/branch summaries, checkpoint markers, assistant/tool history, and triggers are not reclassified as original user messages merely because conversion assigns a user role.

The fixed retention budget is **64,000 approximate tokens**, independent of Pi's `keepRecentTokens`, with no extension setting. Newer messages take priority; retained messages return to chronological order. Text is charged at one token per four UTF-8 bytes, rounded up per content part, with a minimum one-token charge per message. An over-budget text-only boundary preserves earlier content parts and middle-truncates the final text part on UTF-8 boundaries, preserving both ends. Its `…N tokens truncated…` notice is outside the retained-text budget, following upstream behavior.

Pi-supported inline `detail: "auto"` images cost 1,844 approximate tokens each, independent of base64 length. Image-containing boundary messages prioritize later content parts; images remain atomic, and an image that cannot fit stops older-content backfill. No Codex-only image labels or metadata are synthesized. Non-vision models retain Pi's normal image placeholders instead.

This follows [Codex's retained-history policy](https://github.com/openai/codex/blob/e89b7c442c0433ad5167e72a5a25bb6d0712766a/codex-rs/core/src/compact_remote_v2.rs#L480), [enabled image budgeting](https://github.com/openai/codex/blob/e89b7c442c0433ad5167e72a5a25bb6d0712766a/codex-rs/core/src/compact_remote_v2_images.rs), and UTF-8 token truncation at that audited revision for item kinds Pi represents. It does not retain Codex agent messages or enable default-disabled client-authored developer/tool-output retention. The budget is not guaranteed remaining capacity in the target model's window: small-window targets may still reject a later request. Neither overflow nor retention permits preflight loss, progressive truncation retries, or a portable summary fallback.

## Persistence

Self-describing `nativeReplayCheckpoint` records with formats `native-replay-checkpoint/1` and `/2` are supported. New records use `/2`; `/1` retains its single-item integrity rules. Older `/1`-only extension releases cannot replay `/2` checkpoints: downgrading requires a new session or a branch point before the new checkpoint.

Legacy `remoteCompaction` records, including the structured version 2 records written by v0.8.0 and earlier formats, remain unsupported. An active legacy checkpoint fails closed: ordinary requests abort and eligible Remote compaction is cancelled. There is no migration or text fallback.

The checkpoint summary is fixed protocol data:

```text
[Remote Responses compaction checkpoint]

Detailed context before this checkpoint is retained in the native replay artifact and is available only to compatible Responses models.
```

The matching `CompactionEntry.details` written by this release contains exactly:

```ts
{
  nativeReplayCheckpoint: {
    format: "native-replay-checkpoint/2",
    producer: {
      modelKey: {
        provider: string,
        api: "openai-responses" | "openai-codex-responses",
        id: string,
      },
      compactionCompatibilityClass: string | null,
    },
    replacementHistory: [...retainedUserMessages, compactionItem],
  },
}
```

New checkpoints write an explicit null class. Existing nonempty string classes (including `2911`, `3000`, and unknown values) and null remain readable historical metadata and are never compared or recalculated. The `/2` decoder requires zero or more user messages containing supported input-text or inline auto-detail image parts, then exactly one valid compaction item. It rejects other roles/kinds, invalid ordering, and extra compaction items, while preserving unknown fields on the opaque compaction item. Replacement history excludes assistant/tool history, the marker, triggers, routing data, and duplicated usage. `/1` remains restricted to its original single compaction item: no bulk migration, raw pre-checkpoint user-history backfill, or legacy reader is added. Custom Codex producer keys retain their actual provider identity. Valid historical non-GPT producer records are incompatible, not malformed.

Pi's checkpoint-owned host `systemMessage` snapshot is required for repeated Remote compaction, not ordinary Native replay. Either supported format without a snapshot stays replayable, but further Remote compaction returns `snapshot-unavailable` and cancels before dispatch: the extension will not guess historical instructions. A snapshot-bearing `/1` checkpoint can be superseded naturally by `/2`; reading either format never rewrites session files or recovers discarded history.

Only the active branch's latest `CompactionEntry` can define replay state. The extension reconstructs that state from the branch on every hook; it keeps no replay cache, request-shape cache, invalidation tombstone, or lifecycle synchronization listener. A later ordinary compaction supersedes an older checkpoint. A fixed marker with missing, unknown-format, or malformed details is a broken checkpoint and fails closed.

Continuity is re-derived from persisted successful assistant turns using the current eligibility policy on every reconstruction. Successful ineligible or invalid identities invalidate it; failed and aborted turns are ignored. This applies uniformly to old and new supported checkpoints without rewriting session files. Branches previously invalidated solely by differing classes between eligible models may become replayable again.

## Native replay

Both producer and target must be model-eligible; the `openai` OAuth compaction exclusion does not apply to Native replay. Neither class equality nor exact Model key equality is required: replay is optimistic across IDs, providers, and the two supported APIs. Credentials, accounts, headers, and resolved endpoints remain routing data. There is no catalog, remote class discovery, user override, or separate legacy eligibility policy.

This deliberately trades advance compatibility checks for runtime rejection risk. OpenAI Codex's upstream `comp_hash` still describes compaction compatibility; removing the local gate does not prove those semantics irrelevant or all GPT backends interoperable. Old `2911` items may be submitted to a different eligible target and rejected.

For a compatible ordinary request, the extension:

1. reconstructs the checkpoint marker, the checkpoint-owned `systemMessage` snapshot when present, and Pi-retained pre-compaction entries from the active branch;
2. projects those historical entries using the current ordinary transcript's declaration environment, including persisted post-checkpoint redefinitions, so function/grammar call and result wire forms agree with the real selected provider;
3. anchors the replay replacement span on the checkpoint marker rather than the first projected item, so leading provider instructions stay outside the span;
4. requires a full-array `payload.input` with exactly one contiguous wire-equivalent replay replacement span;
5. replaces only that span with the complete validated replacement history;
6. preserves provider instruction, tool, and reasoning items before and after the span; and
7. removes competing `messages` and `previous_response_id` fields.

For supported snapshot-less checkpoints, the span still begins at the marker; no pre-checkpoint head is inferred. See [Persistence](#persistence) for the read-but-no-recompact boundary.

A malformed active state, invalidated branch, non-array input, or missing/ambiguous span stops the ordinary request through `ctx.abort()` and emits an explicit error. It does not throw from the hook and allow Pi to continue with the old payload.

Selecting an incompatible model leaves its ordinary payload and transport untouched and emits a warning. Selection alone, abandoned requests, failed requests, and aborted turns do not invalidate continuity. A persisted successful ineligible or malformed-identity assistant turn does, including tool-calling turns. After invalidation, replay stops and further eligible Remote compaction is cancelled; no mixed-history suffix is fabricated.

## Repeated Remote compaction

A repeated request may select any other Eligible model, subject to the same `openai` OAuth exclusion as new compaction, producer eligibility, continuity, integrity, and the host snapshot requirement. It contains, in order:

1. the latest complete replacement history (retained eligible user messages plus its compaction item);
2. the projected model-visible branch suffix after the owning `CompactionEntry`; and
3. one new terminal compaction trigger.

It excludes the checkpoint marker, raw Pi-retained pre-compaction entries, previous triggers, and duplicate old compaction items. Retention is reapplied to the logical current context: previously retained users plus eligible post-checkpoint users, never discarded raw history. A successful result atomically installs that newly bounded user history followed by the new compaction item, records the selected producer's Model key and an explicit null class, and discards the previous compaction item.

## Retry and failure behavior

`src/direct-responses-operation.ts` and `src/codex-responses-operation.ts` each perform one attempt. The Codex adapter also sets Pi's provider retry count to zero. `src/remote-compaction.ts` owns the only retry loop: one initial attempt plus at most two retries, always with the same read-only logical request.

Transient network, read, idle-timeout, premature-EOF, malformed pre-completion stream, incomplete-response, rate-limit, overload, and retryable HTTP failures may retry. Caller abort, authentication or projection failure, clearly non-transient HTTP failures, invalid request or prompt, unsupported operation, context overflow, quota or policy failure, completed-response item validation failure, and retry exhaustion are terminal. Flat SSE errors, nested `error` envelopes, `response.failed`, and HTTP error bodies are normalized before classification and diagnostic extraction. Invalid-request (including `invalid_function_parameters` without a generic invalid-request type), context-overflow, quota, and policy errors (including `misalignment_policy_violation`) remain terminal regardless of envelope shape or otherwise retryable HTTP status; unknown SSE errors remain retryable. Standard `Retry-After` is preferred and capped at 60 seconds; fallback backoff is finite, capped, jittered, and abort-aware.

Each Codex attempt owns a cancellation controller linked to the caller. Raw-reader failure (including malformed JSON and the five-minute idle timeout) cancels the provider consumer and the HTTP body without waiting for server EOF; provider failure and caller cancellation also release attempt-owned streams. Raw-reader cleanup never waits on a cloned stream's shared cancellation before notifying the attempt owner. Authentication that cannot be interrupted may finish later, but the cancelled attempt cannot dispatch a request or persist a checkpoint. Ordinary requests and global transport state are unaffected.

Every eligible terminal failure returns `{ cancel: true }`, preventing Pi text-compaction fallback and discarding partial item or usage data.

## Transport boundary and limitations

The extension does not register or override providers. Ordinary requests remain owned by the selected provider transport; this extension only patches Native replay in `before_provider_request` and stops protected prompt-cache refreshes in `cache_warming_decision`. Optimistic service acceptance across routes is a runtime assumption: a target rejection follows ordinary provider error handling and does not trigger artifact stripping or a portable fallback.

The Remote compaction operation uses one of two narrow SSE adapters because Pi `1.4.0` does not expose a provider-aware raw Responses operation that proves explicit completion while preserving unknown output items such as `compaction`. Exact `openai-responses` models use direct HTTP/SSE with Pi-resolved routing and authentication. Codex Responses on any provider uses Pi's public provider operation plus per-call stream observation and a cloned raw-response supervisor, retaining Pi's OAuth refresh, account headers, endpoint construction, compression, and request envelope. Success items and usage are captured through the public per-call `onProviderStreamEvent` before normalization. A narrow cloned raw-response supervisor independently requires explicit wire completion and retains HTTP error bodies, `Retry-After`, framing/JSON failure detection, and idle supervision, but no longer collects successful output items or usage. Parsed observation alone cannot provide those raw-operation guarantees: HTTP failures and silent idle streams produce no success events. Both observations and successful provider completion are required; a provider that drops the compaction item fails closed. No handwritten Codex transport or fallback request is used, and ordinary Codex requests remain free to use Pi's configured WebSocket or SSE transport.

Other extensions' request mutations and provider-aware raw-operation composition remain outside this package's current contract.

The projection remains local because Pi `1.4.0`'s production extension loader rewrites `pi-ai` subpath imports through its root compatibility alias, preventing direct reuse of the exported Responses converter. The extension reuses Pi's public root-exported transcript helpers (`normalizeContext`, `resolveTranscript`, `resolveTranscriptTools`, `getDeclaredTools`, `getInitialSystemMessage`, `getCurrentSystemMessage`, `getSystemMessageText`, `renderSystemMessageUpdate`) while no module-resolution workaround is installed.

The local Responses projection adapter covers Pi `1.4.0` ordinary semantics for supported persisted messages, including leading and mid-conversation system messages with string or text-array content, prompt-section additions/replacements/removals, the three tool support modes and their declaration/removal-notice placement, the model's collapse-versus-mid-conversation capability, and the differing leading-system placement of ordinary Responses and built-in Codex requests, plus images and placeholders, empty and whitespace-only tool outputs, assistant text identity and phase, same-model signed reasoning, ordinary function calls/results and missing-output normalization, and built-in custom-message normalization. Tool declaration placement follows the [Remote compaction contract](#remote-compaction-contract). Optimistic eligibility broadens only opaque compaction-item replay; signed or encrypted reasoning, tool-call IDs, thought signatures, and provider namespace metadata retain their existing exact-identity rules. Because the adapter mirrors Pi instead of adding validation Pi lacks, unrecognized model-visible content is converted or ignored exactly as Pi would; a conversion that throws cancels the Remote compaction attempt. Supported grammar-tool calls/results (including retained results without their calls) use Pi-equivalent wire forms after capability-dependent transcript resolution and honor persisted declaration redefinitions and removals. This does not expand support to arbitrary ephemeral context/provider-payload mutations, provider distinctions already erased by Pi, or deferred-tool discovery/execution beyond Pi's persisted declaration projection.

### Prompt-cache warming guard

Pi 1.4.0 can refresh a prompt cache during long tool runs and while idle. A warming refresh re-runs `before_provider_request` with an independent abort controller, so Native replay's fail-closed `ctx.abort()` cannot be relied on to stop it. Before each refresh, the extension stops warming through Pi's public `cache_warming_decision` hook whenever the active branch's latest compaction is a Remote compaction checkpoint. The decision is derived from the branch on every call; no replay cache, stale lifecycle flag, or persistent warming state is kept.

Protection covers every latest Remote checkpoint state, including compatible, incompatible, invalidated, malformed, and recognized legacy (`remoteCompaction`) records, and is deliberately independent of model eligibility: a model that cannot attempt a new Remote compaction still has a protected checkpoint. When the branch's latest compaction is an ordinary compaction, or there is no compaction, the extension returns no override, so Pi's decision and ordinary prompt caching are untouched, including for unrelated branches and after ordinary-compaction supersession, resume, or branch navigation. The trade-off is that proactive prompt-cache refreshes remain paused while a Remote compaction checkpoint is the branch's latest compaction; Pi may schedule later refreshes, but the guard applies again on every decision until the checkpoint is superseded.

This hook stops a refresh before provider dispatch only. It does not cancel a refresh that is already in flight, disable warming globally, or provide general request-specific cancellation; full safe warming integration is outside the current contract.

Architecture decisions:

- [ADR 0008: Version bounded replacement history](adr/0008-version-bounded-replacement-history.md) — supersedes ADR 0002's single-item history and ADR 0007's unchanged-writer-format assumption while retaining native continuity and optimistic replay

- [ADR 0007: Attempt optimistic GPT replay](adr/0007-attempt-optimistic-gpt-replay.md) — supersedes the eligibility and class policies in ADRs 0001 and 0005; updates ADRs 0003 and 0006

- [ADR 0001: Select models by API contract and known compatibility class](adr/0001-select-models-by-api-contract.md) — superseded by ADR 0007
- [ADR 0002: Prefer native replay continuity](adr/0002-prefer-native-replay-continuity.md)
- [ADR 0003: Keep provider transport independent](adr/0003-keep-provider-transport-independent.md)
- [ADR 0004: Keep resolved endpoints out of model identity](adr/0004-keep-resolved-endpoints-out-of-model-identity.md) — superseded by ADR 0005
- [ADR 0005: Use creation-time compatibility classes for Native replay](adr/0005-use-creation-time-compatibility-classes.md) — superseded by ADR 0007
- [ADR 0006: Re-derive Native replay compatibility from persisted turns](adr/0006-re-derive-replay-compatibility-from-turns.md)

## Test ownership

Tests committed to this repository must be necessary to cover this extension's own core contract.

Do not commit:

- cross-extension loading matrices;
- provider allowlist fixtures from a transport extension;
- HTTP-versus-WebSocket composition matrices;
- machine-specific provider names or settings;
- temporary live probes.

Cross-extension composition stays an external, ephemeral validation. A defect found there is reduced to the owning project's interface before it can become a test here.

## Testing

The offline suite uses Node's built-in test runner and requires no credentials or network:

```bash
npm test
```

Its focused files are:

- `tests/loader.test.ts` — production loader, package factory, exactly three hooks, and no provider override;
- `tests/cache-warming-guard.test.ts` — the warming guard through Pi 1.4.0's real `CacheWarmer` decision/dispatch path and the production `ExtensionRunner`: latest-checkpoint states stop warming without aborting the main run, host warm and stop decisions pass through unchanged without a checkpoint, real warming dispatch resumes after ordinary-compaction supersession, and branch changes are re-read without stale state;
- `tests/remote-compaction.test.ts` — lifecycle-hook eligibility and historical replay matrices, real Pi auth-status/runtime-override transitions with production direct operations and mocked fetch, OAuth compaction deferral without blocking replay, retrospective continuity, repeated compaction, snapshot requirements, unsafe state hard stops, and terminal cancellation without text fallback;
- `tests/remote-compaction-operation.test.ts` — direct and Pi-mediated one-attempt SSE operations, payload ownership, raw completion, validation, failure classification, usage, and abort;
- `tests/native-replay.test.ts` — checkpoint restoration, repeated-compaction input, ordinary span replacement, span matching failures, continuity invalidation from persisted turns, and the snapshot-less read-but-no-recompact separation;
- `tests/transcript-replay.test.ts` — Pi 1.4.0 transcript behavior checked through the real provider payload with a mocked fetch: leading and mid-conversation system messages, collapse/mid-conversation capabilities and both API contracts, section and tool additions/removals/redefinitions, all three declaration support modes for first and repeated compaction, empty and whitespace-only tool outputs including image-bearing results, terminal schema rejection without tool-free retries or execution, first and repeated compaction compared against the real provider projection, snapshot-less `/1` ordinary replay, combined real `SessionManager` reload/navigation with multi-item `/2` history, later declaration redefinitions, replay, and checkpoint-derived warming protection, strict `/1` compatibility and natural supersession, source-backed UTF-8/image retention fixtures, repeated compaction without backfill, terminal overflow without input fitting, production custom Codex compaction and cross-API replay with mocked fetch, call/result and missing-result ordering, and span failure handling.

The offline suite exercises hook-level terminal cancellation, the three-attempt retry budget with unchanged requests, capped `Retry-After`, and cancellation during fallback delay. It also compares Native replay and compaction projection against Pi's real provider conversion output and exercises Pi's real cache-warming decision/dispatch path. Credentialed end-to-end backend interoperability remains outside the offline suite.

## Troubleshooting

See the [README troubleshooting guide](../README.md#troubleshooting) for session inspection and recovery. The contracts above explain diagnostics; there is no request-time compatibility evidence to hand-edit.

## Repository layout

| Path                                | Purpose                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `index.ts`                          | composition root selecting and installing the production operation              |
| `src/remote-compaction.ts`          | Pi hook orchestration, warming guard, notifications, cancel/abort, persistence  |
| `src/native-replay.ts`              | checkpoint records, branch continuity, context reconstruction, span replacement |
| `src/responses-projection.ts`       | narrow Pi `1.4.0` ordinary Responses projection adapter                        |
| `src/responses-tool-schema.ts`     | Pi-equivalent constrained JSON-schema declaration formatting                   |
| `src/retained-user-history.ts`      | retained-user validation and source-backed text/image budgeting                |
| `src/direct-responses-operation.ts` | one-attempt direct HTTP/SSE capability-gap adapter                              |
| `src/codex-responses-operation.ts`  | one-attempt Pi-mediated Codex SSE capture adapter                               |
| `tests/`                            | six offline contract files                                                      |
| `GLOSSARY.md`                       | canonical Remote compaction domain language                                     |
| `docs/adr/`                         | durable architecture decisions                                                  |
| `CHANGELOG.md`                      | release history and pending user-visible changes                                |

## License

MIT. See [LICENSE](../LICENSE).
