# Architecture

This document describes the current compaction-only architecture after removing provider override, WebSocket, and live `previous_response_id` ownership from this extension.

## Design goals

The extension has one responsibility: add remote Responses compaction and replay to models whose API is exactly `openai-responses`.

It must remain:

- **provider-agnostic** — eligibility is based on `model.api`, not a provider name;
- **ordinary-request transport-neutral** — it rewrites a completed provider payload but does not register a provider or select its transport;
- **native-continuity first** — compatible Responses models replay the opaque artifact; the session stores a fixed checkpoint marker rather than a second model-generated summary;
- **independently loadable** — remote compaction continues to work without a separate transport extension.

The current Pi API does not provide a provider-aware raw transport seam for the compaction RPC itself. That request therefore remains HTTP/SSE; the known gap is tracked in [`TODO.md`](TODO.md).

The extension has no runtime configuration: remote compaction is always enabled for eligible models, and activation notifications are disabled.

## Eligibility

Remote compaction is enabled only when:

```ts
model.api === "openai-responses"
```

Provider name and endpoint hostname do not decide eligibility. `openai-codex-responses`, `azure-openai-responses`, and other APIs are outside the current scope.

An eligible endpoint must still implement Responses compaction v2. If it rejects or cannot complete the remote request, Pi falls back to its local compaction behavior.

## High-level flow

### Ordinary turn before any remote compaction

1. Pi builds the provider request.
2. `src/index.ts` observes `before_provider_request` for eligible Responses models.
3. The extension records the current `reasoning` and `text` request shape for a later compaction request.
4. With no active remote artifact, it returns no payload change.
5. Pi's provider implementation sends the request through its independently selected transport.

The extension does not add `store`, `context_management`, or `previous_response_id`.

### Compaction turn

1. Pi emits `session_before_compact`.
2. `src/index.ts` verifies that the active model uses `openai-responses`.
3. It resolves authentication through Pi's model registry.
4. It chooses the explicit Responses history:
   - reconstructed remote history when the session was compacted before;
   - otherwise the current Pi branch converted to Responses items.
5. `src/remote-compaction.ts` sends one normal Responses request with a trailing `compaction_trigger` directly over HTTP/SSE.
6. The parser requires one completed response and exactly one opaque `compaction` item.
7. On remote success, Pi persists:
   - a fixed native replay checkpoint marker in `CompactionEntry.summary`;
   - `details.remoteCompaction` containing version, implementation, model key, replacement history, and optional usage.
8. On remote failure, the handler returns `undefined` so Pi's default compaction path runs sequentially. An aborted request returns `{ cancel: true }`.

### Ordinary turn after remote compaction

1. Session lifecycle reconstruction places the latest compatible remote artifact in runtime state.
2. Pi builds an ordinary `openai-responses` payload.
3. `before_provider_request` replaces its `input` with normalized explicit remote history.
4. The patch removes conflicting legacy `messages` and `previous_response_id` fields.
5. Pi's selected provider transport sends the final ordinary request.
6. Compatible completed messages are converted to Responses items and appended to runtime explicit history.

This payload seam is how ordinary post-compaction requests compose with an independent provider transport without either extension importing the other.

## Current transport boundary

There are two distinct paths:

```text
Remote compaction RPC
  session_before_compact
    -> callRemoteCompactionEndpoint
    -> global fetch
    -> HTTP/SSE

Ordinary post-compaction request
  Pi provider request construction
    -> before_provider_request history replacement
    -> selected provider transport
```

The second path is transport-neutral. The first is not currently interceptable by another extension because Pi exposes payload/header hooks but no public raw request transport middleware that carries provider, model, session, and operation metadata while preserving the unconsumed Responses event stream.

Unsafe workarounds such as global fetch monkey-patching, URL-based provider inference, or a private cross-extension registry are intentionally rejected. See [`TODO.md`](TODO.md).

## Persisted state

Pi session JSONL is authoritative. The extension persists no separate database.

A successful v2 compaction stores:

```text
CompactionEntry.details.remoteCompaction
  version: 2
  provider: openai-responses-compaction
  implementation: responses_compaction_v2
  modelKey: provider:api:model
  replacementHistory: retained explicit items + opaque compaction item
  usage: optional normalized usage snapshot
```

Version 1 legacy artifacts remain readable for session compatibility.

The checkpoint marker is intentionally not a portable text summary. It explains that detailed pre-compaction context is retained in the native replay artifact and requires a compatible Responses model. Switching to an incompatible model may therefore lose access to detailed pre-compaction context; native replay continuity is the preferred path.

## Runtime state

`src/state.ts` keeps only ephemeral per-session caches:

- reconstructed remote compaction state;
- the latest observed Responses `reasoning` and `text` request shape.

It does not keep:

- WebSocket connections;
- provider registrations;
- response continuation IDs;
- transport fallback state.

Runtime state is cleared or reconstructed across session start, switch, fork, tree navigation, compaction, model selection, and shutdown as appropriate.

## Module responsibilities

### `src/index.ts`

Pi lifecycle orchestration:

- gate on exact `openai-responses` API type;
- run remote compaction and hand failures back to Pi's default path;
- persist remote details through Pi's compaction entry;
- reconstruct state from the active branch;
- inject replacement history in `before_provider_request`;
- extend compatible runtime history after completed messages;
- clear ephemeral state on lifecycle boundaries.

It must not call `registerProvider`.

### `src/remote-compaction.ts`

Responses compaction protocol implementation:

- convert Pi messages and tool data to Responses items;
- normalize explicit history for prompt replay;
- build endpoint URLs, headers, and request bodies;
- send and parse the HTTP/SSE compaction request;
- validate the opaque artifact;
- retain recent user items under the compaction replay budget;
- normalize usage and cost;
- reconstruct v1 and v2 persisted artifacts;
- provide the fixed native replay checkpoint marker.

### `src/openai.ts`

Small API and payload helpers:

- exact `openai-responses` gating;
- stable model keys;
- Responses payload shape checks;
- reasoning/text extraction;
- replacement-history payload patching;
- model compatibility checks for completed messages.

### `src/state.ts`

In-memory remote-history and request-shape caches only.

Pi owns compaction thresholds. A provider or transport extension owns transport and continuation policy.

## Safety rules

- Never replay a remote artifact under a different model key.
- Never extend remote history with an assistant completion from a different provider/model.
- Validate persisted artifacts before reconstructing them.
- Require exactly one opaque compaction item from a completed remote response.
- Store a fixed native replay checkpoint marker instead of running a second summary request.
- Leave an ordinary payload untouched until a matching remote artifact exists.
- Do not register or override providers.
- Do not own WebSocket or `previous_response_id` state.
- Return control to Pi's default compaction when the remote RPC fails.

## Testing boundary

Project-owned automated tests cover only this extension's core contract:

- exact API gating;
- endpoint, header, and request-body construction;
- event parsing and artifact validation;
- persisted-state reconstruction;
- payload history injection;
- lifecycle-safe history extension;
- absence of provider registration.

Cross-extension transport matrices and provider-specific experiments remain external, temporary validation rather than repository fixtures.

## Suggested reading order

1. `README.md`
2. `ARCHITECTURE.md`
3. `TODO.md`
4. `src/index.ts`
5. `src/remote-compaction.ts`
6. `src/openai.ts`
7. `src/state.ts`
8. `scripts/smoke.mjs`
9. `tests/live/openai-compaction-rpc-live.ts`
