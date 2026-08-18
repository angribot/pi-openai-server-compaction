# pi-openai-server-compaction

A provider-agnostic Pi extension that adds remote compaction to models using the plain `openai-responses` API.

On a Pi compaction event, the extension sends the conversation to the model's Responses endpoint over HTTP/SSE with a trailing `compaction_trigger`. It persists the returned compaction item in replacement history with a checkpoint marker, then injects that history into later compatible requests. Those later ordinary requests remain transport-neutral.

> **Status:** experimental but live-tested. Install project-local first and keep rollback easy.

## Scope

Remote compaction is enabled by API type, not provider name:

| Model API | Remote compaction |
|---|---:|
| `openai-responses` | Yes |
| `openai-codex-responses` | No |
| `azure-openai-responses` | No |
| Other APIs | No |

Any provider can participate when its model uses `openai-responses` and its Responses endpoint supports the compaction protocol. The extension retries transient remote failures twice, then cancels compaction instead of falling back to Pi's text compactor. This preserves native replay semantics and prevents a compaction item from being irreversibly replaced by a text summary that cannot interpret it.

See [ADR 0001](docs/adr/0001-select-models-by-api-contract.md) and [ADR 0002](docs/adr/0002-prefer-native-replay-continuity.md) for the eligibility and continuity decisions.

## Independent transport composition

This extension does not register or override providers. For ordinary post-compaction turns, it only rewrites the final `openai-responses` payload in `before_provider_request`; Pi's selected provider transport then sends that payload.

The remote-compaction RPC itself currently calls the Responses endpoint directly over HTTP/SSE. Pi does not yet expose a provider-aware raw transport seam that preserves the opaque compaction event, so an independently configured WebSocket transport cannot transparently intercept that RPC without unsafe global patching or a private cross-extension protocol.

Current behavior is therefore:

1. remote-compaction RPC: HTTP/SSE;
2. later ordinary request: replacement history injected by this extension;
3. ordinary request transport: selected independently by the provider or a transport extension.

The missing raw transport API and its constraints are tracked in [issue #8](https://github.com/angribot/pi-openai-server-compaction/issues/8). The ownership boundary is recorded in [ADR 0003](docs/adr/0003-keep-provider-transport-independent.md).

## What it does

On compaction, the extension:

1. Calls the model's normal Responses endpoint with:
   - the current explicit history;
   - a trailing `{ "type": "compaction_trigger" }`;
   - the current system prompt, optional custom compaction guidance, tools, reasoning configuration, compaction-safe text configuration, and allowlisted service tier.
2. Requires a completed response containing exactly one valid compaction item.
3. Stores a fixed `[Remote Responses compaction checkpoint]` marker in `CompactionEntry.summary`, retains recent user messages using Codex's current 64K approximate-token budget in `CompactionEntry.details.remoteCompaction`, and records the operation's usage in Pi's standard compaction usage field.
4. Reconstructs replacement history after resume, tree navigation, forks, and later compactions.
5. Replaces only the replay replacement span in later model-compatible `openai-responses` inputs, leaving current-turn and extension-added provider items in place.

The extension intentionally does not add `store`, `context_management`, or `previous_response_id` to ordinary requests. Those are separate persistence, automatic-context-management, and continuation concerns.

### Remote compaction request controls

On ordinary requests, the extension preserves Pi's effective provider parameters while patching only the replay replacement span and stale continuation fields. It locates the unique span containing the serialized checkpoint marker and Pi-retained pre-compaction entries, replaces that span with replacement history, and leaves earlier or later provider items unchanged. This preserves system/developer context, current turns, and additions from other payload hooks without duplicating retained user messages. If the replay replacement span is missing or ambiguous, native replay is not injected, the original provider input is preserved, and a warning is emitted.

The extension-owned remote compaction request instead uses an explicit allowlist: it carries a string `service_tier` only when the latest observed ordinary request for the same session and model key contained that value. Observed reasoning takes precedence over fallback inference; otherwise the selected model's thinking-level mapping is used. Compaction-safe text settings such as verbosity may be carried, while structured-output formats are excluded.

Arbitrary sampling parameters are not merged into remote compaction. Values for `temperature`, `top_p`, unknown provider fields, and protocol-owned fields are not copied. The extension constructs the compaction model, input, tools, trigger, streaming mode, `store: false`, and encrypted-reasoning inclusion itself. If no matching `service_tier` was observed, the field is omitted and the endpoint default applies.

Before sending, the extension estimates the complete remote-compaction request against the selected model's context window using Pi's coarse character-based accounting. Requests already within budget are left unchanged. For an oversized request, old function and tool outputs are reduced first; if more space is needed, the oldest remaining history is discarded as complete call/output pairs and a boundary text message may be retained with content from both its beginning and end around an explicit truncation marker.

### Current Responses conversion limits

Pi 0.84's public extension surface does not expose the ordinary Responses converter's grammar-tool input-property map or deferred-tool map at the compaction seam. The extension can therefore align deterministic assistant items and ordinary function calls, but it cannot safely reconstruct grammar-backed `custom_tool_call` / `custom_tool_call_output` items or synthesize deferred `tool_search_call` / `tool_search_output` items. At this seam, grammar-backed calls fall back to ordinary `function_call` / `function_call_output` items and deferred tool-search events are omitted; the extension does not import Pi internals to bridge this capability gap.

## Native replay semantics

The package maintains:

- **Replacement history** — retained user items plus the compaction item, for compatible future Responses requests.
- **Checkpoint marker** — a fixed two-line `CompactionEntry.summary` explaining that detailed context is retained in replacement history and requires a compatible model.

The marker is intentionally not a second model-generated summary. A successful logical compaction may retry the same remote request after a transient transport or stream failure, but it never starts a separate summary request. Switching to an incompatible model may therefore lose access to detailed pre-compaction context. Pi's local session JSONL remains authoritative for persisted replacement history.

## Install

Project-local, recommended:

```bash
pi install -l git:github.com/angribot/pi-openai-server-compaction
```

Global:

```bash
pi install git:github.com/angribot/pi-openai-server-compaction
```

One-shot:

```bash
git clone https://github.com/angribot/pi-openai-server-compaction.git
cd pi-openai-server-compaction && npm install
pi -e ./src/index.ts --model provider/model
```

## Requirements

- Node `>= 22`
- Pi with an `openai-responses` model
- Working authentication for the selected provider
- A Responses endpoint that accepts `compaction_trigger` and returns a `compaction` item

## Behavior

Remote compaction is always enabled for eligible models, and activation notifications are disabled. Pi itself decides when compaction occurs; this extension does not maintain a separate compaction threshold.

## Data handling

- Compaction requests send conversation context to the configured Responses endpoint.
- The remote compaction request uses `store: false`.
- Returned compaction items are stored as replacement history in Pi's local session JSONL.
- Persisted details are validated before reconstruction; legacy version 1 details remain readable, while new compactions write version 2.
- Ordinary requests are changed only when matching replacement history needs replay and the replay replacement span can be identified exactly; otherwise their provider input is preserved.
- Switching to an incompatible model does not replay replacement history and may expose only the checkpoint marker and post-compaction context.

## Testing

Offline core checks:

```bash
npm test
```

The smoke suite covers only project-owned requirements: provider-agnostic `openai-responses` gating, request-body construction and settings, compaction usage accounting, compaction-item validation, replacement-history reconstruction, narrow replay replacement span injection with transient provider additions, conservative replay failure, and the absence of provider registration.

Credentialed live regression:

```bash
npm run test:live
```

Override the model:

```bash
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=provider/model npm run test:live
```

The live harness covers same-process native replay, reduced-plaintext recovery, fork safety, resume/reload continuity, model switching away and back, and resume after a model-switch round trip. Release validation should additionally exercise repeated compaction, tree navigation, and a controlled final remote failure, confirming that no partial replacement history is persisted and no local fallback or aborted-turn retry occurs.

Cross-project transport matrices, machine-specific provider settings, and temporary live probes are intentionally not stored in this repository. Composition with a WebSocket extension is validated externally; any discovered defect is reduced to a regression at the owning project's interface.

## Benchmarks

The retained product-defaults benchmark exercised the extension's former 20K replay budget and found higher aggregate exact recall than Pi's default textual compactor, with higher output cost, a larger downstream context, and substantial allocation variability. It is retained as historical evidence after the extension's move to Codex's current 64K budget and does not establish better accuracy at an equal token budget.

See:

- `benchmarks/product-defaults/REPORT.md`
- `benchmarks/product-defaults/README.md`
- `benchmarks/native-vs-text/REPORT.md` for the superseded matched-cap interpretation

## Troubleshooting

1. Run Pi with `--no-extensions` to bypass all extensions.
2. Inspect session JSONL for `compaction.details.remoteCompaction`.
3. If the endpoint rejects remote compaction or transient retries are exhausted, the extension cancels compaction and does not invoke Pi's text compactor.

## Repository layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Pi hooks, replacement-history injection, lifecycle orchestration |
| `src/remote-compaction.ts` | Responses compaction v2 and replacement-history handling |
| `src/openai.ts` | `openai-responses` gating and payload helpers |
| `src/state.ts` | Ephemeral replacement-history and request-shape state |
| `tests/smoke.ts` | Offline core contract checks |
| `tests/live/openai-compaction-rpc-live.ts` | Credentialed Pi RPC regression |
| `CONTEXT.md` | Canonical domain language |
| `docs/adr/` | Durable architecture decisions |
| `CHANGELOG.md` | Release history and pending user-visible changes |

## License

MIT. See `LICENSE.md`.
