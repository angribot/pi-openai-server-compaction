# pi-openai-server-compaction

A Pi extension that lets a Responses endpoint compact older conversation context and reuse the result in later requests, instead of creating a text summary.

The endpoint returns an opaque compaction item. This extension saves it with your session and sends it back when you continue with a compatible model (**Native replay**).

> **Experimental.** Try a project-local installation and a new session first. Compacted context is not portable to every model.

## Quick start

You need Node **22 or newer**, Pi (**0.99.1** is the implementation and validation baseline), and working Pi-managed credentials for an eligible model. The endpoint must support the compaction protocol described below.

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

Eligibility requires a nonempty structured provider/API/model identity, an exact API type of `openai-responses` or `openai-codex-responses`, and a request model ID beginning with the case-sensitive literal prefix `gpt-`.

Both API types work with any configured provider, including custom Codex providers and relays. Provider identity, credentials, and routing remain unchanged. Newly released GPT IDs need no extension catalog update. Display names and endpoint hostnames do not affect eligibility.

Matching does not trim, lowercase, strip namespaces, or resolve aliases: `gpt-` passes, but `GPT-example`, `openai/gpt-example`, and `codex-auto-review` do not. Non-GPT catalog exceptions from earlier releases are no longer eligible. Ineligible models leave new compaction to Pi.

**Eligibility permits an attempt, not proven backend interoperability.**

The endpoint must accept **Remote compaction v2**: a request to `/responses` ending in a `compaction_trigger`, returning a compaction item that can be replayed later. This extension does **not** use `/responses/compact`. Ordinary Responses support alone is insufficient; capability is discovered when compaction is attempted.

## Before using it on an important session

### Switching models can break continuity

The saved compaction item is not a portable summary. Any eligible producer's item may be submitted to any eligible target, across model IDs, providers, and both supported API types, without comparing compatibility classes or requiring an exact Model key. See the [optimistic replay policy](docs/reference.md#native-replay).

This policy applies retrospectively to supported checkpoints and successful historical turns. A branch previously invalidated solely by differing classes can replay again. Historical `2911`, `3000`, other nonempty classes, and explicit null classes are readable metadata, not replay gates. New checkpoints write null classes.

Selecting an incompatible model produces a warning and leaves that model's ordinary request unchanged, **without access to detailed pre-checkpoint context**. Merely switching models does not invalidate the checkpoint, but a successful incompatible assistant turn does. After that, Native replay and further Remote compaction stop on that branch.

An eligible endpoint may reject another model, provider, account, or endpoint's opaque item, including old `2911` history. Ordinary provider errors surface without stripping the item and retrying.

### Failures do not produce a backup text summary

Transient compaction failures may retry, up to three attempts total. Unsupported operations, context overflow, and other terminal failures cancel compaction. The extension does not truncate context to make it fit. A model outside the GPT-prefix/API policy is not an eligible attempt, so Pi's normal summarization runs; that is not a fallback from a failed Remote compaction.

If a checkpoint is broken or cannot be safely replayed, the extension stops the ordinary request rather than silently sending incomplete context. It never generates a portable text fallback.

### Legacy checkpoints are not supported

Only `nativeReplayCheckpoint` records with format `native-replay-checkpoint/1` are supported. Records in that format without a host `systemMessage` snapshot remain readable for ordinary Native replay, but the extension cannot reconstruct their instructions, so it cancels a further Remote compaction before any attempt and asks for a new session. Legacy `remoteCompaction` records, including those written by v0.8.0 and earlier, have no migration path. Start a new session or return to a branch point before the old checkpoint.

### Active checkpoints pause prompt-cache warming

Pi 0.99.1 can refresh a prompt cache during long runs. A warming refresh re-runs the provider-request hook with its own abort controller, so the extension cannot rely on its fail-closed replay path to stop it. While the active branch's latest compaction is a Remote compaction checkpoint, the extension stops those refreshes before dispatch through Pi's `cache_warming_decision` hook, including broken, invalidated, incompatible, and legacy checkpoints. This keeps a protected refresh from bypassing fail-closed replay or disturbing the concurrent run.

When the branch has no such checkpoint, Pi's decision is left unchanged: ordinary prompt caching, warming, and unrelated branches keep working. The trade-off is that proactive prompt-cache refreshes stay paused while a Remote compaction checkpoint is the active branch's latest compaction. Pi may schedule another refresh, but the guard re-evaluates the branch and stops each protected refresh until the checkpoint is superseded. The hook stops a refresh before dispatch only; it does not cancel a refresh already in flight or provide general request-specific cancellation.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Endpoint rejects compaction | Confirm it supports the v2 trigger, not just Responses or `/responses/compact`. |
| Context overflow or retries exhausted | Compaction was cancelled; no text fallback was used. Start a new session if you cannot continue. |
| Replay reports broken state, missing/ambiguous input, or a compatibility turn that cannot be proven | Start a new session or return to a complete branch point before the affected checkpoint. Do not continue with incomplete context. |
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

`npm test` covers the extension loader, the cache-warming guard through Pi's real warmer decision/dispatch path, and the transport/projection contracts, but not credentialed end-to-end compaction or replay continuity. Offline lifecycle and real-provider/mock-fetch tests cover optimistic eligibility, continuity, and custom Codex routing; they do not prove live backend interoperability or comprehensively exercise retry orchestration. See [testing coverage](docs/reference.md#testing) and the [test ownership rule](docs/reference.md#test-ownership).

- [Technical reference](docs/reference.md): protocol, checkpoint format, replay, retries, transport limitations, and repository layout.
- [Domain glossary](GLOSSARY.md) and [architecture decisions](docs/adr/).
- [Changelog](CHANGELOG.md).

Other extensions' request mutations are outside the supported contract; see the [transport and projection limitations](docs/reference.md#transport-boundary-and-limitations) before composing extensions.

## License

[MIT](LICENSE).
