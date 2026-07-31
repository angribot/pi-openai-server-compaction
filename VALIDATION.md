# Validation

## Current implementation scope

The current extension:

- enables remote compaction only for `model.api === "openai-responses"`;
- does not register or override providers;
- sends the compaction RPC directly over HTTP/SSE;
- persists a Responses compaction v2 artifact and fixed native replay checkpoint marker in Pi session history;
- injects reconstructed replacement history into later compatible ordinary requests;
- returns control to Pi's default compaction path after a remote failure;
- leaves transport selection for those ordinary requests to Pi's provider path.

`openai-codex-responses`, Azure-specific APIs, extension-owned WebSocket transport, and live `previous_response_id` continuation are no longer part of the current implementation.

## Offline validation

The project-owned offline suite is:

```bash
npm test
```

It consists of TypeScript checking and `scripts/smoke.mjs`. The suite was rerun after the compaction-only refactor and documentation update; both typecheck and smoke passed.

The smoke contract covers:

- provider-agnostic exact API gating;
- generic Responses endpoint resolution;
- compaction request and header construction;
- SSE event parsing and artifact validation;
- retained-history construction;
- persisted detail reconstruction and usage normalization;
- ordinary payload history injection;
- fixed checkpoint marker construction and one-request success path;
- remote failure and abort fallback semantics;
- removal of conflicting replay fields;
- the requirement that this extension does not register a provider.

Cross-extension transport fixtures are intentionally absent.

## Runtime validation after the refactor

### Reloaded real session

After reloading the modified extension, a real `openai-responses` session performed remote compaction successfully.

The persisted session event contained:

- `fromHook: true`;
- `tokensBefore: 143530`;
- `details.remoteCompaction.version: 2`;
- `implementation: responses_compaction_v2`;
- a matching provider/API/model key;
- replacement history containing retained explicit messages and exactly one opaque `compaction` item with encrypted content.

The first ordinary request after compaction completed successfully with a much smaller submitted context while retaining the task's goals, constraints, modified-file state, and next steps. This validates the current `before_provider_request` replay path in a reloaded process.

### Provider-agnostic relay session

A separately configured third-party provider using `api: "openai-responses"` also completed remote compaction v2, continued for ordinary turns, compacted a second time, and continued again.

This validates that current eligibility and endpoint resolution are not tied to a built-in provider name.

An independently configured transport extension handled the ordinary provider requests over WebSocket, while the compaction RPC remained HTTP/SSE. That split is the current known transport limitation rather than the final desired transport architecture. It is documented in [`TODO.md`](TODO.md), not encoded as a cross-project test here.

## Credentialed live harness

The maintained live harness is:

`tests/live/openai-compaction-rpc-live.ts`

It exercises the extension's own continuity contract:

1. same-process recall across compaction;
2. reduced-plaintext replay where the native artifact retains the secret while the checkpoint marker does not;
3. fork safety;
4. resume/reload continuity;
5. model switch away and back;
6. resume after a model-switch round trip.

The reduced-plaintext scenario now applies to any eligible configured provider instead of checking for a specific provider name. It verifies native artifact recovery, not portable-summary quality.

Credentialed live runs are not part of `npm test`. Record a new full live run when preparing a release or changing protocol, reconstruction, or lifecycle behavior.

## Responses compaction v2 protocol evidence

The v2 request uses the normal Responses endpoint with a trailing:

```json
{ "type": "compaction_trigger" }
```

A valid result must include a completed response and exactly one opaque `compaction` output item. That item is persisted in `details.remoteCompaction` and replayed as part of later explicit Responses input. The corresponding `CompactionEntry.summary` is the fixed native replay checkpoint marker, not a second model-generated summary.

Earlier direct probes and live harness runs established that replaying the opaque artifact can recover information omitted from the checkpoint marker. Legacy version 1 session artifacts from the former `/responses/compact` implementation remain readable for compatibility, but new compactions use v2.

## Controlled product-defaults benchmark

A retained GPT-5.6 Sol benchmark compared Pi 0.80.9's actual default compaction policy, this extension's former 20K Responses compaction/replay policy, and a full-context control. It increased task difficulty by replacing filler with exact state at a fixed roughly 50K-token history, without imposing an output cap from one arm on another. The run is historical evidence and does not validate the current 64K retained-message budget.

On held-out seeds 301–304:

- full context: 600/600;
- native compaction/replay: 468/600 (78.0%);
- Pi default compaction: 288/600 (48.0%).

Native compaction used more output, compaction cost, and downstream input, with substantial allocation variability. The supported conclusion is that the native default policy preserved more old state in aggregate while using more resources—not that it was more accurate at an equal budget.

See:

- `benchmarks/product-defaults/REPORT.md`;
- `benchmarks/product-defaults/README.md`;
- `benchmarks/product-defaults/CALIBRATION.md`.

## Correction to the earlier matched-cap benchmark

The earlier native-vs-text run selected each text summary's maximum output tokens after observing its paired native request's output usage. That creates a one-sided, post-treatment cap and is not a symmetric matched-budget comparison.

Its raw results remain reproducible, but its same-budget interpretation is superseded by the methodological notes in:

- `benchmarks/native-vs-text/REPORT.md`;
- `benchmarks/native-vs-text/README.md`.

## Current limitations

- The target endpoint must implement Responses compaction v2.
- Compatible-model continuity depends on replaying the opaque artifact; incompatible models may not recover detailed pre-compaction context from the fixed marker.
- The compaction RPC currently uses direct HTTP/SSE because Pi has no public provider-aware raw transport seam that preserves the unconsumed event stream.
- An independent provider transport can carry ordinary replay requests but cannot transparently intercept the compaction RPC today.
- The extension does not provide automatic context management, provider persistence, or live response continuation.
- Cross-extension transport composition is validated externally and is not a repository test matrix.
