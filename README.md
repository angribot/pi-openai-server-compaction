# pi-openai-server-compaction

A Pi extension that lets a Responses endpoint compact older conversation context and reuse the result in later requests, instead of creating a text summary.

The endpoint returns an opaque compaction item. This extension saves it with bounded recent user history and sends that replacement history back when you continue with a compatible model (**Native replay**).

> **Experimental.** Try a project-local installation and a new session first. Compacted context is not portable to every model.

## Quick start

You need Node **22 or newer**, Pi (**1.4.0** is the implementation and validation baseline), and working Pi-managed credentials for an eligible model. The endpoint must support Remote compaction v2, not just ordinary Responses.

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

Use a request model ID beginning with literal lowercase `gpt-` on `openai-responses` or `openai-codex-responses`. Configured providers, including custom Codex providers and relays, retain their Pi-managed credentials and routing. No extension model catalog is required.

For exact provider `openai` with OAuth, Remote compaction defers to Pi's ordinary compaction; Native replay remains available. See [eligibility and authentication](docs/reference.md#eligibility-and-authentication) for exact matching and credential precedence.

**Eligibility permits an attempt, not proven backend interoperability.** The endpoint must accept the v2 trigger on `/responses` and replay the returned item. This extension does not use `/responses/compact`.

## Before using it on an important session

### Switching models can break continuity

The saved compaction item is not a portable summary. Any eligible producer's item may be submitted to any eligible target, across model IDs, providers, and both supported API types, without comparing compatibility classes or requiring an exact Model key. See the [optimistic replay policy](docs/reference.md#native-replay).

Selecting an incompatible model produces a warning and leaves that model's ordinary request unchanged, **without access to detailed pre-checkpoint context**. Merely switching models does not invalidate the checkpoint, but a successful incompatible assistant turn does. After that, Native replay and further Remote compaction stop on that branch.

An eligible endpoint may reject another model, provider, account, or endpoint's opaque item. Ordinary provider errors surface without stripping the item and retrying.

### Recent user wording remains explicit

Successful compaction retains recent original user messages and supported images beside the opaque item, using a fixed 64K approximate-token budget independent of Pi's `keepRecentTokens`. Newer messages take priority; an oversized boundary may be truncated. The full supported compactable context still reaches the compaction endpoint first. This budget does not guarantee fit on small-window targets; see [retention details](docs/reference.md#bounded-explicit-user-history).

### Tool declarations follow Pi

Compaction includes the tools Pi projects for the selected model, including supported grammar tools, and follows Pi's capability-dependent placement: current top-level declarations, in-place tool-search additions, or fully in-place `additional_tools` batches with Pi's incremental and removal notices. It never executes returned tool calls. Endpoint schema rejection remains visible and cancels compaction rather than retrying without tools. This does not guarantee every tool schema works on every backend; see the [tool declaration contract](docs/reference.md#remote-compaction-contract).

### Failures do not produce a backup text summary

A failed Remote compaction is cancelled after bounded retries or a terminal error, including context overflow. The extension does not truncate its input to make it fit; see [retry and failure behavior](docs/reference.md#retry-and-failure-behavior).

If a checkpoint is broken or cannot be safely replayed, the extension stops the ordinary request rather than silently sending incomplete context. It never generates a portable text fallback.

### Check compatibility before downgrading

New `/2` checkpoints retain explicit user history; supported `/1` checkpoints remain readable. Older `/1`-only extension releases cannot replay `/2`: start a new session or return to a branch point before the new checkpoint before downgrading.

Legacy `remoteCompaction` checkpoints remain unsupported. See [persistence and snapshot compatibility](docs/reference.md#persistence) for format and repeated-compaction limits.

### Active checkpoints pause prompt-cache warming

Proactive prompt-cache refreshes pause while a Remote compaction checkpoint is the active branch's latest compaction. Ordinary prompt caching remains available; warming resumes under Pi's policy on branches without that checkpoint or after ordinary compaction supersedes it. See the [warming guard](docs/reference.md#prompt-cache-warming-guard) for the safety boundary.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Endpoint rejects compaction | Confirm it supports the v2 trigger, not just Responses or `/responses/compact`. |
| Context overflow or retries exhausted | Compaction was cancelled; no text fallback was used. Start a new session if you cannot continue. |
| Checkpoint has no system-message snapshot | Ordinary replay still works, but start a new session to compact again. |
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

See [testing coverage](docs/reference.md#testing) for offline acceptance and its limits. These tests do not prove live backend interoperability.

- [Technical reference](docs/reference.md): protocol, checkpoint format, replay, retries, transport limitations, and repository layout.
- [Domain glossary](GLOSSARY.md) and [architecture decisions](docs/adr/).
- [Changelog](CHANGELOG.md).

Other extensions' request mutations are outside the supported contract; see the [transport and projection limitations](docs/reference.md#transport-boundary-and-limitations) before composing extensions.

## License

[MIT](LICENSE).
