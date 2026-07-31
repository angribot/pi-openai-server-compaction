# Test plan

## Test ownership rule

Tests committed to this repository must be necessary to cover the remote-compaction extension's own core contract.

Do not commit:

- cross-extension loading matrices;
- provider allowlist fixtures from a transport extension;
- HTTP-versus-WebSocket composition matrices;
- machine-specific provider names or settings;
- temporary live probes.

Cross-extension composition remains an external, ephemeral validation. A defect found there should be reduced to the owning project's interface before becoming a repository test.

## Core goals

1. Verify remote compaction is enabled exactly for `model.api === "openai-responses"`.
2. Verify provider names do not control eligibility.
3. Verify the extension never registers or overrides a provider.
4. Verify the compaction request reproduces the current Responses request shape where required.
5. Verify a successful response contains one valid opaque compaction artifact.
6. Verify persisted artifacts reconstruct safe replacement history after lifecycle changes.
7. Verify later compatible ordinary requests receive replacement history through `before_provider_request`.
8. Verify incompatible APIs and models are left untouched.
9. Verify transient remote failures retry the same request at most twice and final failure cancels compaction without invoking Pi's text compactor.

## Offline automated checks

Run:

```bash
npm test
```

This runs TypeScript checking and `scripts/smoke.mjs`.

Required smoke coverage:

- extension entrypoint loads;
- `openai-responses` eligibility is provider-agnostic;
- non-`openai-responses` APIs are rejected;
- endpoint normalization uses the model's configured Responses base URL;
- compaction request body ends with a `compaction_trigger`;
- request headers opt into compaction v2 and SSE;
- SSE event parsing accepts one completed compaction result;
- malformed, missing, or duplicate compaction artifacts are rejected;
- usage and cost normalization round-trip through persisted details;
- v1 and v2 persisted details reconstruct safely;
- remote replacement history is injected into the final ordinary payload;
- successful remote compaction stores the fixed native replay checkpoint marker;
- successful remote compaction performs one request when no retryable failure occurs;
- Codex-classified transient HTTP failures and incomplete streams retry the same payload at most twice;
- fatal HTTP or artifact-validation failures do not retry;
- abort during retry backoff prevents the next attempt;
- final remote and authentication failures explicitly cancel compaction without local fallback;
- conflicting `messages` and `previous_response_id` fields are removed during replay;
- the extension does not call `registerProvider`.

## Manual core validation

### 1. Eligible provider

- Select any model configured with `api: "openai-responses"`.
- Start or reload Pi with this extension enabled.
- Execute a normal turn.
- Force a compaction.
- Confirm the session receives a Pi compaction entry rather than an extension crash.

### 2. Persisted artifact

Inspect the session JSONL and confirm:

- `details.remoteCompaction.version` is `2`;
- `details.remoteCompaction.implementation` is `responses_compaction_v2`;
- `replacementHistory` is an array;
- it contains exactly one opaque `compaction` item with encrypted content;
- the model key matches the provider, API, and model that performed compaction.

### 3. Same-session continuation

- Store a fact before compaction.
- Compact remotely.
- Ask for the fact afterward.
- Confirm the compatible model can recover it from the opaque artifact.

### 4. Repeated compaction

- Continue the session after the first remote compaction.
- Perform another compaction.
- Confirm the second request uses reconstructed explicit remote history and returns a new valid artifact.
- Continue again and verify coherence.

### 5. Model compatibility

- Compact under one eligible model.
- Switch to a different or incompatible model and complete a turn.
- Switch back to the original model.
- Confirm incompatible turns do not pollute reconstructed remote history.

### 6. Resume, tree, and fork

After a successful remote compaction, separately verify:

- process restart or session resume;
- extension reload;
- tree navigation;
- fork from an earlier point.

The session must remain usable, and matching remote state must reconstruct only where the active branch and model allow it.

### 7. Remote failure cancellation

Use an eligible model whose endpoint does not implement compaction v2, or inject a controlled remote failure outside committed tests.

Confirm:

- retryable failures make at most three total attempts;
- the final extension result cancels compaction rather than invoking Pi's text compactor;
- no separate summary request is started;
- no invalid or partial remote artifact is persisted;
- overflow recovery does not retry the aborted turn when remote compaction fails.

## Credentialed live regression

Run:

```bash
npm run test:live
```

Override the target model when necessary:

```bash
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=provider/model npm run test:live
```

The maintained harness is:

`tests/live/openai-compaction-rpc-live.ts`

Its core scenarios are:

- same-process continuity;
- reduced-plaintext replay;
- fork after compaction;
- resume/reload after compaction;
- model switch away and back;
- resume after a model-switch round trip.

The reduced-plaintext scenario applies to any configured eligible provider; it is not limited by provider name.

## Current transport limitation

The compaction RPC currently uses direct HTTP/SSE. Ordinary post-compaction requests remain transport-neutral after history injection.

Do not add a cross-extension test for the missing raw transport seam to this repository. The capability gap, rejected workarounds, and future acceptance criteria are documented in [`TODO.md`](TODO.md).

## Benchmarks

Benchmark evidence and reproduction instructions remain under:

- `benchmarks/product-defaults/`;
- `benchmarks/native-vs-text/`.

Benchmarks measure compaction/replay quality and resource use. They are not transport composition tests.
