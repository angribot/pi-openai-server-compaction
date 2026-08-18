# pi-openai-server-compaction

A Pi extension for OpenAI Responses Remote compaction with native replay.

The extension targets Pi `0.84.2`. Eligible models are either any provider using the exact, case-sensitive `openai-responses` API type, or Pi's built-in `openai-codex` provider using the exact `openai-codex-responses` API type. Eligibility permits a Remote compaction attempt; actual endpoint capability is discovered from the result.

> **Status:** experimental. Install project-local first and keep rollback easy.

> **Breaking persisted-session change:** this refactor does not replay pre-refactor Remote compaction checkpoints. This includes Remote compaction v1 and v0.7.0 v2 details, whose string model key, old tags, duplicated usage, and possible explicit-item replacement history do not match the new exact v2 schema. If the active branch's latest compaction uses the fixed Remote compaction checkpoint marker but lacks valid new v2 details, eligible ordinary requests stop and further Remote compaction is cancelled; the extension does not resurrect an older checkpoint or send incomplete context. Before upgrading, start a new session or return to a point before the Remote compaction checkpoint. No in-place migration is provided.

## Requirements

- Node `>=22`
- Pi `0.84.2` as the implementation baseline
- a selected model using exact API type `openai-responses`, or Pi's built-in `openai-codex` provider using `openai-codex-responses`
- working Pi-managed credentials for that model
- a Responses endpoint that accepts the Remote compaction v2 trigger and can replay the returned compaction item

The extension does not infer capability from model names or endpoint hostnames. Custom providers and relays are eligible through the exact `openai-responses` API contract. The `openai-codex-responses` exception is deliberately restricted to Pi's built-in `openai-codex` provider because that API uses Pi-managed ChatGPT OAuth and Codex routing rather than a third-party-compatible Responses contract.

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

The matching `CompactionEntry.details` contains exactly:

```ts
{
  remoteCompaction: {
    version: 2,
    modelKey: {
      provider: string,
      api: "openai-responses" | "openai-codex-responses",
      id: string,
    },
    replacementHistory: [compactionItem],
  },
}
```

Replacement history contains only the newly accepted opaque compaction item. It does not contain retained user or assistant messages, the marker, a trigger, endpoint or routing data, response IDs, implementation tags, or duplicated usage. A persisted `openai-codex-responses` key is valid only with provider `openai-codex`.

Only the active branch's latest `CompactionEntry` can define replay state. The extension reconstructs that state from the branch on every hook; it keeps no replay cache, request-shape cache, invalidation tombstone, or lifecycle synchronization listener. A later ordinary compaction supersedes an older checkpoint. A fixed marker with missing, legacy, unknown-version, or malformed details is a broken checkpoint and fails closed.

## Native replay

Compatibility is exact, structured, and case-sensitive across the persisted provider, API type, and model ID. Credentials and resolved endpoints are routing data, not model identity. Pi `0.84.2` does not expose Codex's provider-resolved Compaction compatibility class, so model aliases are not assumed to share native replay state.

For a compatible ordinary request, the extension:

1. reconstructs the checkpoint marker and Pi-retained pre-compaction entries from the active branch;
2. projects them through the same ordinary Responses adapter used for compaction;
3. requires a full-array `payload.input` with exactly one contiguous wire-equivalent replay replacement span;
4. replaces only that span with the one-item replacement history;
5. preserves provider items before and after the span; and
6. removes competing `messages` and `previous_response_id` fields.

A malformed active state, invalidated branch, non-array input, or missing/ambiguous span stops the ordinary request through `ctx.abort()` and emits an explicit error. It does not throw from the hook and allow Pi to continue with the old payload.

Selecting an incompatible model leaves its ordinary payload and transport untouched and emits a compatibility warning. Selection, a failed request, or an aborted assistant turn does not invalidate replay. A persisted successful assistant turn from an incompatible model does invalidate the branch, including text and tool-calling turns. After invalidation, compatible replay stops and further Remote compaction is cancelled; the extension never drops the incompatible turn or constructs a best-effort mixed-model suffix.

## Repeated Remote compaction

A repeated request contains, in order:

1. the current one-item replacement history;
2. the projected model-visible branch suffix after the owning `CompactionEntry`; and
3. one new terminal compaction trigger.

It excludes the checkpoint marker, Pi-retained pre-compaction entries, previous triggers, duplicate old compaction items, and retained explicit history. A newly accepted compaction item atomically supersedes the previous replacement history.

## Retry and failure behavior

`src/direct-responses-operation.ts` and `src/codex-responses-operation.ts` each perform one attempt. The Codex adapter also sets Pi's provider retry count to zero. `src/remote-compaction.ts` owns the only retry loop: one initial attempt plus at most two retries, always with the same deeply immutable logical request.

Transient network, read, idle-timeout, premature-EOF, malformed pre-completion stream, incomplete-response, rate-limit, overload, and retryable HTTP failures may retry. Caller abort, authentication or projection failure, clearly non-transient HTTP failures, invalid request or prompt, unsupported operation, context overflow, quota or policy failure, completed-response item validation failure, and retry exhaustion are terminal. A terminal semantic error overrides an otherwise retryable HTTP status. Standard `Retry-After` is preferred; fallback backoff is finite, capped, jittered, and abort-aware.

Every eligible terminal failure returns `{ cancel: true }`, preventing Pi text-compaction fallback and discarding partial item or usage data.

## Transport boundary and limitations

The extension does not register or override providers. Ordinary requests remain owned by the selected provider transport; this extension only patches native replay in `before_provider_request`.

The Remote compaction operation uses one of two narrow SSE adapters because Pi `0.84.2` does not expose a provider-aware raw Responses operation that proves explicit completion while preserving unknown output items such as `compaction`. Exact `openai-responses` models use direct HTTP/SSE with Pi-resolved routing and authentication. Built-in Codex uses Pi's public provider operation plus a per-call cloned-response capture, retaining Pi's OAuth refresh, account headers, endpoint construction, compression, and request envelope. No handwritten Codex transport or fallback request is used, and ordinary Codex requests remain free to use Pi's configured WebSocket or SSE transport.

Other extensions' request mutations and provider-aware raw-operation composition remain outside this package's current contract.

The local Responses projection adapter covers Pi `0.84.2` ordinary semantics for supported persisted messages, images and placeholders, assistant text identity and phase, same-model signed reasoning, ordinary function calls/results and missing-output normalization, built-in custom-message normalization, and active ordinary function tools. Detectable model-visible context that cannot be represented faithfully cancels before transport. Grammar custom-tool metadata, constrained sampling, deferred tool search, provider distinctions already erased by Pi, and ephemeral provider-payload mutations are outside the supported contract.

Architecture decisions:

- [ADR 0001: Select models by API contract](https://github.com/angribot/pi-openai-server-compaction/blob/main/docs/adr/0001-select-models-by-api-contract.md)
- [ADR 0002: Prefer native replay continuity](https://github.com/angribot/pi-openai-server-compaction/blob/main/docs/adr/0002-prefer-native-replay-continuity.md)
- [ADR 0003: Keep provider transport independent](https://github.com/angribot/pi-openai-server-compaction/blob/main/docs/adr/0003-keep-provider-transport-independent.md)
- [ADR 0004: Keep resolved endpoints out of model identity](https://github.com/angribot/pi-openai-server-compaction/blob/main/docs/adr/0004-keep-resolved-endpoints-out-of-model-identity.md)

## Testing

The offline suite uses Node's built-in test runner and requires no credentials or network:

```bash
npm test
```

Its four focused files are:

- `tests/loader.test.ts` — production loader, package factory, exactly two hooks, and no provider override;
- `tests/responses-projection.test.ts` — supported ordinary Responses projection and fail-closed context;
- `tests/direct-responses-operation.test.ts` — direct and Pi-mediated one-attempt SSE operations, payload ownership, raw completion, validation, failure classification, usage, and abort;
- `tests/remote-compaction.test.ts` — protocol retry, cancellation, persistence, reconstruction, native replay, compatibility, invalidation, and repeated compaction.

The credentialed paid live scenario requires Pi CLI `0.84.2`, an explicit eligible model, working Pi-managed credentials and network, endpoint Remote compaction capability, and permission to incur two compactions plus continuation calls:

```bash
pi --version
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=provider/model npm run test:live
```

It covers one linear first-compaction, same-process replay, repeated-compaction, fresh-process reload scenario. If the model variable or credentials are unavailable, live acceptance is not considered passed; report it as not run.

## Troubleshooting

- Use `pi --no-extensions` to bypass all extensions while recovering a session.
- Inspect the active branch's latest compaction entry in the session JSONL, especially `summary` and `details.remoteCompaction`.
- If a checkpoint predates this refactor, start a new session or return before that checkpoint; there is no migration reader.
- If native replay reports a missing or ambiguous span, do not continue from the incomplete payload. Recover through a new session or a complete pre-checkpoint branch point.
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
