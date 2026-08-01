# pi-openai-server-compaction

A provider-agnostic Pi extension that adds Codex-style remote compaction to models using the plain `openai-responses` API.

On a Pi compaction event, the extension sends the conversation to the model's normal Responses endpoint over HTTP/SSE with a trailing `compaction_trigger`. It persists the returned opaque `compaction` item with a native replay checkpoint marker, then injects the reconstructed replacement history into later compatible requests. Those later ordinary requests remain transport-neutral.

> **Status:** experimental but live-tested. Install project-local first and keep rollback easy.

## Scope

Remote compaction is enabled by API type, not provider name:

| Model API | Remote compaction |
|---|---:|
| `openai-responses` | Yes |
| `openai-codex-responses` | No |
| `azure-openai-responses` | No |
| Other APIs | No |

Any provider can participate when its model uses `openai-responses` and its Responses endpoint supports the compaction protocol. The extension retries transient remote failures twice, then cancels compaction instead of falling back to Pi's text compactor. This preserves native replay semantics and prevents an opaque checkpoint from being irreversibly replaced by a summary that cannot read it.

## Independent transport composition

This extension does not register or override providers. For ordinary post-compaction turns, it only rewrites the final `openai-responses` payload in `before_provider_request`; Pi's selected provider transport then sends that payload.

The remote-compaction RPC itself currently calls the Responses endpoint directly over HTTP/SSE. Pi does not yet expose a provider-aware raw transport seam that preserves the opaque compaction event, so an independently configured WebSocket transport cannot transparently intercept that RPC without unsafe global patching or a private cross-extension protocol.

Current behavior is therefore:

1. remote-compaction RPC: HTTP/SSE;
2. later ordinary request: replacement history injected by this extension;
3. ordinary request transport: selected independently by the provider or a transport extension.

The missing raw transport seam and its constraints are tracked in [`TODO.md`](TODO.md).

## What it does

On compaction, the extension:

1. Calls the model's normal Responses endpoint with:
   - the current explicit history;
   - a trailing `{ "type": "compaction_trigger" }`;
   - the current system prompt, optional custom compaction guidance, tools, reasoning configuration, and text configuration.
2. Validates the returned opaque `compaction` item.
3. Stores a fixed `[Remote Responses compaction checkpoint]` marker in `CompactionEntry.summary` and retains recent user messages using Codex's current 64K approximate-token budget in `CompactionEntry.details.remoteCompaction`.
4. Reconstructs that history after resume, tree navigation, forks, and later compactions.
5. Replaces the `input` of later model-compatible `openai-responses` requests with the reconstructed history.

The extension intentionally does not add `store`, `context_management`, or `previous_response_id` to ordinary requests. Those are separate persistence, automatic-context-management, and continuation concerns.

## Native checkpoint semantics

The package maintains:

- **Native replay history** — retained user items plus the opaque compaction item, for compatible future Responses requests.
- **Checkpoint marker** — a fixed two-line `CompactionEntry.summary` explaining that detailed context is retained in the native artifact and requires a compatible Responses model.

The marker is intentionally not a second model-generated summary. A successful logical compaction may retry the same remote request after a transient transport or stream failure, but it never starts a separate summary request. Switching to an incompatible model may therefore lose access to detailed pre-compaction context. Pi's local session JSONL remains authoritative for the persisted artifact.

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

Remote compaction is always enabled for supported models, and activation notifications are disabled. Pi itself decides when compaction occurs; this extension does not maintain a separate compaction threshold.

## Data handling

- Compaction requests send conversation context to the configured Responses endpoint.
- The remote compaction request uses `store: false`.
- Returned opaque artifacts are stored in Pi's local session JSONL.
- Ordinary provider requests are not changed until a compatible remote artifact needs replay.
- Switching to an incompatible model does not replay the opaque artifact and may only expose the checkpoint marker and post-compaction context.

## Testing

Offline core checks:

```bash
npm test
```

The smoke suite covers only project-owned requirements: provider-agnostic `openai-responses` gating, request-body construction, artifact validation/reconstruction, payload history injection, and the absence of provider registration.

Credentialed live regression:

```bash
npm run test:live
```

Override the model:

```bash
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=provider/model npm run test:live
```

Cross-project transport matrices are intentionally not stored in this repository. Composition with a WebSocket extension is validated externally; any discovered defect is reduced to a regression at the owning project's interface.

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
| `src/index.ts` | Pi hooks, history injection, lifecycle orchestration |
| `src/remote-compaction.ts` | Responses compaction v2 and replacement-history handling |
| `src/openai.ts` | `openai-responses` gating and payload helpers |
| `src/state.ts` | Ephemeral reconstructed history and request-shape state |
| `tests/smoke.ts` | Offline core contract checks |
| `tests/live/openai-compaction-rpc-live.ts` | Credentialed Pi RPC regression |
| `ARCHITECTURE.md` | Control flow and module responsibilities |
| `TODO.md` | Known raw transport capability gap and acceptance criteria |

## License

MIT. See `LICENSE.md`.
