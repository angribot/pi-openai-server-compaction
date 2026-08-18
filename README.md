# pi-openai-server-compaction

A Pi extension for OpenAI Responses Remote compaction with native replay.

The extension targets Pi `0.84.2`. Eligible models are either any provider using the exact, case-sensitive `openai-responses` API type, or Pi's built-in `openai-codex` provider using the exact `openai-codex-responses` API type. Eligibility permits a Remote compaction attempt; actual endpoint capability is discovered from the result.

> **Status:** experimental. Install project-local first and keep rollback easy.

> **Persisted-session compatibility:** new checkpoints use a self-describing Native replay checkpoint record and preserve the producer's creation-time Compaction compatibility class. The structured `remoteCompaction.version: 2` records written by v0.8.0 remain readable with their original exact Model key semantics; they are not upgraded to class-based replay. Pre-refactor Remote compaction checkpoints—including Remote compaction v1 and v0.7.0 v2 details with a string model key, old tags, duplicated usage, or explicit-item replacement history—remain unreadable and fail closed. Before upgrading an affected older session, start a new session or return to a point before its Remote compaction checkpoint. No in-place migration is provided.

## Requirements

- Node `>=22`
- Pi `0.84.2` as the implementation baseline
- a selected model using exact API type `openai-responses`, or Pi's built-in `openai-codex` provider using `openai-codex-responses`
- working Pi-managed credentials for that model
- a Responses endpoint that accepts the Remote compaction v2 trigger and can replay the returned compaction item

The extension does not infer Remote compaction capability from model names or endpoint hostnames. Custom providers and relays are eligible through the exact `openai-responses` API contract. The `openai-codex-responses` exception is deliberately restricted to Pi's built-in `openai-codex` provider because that API uses Pi-managed ChatGPT OAuth and Codex routing rather than a third-party-compatible Responses contract. A small exact model-ID catalog is used only for Native replay compatibility, never capability or routing.

## Install

Project-local, recommended:

```bash
pi install -l git:github.com/angribot/pi-openai-server-compaction
```

Global:

```bash
pi install git:github.com/angribot/pi-openai-server-compaction
```

One-shot from a checkout:

```bash
git clone https://github.com/angribot/pi-openai-server-compaction.git
cd pi-openai-server-compaction
npm install
pi -e ./index.ts --model provider/model
```

## Remote compaction contract

On `session_before_compact`, an eligible model receives one immutable logical request containing only:

- the selected model;
- Pi's persisted, compaction-aware active linear-session compactable context projected into ordinary Responses input;
- the effective system instructions plus supplied custom compaction instructions;
- currently active ordinary function tools, when present;
- `store: false`; and
- exactly one terminal, payload-free `{ "type": "compaction_trigger" }`.

The direct `openai-responses` adapter adds `stream: true` as a transport detail and otherwise sends only that minimal request. For built-in Codex, the extension runs Pi's public provider operation with the current session ID, forced SSE, and provider retries disabled. Pi continues to own Codex authentication, account headers, endpoint routing, compression, and envelope fields such as `text`, `include`, `prompt_cache_key`, `tool_choice`, and `parallel_tool_calls`; the extension replaces only the model, projected input, instructions, active tools, `store`, and `stream` protocol invariants and removes competing `messages` and `previous_response_id` fields. The extension performs no local token estimation, truncation, retained-history budgeting, tool-output rewriting, or other context fitting. Endpoint context overflow is terminal.

Success requires an explicit raw `response.completed` or `response.done` event, Pi's Codex provider completion when applicable, and exactly one output item with `type: "compaction"` and string `encrypted_content`. Empty ciphertext is valid, an item `id` is optional, unknown item fields are preserved, and unrelated output items are ignored. Parseable usage is returned only through Pi's standard compaction usage field.

A successful operation returns one atomic custom compaction. It never calls `appendEntry()`, generates a second text summary, persists intermediate state, or falls back to Pi's text compactor.

## Persistence

The checkpoint summary is fixed protocol data:

```text
[Remote Responses compaction checkpoint]

Detailed context before this checkpoint is retained in the native replay artifact and is available only to compatible Responses models.
```

The matching `CompactionEntry.details` written by this release contains exactly:

```ts
{
  nativeReplayCheckpoint: {
    format: "native-replay-checkpoint/1",
    producer: {
      modelKey: {
        provider: string,
        api: "openai-responses" | "openai-codex-responses",
        id: string,
      },
      compactionCompatibilityClass: string | null,
    },
    replacementHistory: [compactionItem],
  },
}
```

The class is the opaque value resolved when the compaction item is created; explicit `null` means the producer was not cataloged. It is never recalculated for an old checkpoint. Replacement history contains only the newly accepted opaque compaction item. It does not contain retained user or assistant messages, the marker, a trigger, endpoint or routing data, response IDs, implementation tags, or duplicated usage. A persisted `openai-codex-responses` key is valid only with provider `openai-codex`.

The extension also reads the v0.8.0 legacy shape:

```ts
{
  remoteCompaction: {
    version: 2,
    modelKey: { provider, api, id },
    replacementHistory: [compactionItem],
  },
}
```

Legacy records retain exact Model key compatibility. They do not acquire a class from the current catalog.

Only the active branch's latest `CompactionEntry` can define replay state. The extension reconstructs that state from the branch on every hook; it keeps no replay cache, request-shape cache, invalidation tombstone, or lifecycle synchronization listener. A later ordinary compaction supersedes an older checkpoint. A fixed marker with missing, unknown-format, or malformed details is a broken checkpoint and fails closed.

For a checkpoint with a non-null class, every ordinary request appends a branch-local custom entry with `customType: "native-replay-compatibility-decision/1"` before transport. Its data identifies the owning checkpoint and records the selected target identity, the target's resolved class or `null`, and the compatibility result. Custom entries are excluded from model context. On reload, decisions are paired with following persisted assistant outcomes: a newer decision supersedes an abandoned pending request, error and aborted outcomes consume their decision without invalidating replay, and a successful incompatible outcome permanently invalidates that checkpoint on the branch. A successful outcome without valid matching evidence makes the checkpoint broken and fails closed.

## Native replay

Compatibility is structured and case-sensitive. When both the checkpoint producer and selected target have non-null Compaction compatibility classes, both must be Eligible models and the opaque classes must be equal. Equal classes may cross model IDs, Pi provider identities, and the two Eligible API contracts (`openai-responses` and built-in `openai-codex-responses`). If either class is unavailable, compatibility falls back to exact `{ provider, api, model ID }` equality. Credentials, accounts, headers, and resolved endpoints remain routing data rather than compatibility identity.

The release-managed catalog is copied from [OpenAI Codex model metadata](https://github.com/openai/codex/blob/9b9b614b02ba04df55479284749c5cbbed695c24/codex-rs/protocol/src/openai_models.rs) and currently maps `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.5` to opaque class `2911`, and `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` to opaque class `3000`. Values are strings and carry no numeric meaning. The extension does not infer entries from family names, aliases, providers, or endpoints, fetch a private `/models` endpoint, or accept user-supplied mappings.

For a compatible ordinary request, the extension:

1. reconstructs the checkpoint marker and Pi-retained pre-compaction entries from the active branch;
2. projects them through the same ordinary Responses adapter used for compaction;
3. requires a full-array `payload.input` with exactly one contiguous wire-equivalent replay replacement span;
4. replaces only that span with the one-item replacement history;
5. preserves provider items before and after the span; and
6. removes competing `messages` and `previous_response_id` fields.

A malformed active state, invalidated branch, non-array input, or missing/ambiguous span stops the ordinary request through `ctx.abort()` and emits an explicit error. It does not throw from the hook and allow Pi to continue with the old payload.

Selecting an incompatible model leaves its ordinary payload and transport untouched and emits a compatibility warning. For a class-aware checkpoint, the request-time incompatible decision is persisted before transport. Selection, an abandoned request, a failed request, or an aborted assistant turn does not itself invalidate replay. A persisted successful assistant turn governed by an incompatible decision does invalidate the branch, including text and tool-calling turns. For legacy or class-absent checkpoints, successful exact-identity mismatch retains the same invalidation behavior. After invalidation, compatible replay stops and further Remote compaction is cancelled; the extension never drops the incompatible turn or constructs a best-effort mixed-model suffix.

## Repeated Remote compaction

A repeated request may select another Eligible model with the same non-null Compaction compatibility class. It contains, in order:

1. the current one-item replacement history;
2. the projected model-visible branch suffix after the owning `CompactionEntry`; and
3. one new terminal compaction trigger.

It excludes the checkpoint marker, Pi-retained pre-compaction entries, previous triggers, duplicate old compaction items, and retained explicit history. A newly accepted compaction item atomically supersedes the previous replacement history and records the newly selected producer's current class.

## Retry and failure behavior

`src/direct-responses-operation.ts` and `src/codex-responses-operation.ts` each perform one attempt. The Codex adapter also sets Pi's provider retry count to zero. `src/remote-compaction.ts` owns the only retry loop: one initial attempt plus at most two retries, always with the same deeply immutable logical request.

Transient network, read, idle-timeout, premature-EOF, malformed pre-completion stream, incomplete-response, rate-limit, overload, and retryable HTTP failures may retry. Caller abort, authentication or projection failure, clearly non-transient HTTP failures, invalid request or prompt, unsupported operation, context overflow, quota or policy failure, completed-response item validation failure, and retry exhaustion are terminal. A terminal semantic error overrides an otherwise retryable HTTP status. Standard `Retry-After` is preferred; fallback backoff is finite, capped, jittered, and abort-aware.

Every eligible terminal failure returns `{ cancel: true }`, preventing Pi text-compaction fallback and discarding partial item or usage data.

## Transport boundary and limitations

The extension does not register or override providers. Ordinary requests remain owned by the selected provider transport; this extension only persists request-time compatibility evidence and patches Native replay in `before_provider_request`. Equal-class service acceptance across routes is a runtime assumption: a target rejection follows the normal fail-closed path and does not trigger artifact stripping or a portable fallback.

The Remote compaction operation uses one of two narrow SSE adapters because Pi `0.84.2` does not expose a provider-aware raw Responses operation that proves explicit completion while preserving unknown output items such as `compaction`. Exact `openai-responses` models use direct HTTP/SSE with Pi-resolved routing and authentication. Built-in Codex uses Pi's public provider operation plus a per-call cloned-response capture, retaining Pi's OAuth refresh, account headers, endpoint construction, compression, and request envelope. No handwritten Codex transport or fallback request is used, and ordinary Codex requests remain free to use Pi's configured WebSocket or SSE transport.

Other extensions' request mutations and provider-aware raw-operation composition remain outside this package's current contract.

The local Responses projection adapter covers Pi `0.84.2` ordinary semantics for supported persisted messages, images and placeholders, assistant text identity and phase, same-model signed reasoning, ordinary function calls/results and missing-output normalization, built-in custom-message normalization, and active ordinary function tools. Compaction compatibility classes broaden only opaque compaction-item replay; signed or encrypted reasoning, tool-call IDs, thought signatures, and provider namespace metadata retain their existing exact-identity rules. Detectable model-visible context that cannot be represented faithfully cancels before transport. Grammar custom-tool metadata, constrained sampling, deferred tool search, provider distinctions already erased by Pi, and ephemeral provider-payload mutations are outside the supported contract.

Architecture decisions:

- [ADR 0001: Select models by API contract](https://github.com/angribot/pi-openai-server-compaction/blob/main/docs/adr/0001-select-models-by-api-contract.md)
- [ADR 0002: Prefer native replay continuity](https://github.com/angribot/pi-openai-server-compaction/blob/main/docs/adr/0002-prefer-native-replay-continuity.md)
- [ADR 0003: Keep provider transport independent](https://github.com/angribot/pi-openai-server-compaction/blob/main/docs/adr/0003-keep-provider-transport-independent.md)
- [ADR 0004: Keep resolved endpoints out of model identity](https://github.com/angribot/pi-openai-server-compaction/blob/main/docs/adr/0004-keep-resolved-endpoints-out-of-model-identity.md) — superseded by ADR 0005
- [ADR 0005: Use creation-time compatibility classes for Native replay](https://github.com/angribot/pi-openai-server-compaction/blob/main/docs/adr/0005-use-creation-time-compatibility-classes.md)

## Testing

The offline suite uses Node's built-in test runner and requires no credentials or network:

```bash
npm test
```

Its four focused files are:

- `tests/loader.test.ts` — production loader, package factory, exactly two hooks, and no provider override;
- `tests/responses-projection.test.ts` — supported ordinary Responses projection and fail-closed context;
- `tests/remote-compaction-operation.test.ts` — direct and Pi-mediated one-attempt SSE operations, payload ownership, raw completion, validation, failure classification, usage, and abort;
- `tests/remote-compaction.test.ts` — protocol retry, cancellation, checkpoint formats, request-time compatibility evidence, branch reconstruction, Native replay, invalidation, and repeated compaction.

The credentialed paid live scenario requires Pi CLI `0.84.2`, an explicit Eligible model whose ID is present in the catalog above, working Pi-managed credentials and network, endpoint Remote compaction capability, and permission to incur two compactions plus continuation calls:

```bash
pi --version
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=provider/model npm run test:live
```

It covers one linear first compaction, same-process replay and Compatibility decision persistence, repeated compaction, and fresh-process reload with new branch-local evidence. If the model variable, catalog entry, or credentials are unavailable, live acceptance is not considered passed; report it as not run.

## Troubleshooting

- Use `pi --no-extensions` to bypass all extensions while recovering a session.
- Inspect the active branch's latest compaction entry in the session JSONL, especially `summary` and `details.nativeReplayCheckpoint`; for v0.8.0 legacy records, inspect `details.remoteCompaction`.
- If a checkpoint predates this refactor, start a new session or return before that checkpoint; there is no migration reader.
- If Native replay reports a missing or ambiguous span, do not continue from the incomplete payload. Recover through a new session or a complete pre-checkpoint branch point.
- If Native replay reports malformed or missing compatibility evidence, recover through a branch point before the affected class-aware checkpoint; the extension will not reinterpret the assistant turn from the current catalog.
- If an endpoint rejects an equal-class compaction item, treat that route as unavailable for this session; the extension does not retry without the item or create a portable summary.
- If an endpoint rejects the trigger, overflows, or exhausts retries, Remote compaction is cancelled and Pi's text compactor is intentionally not invoked.

## Repository layout

| Path                                | Purpose                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `src/index.ts`                      | composition root selecting and installing the production operation                |
| `src/remote-compaction.ts`          | two-hook Remote compaction protocol, persistence, retry, invalidation, and replay |
| `src/responses-projection.ts`       | narrow Pi `0.84.2` ordinary Responses projection adapter                          |
| `src/direct-responses-operation.ts` | one-attempt direct HTTP/SSE capability-gap adapter                                |
| `src/codex-responses-operation.ts`  | one-attempt Pi-mediated Codex SSE capture adapter                                 |
| `tests/`                            | four offline contract files plus one credentialed live scenario                   |
| `CONTEXT.md`                        | canonical Remote compaction domain language                                       |
| `docs/adr/`                         | durable architecture decisions                                                    |
| `CHANGELOG.md`                      | release history and pending user-visible changes                                  |

## License

MIT. See `LICENSE.md`.
