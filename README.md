# pi-openai-server-compaction

A Pi extension that lets a Responses endpoint compact older conversation context and reuse the result in later requests, instead of creating a text summary.

The endpoint returns an opaque compaction item. This extension saves it with your session and sends it back when you continue with a compatible model (**Native replay**).

> **Experimental.** Try a project-local installation and a new session first. Compacted context is not portable to every model.

## Quick start

You need Node **22 or newer**, Pi (**0.85.1** is the implementation baseline), and working Pi-managed credentials for an eligible model. The endpoint must support the compaction protocol described below.

Install in your project:

```bash
pi install -l git:github.com/angribot/pi-openai-server-compaction
```

Then start Pi, select your model, and use Pi's normal compaction flow. There is no extension-specific command or provider to configure: the extension hooks into Pi's compaction lifecycle.

- On an eligible model, it asks the endpoint to compact the conversation.
- On success, Pi saves a checkpoint; later compatible requests use the saved compaction item automatically, including after reloading the session.
- On an ineligible model, it leaves Pi's compaction flow alone.
- If an eligible attempt fails, it cancels compaction rather than falling back to a text summary.

For a global installation, omit `-l`.

## Which models can use it?

Eligibility is based on Pi's configured API type, not the model name or endpoint hostname:

| Model configuration | Can attempt Remote compaction? |
| --- | --- |
| Any provider using `openai-responses` | Yes, including custom providers and relays |
| Pi's built-in `openai-codex` provider using `openai-codex-responses` | Yes |
| Other configurations | No |

API type strings are exact and case-sensitive. **Eligibility is not a guarantee of endpoint support.**

The endpoint must accept **Remote compaction v2**: a request to `/responses` ending in a `compaction_trigger`, returning a compaction item that can be replayed later. This extension does **not** use `/responses/compact`. Ordinary Responses support alone is insufficient; capability is discovered when compaction is attempted.

## Before using it on an important session

### Switching models can break continuity

The saved compaction item is not a portable summary. A model can reuse it when its known compatibility class matches the checkpoint's class. If either class is unknown, the provider, API type, and model ID must match exactly. See the [compatibility rules and model catalog](docs/reference.md#native-replay).

Selecting an incompatible model produces a warning and leaves that model's ordinary request unchanged, **without access to detailed pre-checkpoint context**. Merely switching models does not invalidate the checkpoint, but a successful incompatible assistant turn does. After that, Native replay and further Remote compaction stop on that branch.

Even matching compatibility classes do not guarantee that a different endpoint will accept the item.

### Failures do not produce a backup text summary

Transient compaction failures may retry, up to three attempts total. Unsupported operations, context overflow, and other terminal failures cancel compaction. The extension does not truncate context to make it fit.

If a checkpoint is broken or cannot be safely replayed, the extension stops the ordinary request rather than silently sending incomplete context. It never generates a portable text fallback.

### Old checkpoints are not supported

Only `nativeReplayCheckpoint` records with format `native-replay-checkpoint/1` are supported. Legacy `remoteCompaction` records, including those written by v0.8.0 and earlier, have no migration path. Start a new session or return to a branch point before the old checkpoint.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Endpoint rejects compaction | Confirm it supports the v2 trigger, not just Responses or `/responses/compact`. |
| Context overflow or retries exhausted | Compaction was cancelled; no text fallback was used. Start a new session if you cannot continue. |
| Replay reports broken state, missing/ambiguous input, or invalid compatibility evidence | Start a new session or return to a complete branch point before the affected checkpoint. Do not continue with incomplete context. |
| A different endpoint rejects a supposedly compatible item | Treat that route as unavailable for this session; the extension will not strip the item and retry. |

To inspect a failing session, check the active branch's latest compaction entry in the session JSONL, especially `summary` and `details.nativeReplayCheckpoint`.

`pi --no-extensions` bypasses all extensions for recovery, but does **not** turn a saved compaction item into readable conversation history.

## Development and technical details

Try a local checkout:

```bash
git clone https://github.com/angribot/pi-openai-server-compaction.git
cd pi-openai-server-compaction
npm install
pi -e ./index.ts --model provider/model
```

Run type checking and offline tests (no credentials or network needed):

```bash
npm test
```

The [live test](docs/reference.md#testing) requires credentials, a cataloged eligible model, a capable endpoint, and paid API calls. It is not part of `npm test`.

- [Technical reference](docs/reference.md): protocol, checkpoint format, replay, retries, transport limitations, and repository layout.
- [Domain glossary](CONTEXT.md) and [architecture decisions](docs/adr/).
- [Changelog](CHANGELOG.md).

Other extensions' request mutations are outside the supported contract; see the [transport and projection limitations](docs/reference.md#transport-boundary-and-limitations) before composing extensions.

## License

[MIT](LICENSE).
