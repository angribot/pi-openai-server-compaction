# Pi 0.84.2 public compaction and Responses seams

Research for [issue #37](https://github.com/angribot/pi-openai-server-compaction/issues/37), under [map #35](https://github.com/angribot/pi-openai-server-compaction/issues/35).

## Scope and baseline

This asset answers which Pi APIs are both public and usable by an extension loaded through Pi's production loader. It does not propose or implement the later refactor.

The inspected installation is exactly Pi **0.84.2**:

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json` declares `"version": "0.84.2"`.
- Its installed `@earendil-works/pi-ai` dependency also declares `"version": "0.84.2"`.
- The coding-agent package exports only `.`, `./rpc-entry`, and `./client` as Node package entry points.
- The pi-ai package exports `.`, `./compat`, `./providers/*`, `./api/*`, `./oauth`, `./bedrock-provider`, and `./bun-oauth`; production-extension-loader restrictions narrow that package-level surface further.

The map's standing constraints are applied here: no 0.84.0 compatibility analysis, no private runtime subpaths, no claim that Codex/Pi field parity is itself a capability requirement, and only linear continuation, reload/resume, and repeated compaction are core lifecycle requirements.

## Executive summary

1. **Pi exposes enough public, loader-usable lifecycle and storage seams for atomic custom compaction.** `session_before_compact` supplies the prepared cut data, the complete active branch, trigger reason, retry intent, custom instructions, and abort signal. Returning `compaction: { summary, firstKeptEntryId, tokensBefore, usage, details }` causes Pi to append one `CompactionEntry`; returning `{ cancel: true }` appends none.

2. **Compaction details and usage are first-class generic extension seams.** `details` is persisted in the compaction entry and is readable through the read-only `SessionManager`; top-level `usage` is included in Pi's footer, `/session`, RPC statistics, and aggregate cost/token accounting. A copy of usage stored only inside `details` is not counted.

3. **Pi exposes public, loader-usable session reconstruction and lifecycle seams.** `buildContextEntries`, `buildSessionContext`, `convertToLlm`, `ctx.sessionManager.getBranch()`, `session_start`, `session_compact`, and `session_shutdown` are sufficient to reconstruct project-owned replay state on startup, reload/resume, and repeated compaction. The runtime uses `firstKeptEntryId`; the bundled `session-format.md` claim about newer `retainedTail` compactions does not match the installed 0.84.2 declarations or implementation.

4. **Pi exposes resolved request authentication and routing, but not a single “final headers” snapshot.** `ctx.modelRegistry.getApiKeyAndHeaders(model)` returns resolved API key, auth/configured headers, credential-resolved `baseUrl`, and provider-scoped environment when available. The selected `model.baseUrl` remains the fallback endpoint. A Pi-owned provider call may additionally apply `model.headers`, API-specific dynamic headers, session-affinity/attribution headers, and `before_provider_headers`; a project-owned direct `fetch` must account for the parts its core contract needs.

5. **Pi exposes final ordinary-request mutation.** `before_provider_request` receives the provider-specific payload after Pi has serialized it; handlers chain in extension load order, and a non-`undefined` return replaces the payload for later handlers and the actual request. It is sufficient for native-replay input replacement. It is not a final-after-all-handlers observation point: later extensions may still replace or mutate the returned payload.

6. **The Responses converter has two different availability answers.** `convertResponsesMessages`, `convertResponsesTools`, and `createGrammarToolInputProperties` are public pi-ai `./api/*` exports and load in ordinary Node package resolution. They are **not usable through Pi 0.84.2's production extension loader**: the loader aliases the pi-ai package root to `compat.js`, causing `@earendil-works/pi-ai/api/...` to resolve as a nonexistent path below that file. Pi's root/compat entry point does not re-export those converter helpers.

7. **A public indirect conversion seam does exist.** `ctx.modelRegistry.complete(model, context, options)` is loader-usable and delegates to the effective provider, so Pi itself performs its normal Responses conversion. Its public options include `onPayload`, `fetch`, headers, reasoning, service tier, sampling parameters, transport preference, and response metadata callbacks. A project adapter can use `onPayload` to append `compaction_trigger` and, for fetch-based HTTP providers, a per-call `fetch` wrapper to clone/capture the raw SSE response.

8. **The high-level provider result does not expose a compaction item.** Pi's Responses parser ignores a `compaction` output item when constructing `AssistantMessage`; a probe returned an empty successful assistant message while the cloned raw SSE contained the opaque compaction item. There is no extension event or provider API returning the unconsumed raw Responses event stream. Therefore remote compaction still needs a project-owned raw-event extraction/parser adapter. Per-call `fetch` interception is HTTP-only and is not the provider-aware raw transport seam needed for independently selected WebSocket or custom transports.

9. **Tools and provider request controls are only partly available at the compaction seam.** Active tool names and basic tool metadata are public, but `pi.getAllTools()` intentionally omits `constrainedSampling`; there is no public getter for the exact effective Responses `text` or `service_tier`. The exact serialized ordinary payload exposes tools, reasoning, text, and service tier through `before_provider_request`, but only for requests that have actually been built and only at that handler's load-order position.

10. **No core lifecycle, persistence, request-injection, or usage-accounting blocker was found.** The core project-owned adapters are Responses item/request construction or high-level request interception, opaque compaction SSE extraction/validation, persisted replacement-history validation/reconstruction, and replay-span replacement. Grammar custom tools, deferred tool-search parity, provider-aware raw transport, exact private pricing helper reuse, forks/trees/model-switch matrices, and Codex field parity are not established core gaps under map #35.

## Classification vocabulary

| Classification | Meaning in this asset |
|---|---|
| Public usable seam | Exported/documented API that loads and runs through Pi's production extension loader. |
| Public but loader-unusable | Public at the package export level, but the production extension loader cannot resolve it. |
| Private/internal implementation | Installed source used as evidence about behavior, but not an allowed project dependency. |
| Core adapter requirement | Core behavior can be implemented, but Pi does not provide it as a direct extension abstraction; project-owned code must bridge it. |
| True core capability gap | The core contract would require behavior that cannot be expressed from the allowed public seams. Conditional gaps are listed separately when they depend on an unresolved product definition. |
| Non-core parity gap | Difference from Pi internals or Codex fields that is outside the minimum core contract. |

## API and seam matrix

| Area | API or behavior | Classification | What is actually available | Evidence |
|---|---|---|---|---|
| Version | Installed Pi baseline | Public fact | Exact installed coding-agent and pi-ai versions are 0.84.2. | `@earendil-works/pi-coding-agent/package.json`; nested `@earendil-works/pi-ai/package.json` |
| Compaction event | `session_before_compact` data | Public usable seam | `preparation`, full active `branchEntries`, `customInstructions`, `reason`, `willRetry`, and `signal`. Preparation includes `messagesToSummarize`, `turnPrefixMessages`, `previousSummary`, `fileOps`, `settings`, `tokensBefore`, and `firstKeptEntryId`. | `docs/extensions.md`; `docs/compaction.md`; `dist/core/extensions/types.d.ts`; `dist/core/compaction/compaction.d.ts` |
| Compaction result | Cancel or custom compaction | Public usable seam | Return `{ cancel: true }`, or `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage?, details? } }`. Pi appends the entry after the hook returns and after abort checks. | `dist/core/extensions/types.d.ts`; `dist/core/agent-session.js` |
| Atomicity | No partial compaction entry on failure | Public usable seam | Cancellation or thrown/aborted hook work does not cause Pi to append a `CompactionEntry`. Project-owned side effects outside this return contract are not automatically rolled back. | `dist/core/agent-session.js` manual and auto compaction paths |
| Effective persisted context | `buildContextEntries`, `buildSessionContext`, read-only SessionManager equivalents | Public usable seam | Builds the active branch with the latest compaction summary plus entries from `firstKeptEntryId` and entries after the compaction. | Main package `dist/index.d.ts`; `dist/core/session-manager.d.ts`; `dist/core/session-manager.js` |
| Message conversion | `convertToLlm` | Public usable seam | Converts coding-agent-only messages (`bashExecution`, custom, branch summary, compaction summary) to pi-ai `Message` values. It does not apply the AgentSession `blockImages` wrapper or other extensions' `context` transforms. | Main package `dist/index.d.ts`; `dist/core/messages.js`; `dist/core/sdk.js` |
| Per-request context mutation | `context` event | Public usable seam, but not replayable at compaction time | Ordinary model calls get a deep-copy message middleware chain. `session_before_compact` receives persisted branch/preparation data, not the final result of that chain, and no public method invokes the chain on demand. | `docs/extensions.md`; `dist/core/extensions/runner.js`; `dist/core/sdk.js` |
| System prompt | `ctx.getSystemPrompt()` | Public usable seam with scope limits | Returns Pi's current system prompt. It includes the current/last per-turn `before_agent_start` override, but not later `context` message transforms or `before_provider_request` payload rewrites; later-loaded handlers can still change future requests. | `docs/extensions.md`; `dist/core/agent-session.js`; `dist/core/extensions/runner.js` |
| Responses conversion | `@earendil-works/pi-ai/api/openai-responses-shared` | Public but loader-unusable | Package exports expose `convertResponsesMessages`, `convertResponsesTools`, and `processResponsesStream`, but production loader aliasing breaks the runtime import. | pi-ai `package.json`; `dist/api/openai-responses-shared.d.ts`; coding-agent `dist/core/extensions/loader.js`; loader probe below |
| Grammar helper | `@earendil-works/pi-ai/api/constrained-sampling` | Public but loader-unusable | Package export exposes `createGrammarToolInputProperties` and constrained-sampling helpers, but the same loader aliasing breaks the import. | pi-ai `package.json`; `dist/api/constrained-sampling.d.ts`; loader probe |
| Indirect Responses conversion | `ctx.modelRegistry.complete()` | Public usable seam | Delegates through the effective provider and normal Pi converter. Public request options can inspect/replace payload and inject a per-call fetch implementation. | `docs/extensions.md`; `docs/sdk.md`; `dist/core/model-registry.d.ts`; `dist/core/model-runtime.js`; pi-ai `dist/models.d.ts`, `dist/types.d.ts` |
| Opaque compaction output | High-level `AssistantMessage` result | Core adapter requirement | The Responses stream parser does not project a `compaction` item into `AssistantMessage`; raw SSE must be captured and parsed by project code. | pi-ai `dist/api/openai-responses-shared.js`; HTTP probe below |
| Authentication | `ctx.modelRegistry.getApiKeyAndHeaders(model)` | Public usable seam | Resolves API key, auth/provider/configured model headers, credential-resolved base URL, and provider environment; returns structured failure for common auth failures. It is not the complete header set a provider adapter will eventually send. | `docs/extensions.md`; `dist/core/model-registry.d.ts`; `dist/core/model-registry.js`; `dist/core/model-runtime.js`; `dist/core/provider-composer.js` |
| Provider/model metadata | `ctx.model`, `getProvider`, `getProviderAuth` | Public usable seam | Model identity, API, model base URL, reasoning capabilities, input support, context window, costs, sampling parameters, and compatibility metadata are readable. Provider auth can also be resolved provider-wide, but the model-specific helper is the correct seam when model headers matter. | `docs/extensions.md`; `dist/core/extensions/types.d.ts`; `dist/core/model-registry.d.ts`; pi-ai `dist/types.d.ts` |
| Request headers | `before_provider_headers` | Public usable seam for Pi-owned provider calls | Mutates fully assembled headers once per provider request; null deletes a header. Pi's adapter may also add `model.headers`, API-specific dynamic headers, session-affinity, and attribution before this point. A separate direct `fetch` does not enter this hook chain. | `docs/extensions.md`; `dist/core/extensions/types.d.ts`; `dist/core/extensions/runner.js`; `dist/core/sdk.js`; pi-ai Responses adapter |
| Request payload | `before_provider_request` | Public usable seam | Receives the provider-specific payload after serialization. Return replacement values chain by extension load order. Sufficient for replay replacement on ordinary requests. | `docs/extensions.md`; `examples/extensions/provider-payload.ts`; `dist/core/extensions/runner.js`; `dist/core/sdk.js` |
| Response metadata | `after_provider_response` | Public usable seam, metadata only | Exposes status and normalized headers before body consumption. It does not expose or tee the response body. | `docs/extensions.md`; `dist/core/extensions/types.d.ts`; `examples/extensions/provider-payload.ts` |
| Raw transport | Provider `stream`/`complete`, `fetch` request option | Public usable primitives, no direct raw-result seam | Public model calls can choose a per-call fetch and payload callback. No public extension API returns the unconsumed event stream or guarantees custom fetch support across providers/transports; custom fetch explicitly does not affect WebSockets. | pi-ai `dist/types.d.ts`; `dist/models.d.ts`; `dist/core/model-runtime.js` |
| Provider-aware raw transport | Independent transport composition | Out-of-scope capability gap | No public API submits an opaque provider operation through whichever independent transport extension owns the provider and returns the raw Responses stream. | Issue #8; ADR 0003; coding-agent/pi-ai provider interfaces |
| Compaction persistence | `CompactionResult.details` -> `CompactionEntry.details` | Public usable seam | Arbitrary JSON-serializable project data can be stored atomically on the compaction entry and reconstructed from `getBranch()`/`getEntries()`. | `docs/compaction.md`; `docs/session-format.md`; `dist/core/session-manager.d.ts`; `dist/core/agent-session.js` |
| Separate extension persistence | `pi.appendEntry()` | Public usable seam, not needed for atomic compaction details | Persists custom entries outside model context. Useful for generic state, but compaction-owned replacement history belongs in returned compaction `details` to preserve atomicity. | `docs/extensions.md`; `docs/session-format.md` |
| Reload/resume | `session_shutdown`, `session_start` reasons | Public usable seam | Reload/session replacement tears down the old extension runtime and starts a new one. Reconstruct state in `session_start` from persisted entries. Reasons include `startup`, `reload`, `new`, `resume`, and `fork`. | `docs/extensions.md`; `examples/extensions/reload-runtime.ts`; `dist/core/extensions/types.d.ts` |
| Repeated compaction | Full branch plus `session_compact` | Public usable seam | A later hook can find previous project details in `branchEntries`; after success, `session_compact` supplies the saved entry. | `docs/extensions.md`; `docs/compaction.md`; `dist/core/agent-session.js` |
| Usage persistence | `CompactionResult.usage` | Public usable seam | Pi writes usage on the compaction entry and aggregates it with assistant/tool/summary usage. | `docs/compaction.md`; `dist/core/session-manager.d.ts`; `dist/core/usage-totals.js`; `dist/core/agent-session.js`; footer implementation |
| Cost calculation | `calculateCost(model, usage)` | Public usable seam | Available from the loader-supported pi-ai root. It computes catalog base pricing. | pi-ai root exports; production-loader probe |
| Responses service-tier pricing | Internal multiplier in Responses adapter | Private/internal; non-core parity | No public helper exposes Pi's `flex`/`priority` multiplier. A project can apply its own policy or record zero/base cost; inability to call the private helper is not itself a core gap. | pi-ai `dist/api/openai-responses.js`; current `src/remote-compaction.ts` |
| Tool names and schemas | `pi.getActiveTools()`, `pi.getAllTools()` | Public usable seam | Active names plus all tools' name, description, parameters, prompt guidelines, and source metadata. | `docs/extensions.md`; `dist/core/extensions/types.d.ts`; `dist/core/agent-session.js` |
| Full tool semantics | `constrainedSampling` and complete `Tool` | Not exposed by ExtensionAPI | Internal registry has it, but `ToolInfo` deliberately omits it. Exact grammar-tool conversion cannot be reconstructed solely from `getAllTools()`. | pi-ai `dist/types.d.ts`; coding-agent `dist/core/extensions/types.d.ts`; `dist/core/agent-session.js` |
| Deferred tools | `ToolResultMessage.addedToolNames` | Public message data; incomplete compaction helper state | Load points persist in messages, but the converter also needs a deferred tool map with full tool definitions. Exact `tool_search_call`/`tool_search_output` synthesis is therefore not directly available from the compaction APIs. | pi-ai `dist/types.d.ts`; `dist/api/openai-responses-shared.d.ts` and `.js` |
| Reasoning | model metadata, `ctx.thinkingLevel`, `pi.getThinkingLevel()` | Public usable seam | Supports fallback inference using `model.reasoning` and `thinkingLevelMap`. Exact final ordinary Responses reasoning is visible in `before_provider_request`. | `docs/extensions.md`; `docs/models.md`; pi-ai `dist/types.d.ts`; current `src/index.ts` |
| Responses text config | Final ordinary payload | Public observable seam only | No dedicated extension getter. `before_provider_request` exposes final serialized `text`; a project may observe and allowlist fields such as verbosity. | `docs/extensions.md`; pi-ai Responses adapter; current `src/openai.ts` |
| Service tier | Final ordinary payload and model-call option | Public usable/observable seam | `before_provider_request` exposes final `service_tier`; `ModelRegistry.complete` accepts the API-specific option. There is no session-level getter for the last effective value. | pi-ai `dist/api/openai-responses.d.ts`; `dist/types.d.ts`; current `src/openai.ts` |

## Production loader verification

### Loader implementation

`dist/core/extensions/loader.js` is the installed production implementation. In Node mode it configures jiti aliases; in the compiled Bun binary it configures an equivalent exact `virtualModules` table.

Explicitly available module identities include:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai` (mapped to `pi-ai/dist/compat.js`, not the normal root entry)
- `@earendil-works/pi-ai/compat`
- `@earendil-works/pi-ai/oauth`
- `@earendil-works/pi-ai/providers/all`
- `typebox`, `typebox/compile`, and `typebox/value`

The root pi-ai mapping is documented in the loader as a temporary compatibility superset. The aliases are path-prefix-sensitive in practice. An import of `@earendil-works/pi-ai/api/openai-responses-shared` is rewritten beneath `.../dist/compat.js/api/openai-responses-shared`, which does not exist.

### Probe results

The probes loaded temporary TypeScript extensions through the installed `loadExtensions()` production loader rather than importing the extension modules directly.

| Temporary extension import | Result |
|---|---|
| `@earendil-works/pi-coding-agent` root (`convertToLlm`) | Loaded |
| `@earendil-works/pi-ai` root (`calculateCost`, `clampThinkingLevel`) | Loaded |
| `@earendil-works/pi-ai/providers/all` | Loaded |
| `@earendil-works/pi-ai/oauth` | Loaded |
| `@earendil-works/pi-agent-core` | Loaded |
| `@earendil-works/pi-tui` | Loaded |
| `@earendil-works/pi-ai/api/openai-responses-shared` | Failed: resolved below `dist/compat.js/api/...` |
| `@earendil-works/pi-ai/api/constrained-sampling` | Failed: resolved below `dist/compat.js/api/...` |
| `@earendil-works/pi-ai/api/openai-responses` | Failed: resolved below `dist/compat.js/api/...` |
| `@earendil-works/pi-ai/dist/api/openai-responses-shared.js` | Failed and is not an allowed public import anyway |

For comparison, from the installed coding-agent package directory, ordinary Node package resolution successfully imported all three public `@earendil-works/pi-ai/api/*` modules. This confirms the classification is **public package export, production-loader unusable**, not private implementation.

The current repository imports runtime values only from loader-supported roots. Its smoke test also loads `index.ts` through `discoverAndLoadExtensions`; that current import shape is valid on the inspected installation.

## Compaction context: what is and is not “effective”

Pi exposes three distinct layers that should not be conflated.

### 1. Persisted, compaction-aware session context

Available directly:

```text
branch entries
  -> buildContextEntries/buildSessionContext
  -> coding-agent AgentMessage[]
  -> convertToLlm
  -> pi-ai Message[]
```

This layer includes compaction summaries, kept entries, custom messages, branch summaries, and shell executions according to Pi's session rules. It is reconstructable after resume/reload and is the strongest stable seam at `session_before_compact`.

### 2. Per-call message context after extension middleware

The ordinary `context` event runs immediately before each model call and chains message replacements across extensions. Pi passes a deep copy. This result is ephemeral and is neither persisted nor supplied to `session_before_compact`. There is no public API for one extension to invoke the complete context-handler chain on demand.

### 3. Final provider payload

`before_provider_request` sees provider-specific serialization after normal conversion and request construction. It includes provider roles/items, exact serialized tools, reasoning, text, service tier, sampling overrides, and any modifications made by earlier payload handlers. It is request-specific, load-order-relative, and available only when a provider request is actually being made.

Therefore, the current repository's phrase “Pi's effective context” is accurate only if “effective” means the persisted compaction-aware session context plus `convertToLlm`. It is too broad if it means the exact context after all `context` handlers, image-blocking settings, provider conversion, and payload handlers.

## Responses conversion and raw-result findings

### Direct converter exposure

The ordinary Responses adapter uses:

- `createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools)`;
- `convertResponsesMessages(model, context, allowedToolCallProviders, { grammarToolInputProperties, deferredTools, deferredToolsMode, toolOptions })`;
- `convertResponsesTools(...)`.

Those functions are public pi-ai `./api/*` exports but unusable through the production loader. The coding-agent root does not re-export them.

Even if the loader exposed them, the extension's `pi.getAllTools()` result is not a complete pi-ai `Tool[]`: it omits `constrainedSampling`. Exact grammar and deferred conversion would still need more tool-state exposure or project inference.

### Indirect converter exposure through `ModelRegistry.complete`

`ctx.modelRegistry.complete()` uses `ModelRuntime.complete()`, which resolves the effective provider and authentication, applies any credential-resolved base URL, then calls the provider's normal stream implementation. For an `openai-responses` model this invokes Pi's ordinary Responses converter.

The request option types publicly expose:

- `onPayload` to inspect or replace the built request;
- `fetch` to inject a per-call HTTP fetch implementation;
- `headers`, including null deletion semantics;
- `reasoning`, API-specific `serviceTier`, and generic `samplingParams`;
- `transport`, `sessionId`, abort signal, timeouts, retries, and `onResponse` metadata.

This means the normal converter is usable as part of a real provider call even though it is not importable as a standalone function.

### Raw compaction probe

An isolated probe called the public pi-ai compat `complete()` for a fake `openai-responses` model with:

- `onPayload` appending `{ "type": "compaction_trigger" }`;
- a per-call fake `fetch` returning SSE containing one `compaction` item and `response.completed`;
- a cloned response body retained by the fake fetch.

Observed facts:

- the sent request ended in `compaction_trigger`;
- the cloned raw SSE contained the opaque `compaction` item;
- Pi returned a successful `AssistantMessage` with `content: []` and `stopReason: "stop"`;
- the returned `AssistantMessage` did not contain the compaction item.

Thus a project-owned HTTP adapter can combine Pi's converter with raw-response capture, but Pi's high-level result cannot replace project-owned compaction-event parsing and validation.

This is not a provider-aware raw transport solution:

- `fetch` does not affect WebSocket transports by public contract;
- a custom/native provider may reject or ignore custom fetch injection;
- direct `ModelRegistry.complete()` calls do not automatically enter AgentSession's extension `before_provider_headers`, `before_provider_request`, or `after_provider_response` chains;
- no public API returns an unconsumed provider event stream to compose independently with another transport extension.

## Persistence and lifecycle findings

### Compaction details

The intended atomic persistence seam is the `details` member returned from `session_before_compact`. Pi stores it directly on the saved `CompactionEntry`. The extension can validate and reconstruct it by scanning `ctx.sessionManager.getBranch()` in `session_start` and after `session_compact`.

Pi treats details as opaque. Pi does not validate project versions, model keys, replacement history, or compaction item shape. Those are necessarily project-owned adapter responsibilities.

### Runtime reconstruction

For core lifecycle:

- startup or opening a session: `session_start { reason: "startup" }`;
- `/resume`: old runtime receives `session_shutdown { reason: "resume" }`; new runtime receives `session_start { reason: "resume" }`;
- `/reload`: old runtime receives `session_shutdown { reason: "reload" }`; new runtime receives `session_start { reason: "reload" }`;
- successful compaction: `session_compact` contains the saved entry;
- repeated compaction: the next `session_before_compact.branchEntries` contains prior compaction entries and their details.

These events and branch reads are sufficient for linear continuation, resume/reload, and repeated compaction.

### Session-format documentation mismatch

The bundled `docs/session-format.md` says newer harness-generated compactions use a `retainedTail` field. The installed 0.84.2 `CompactionEntry`, `SessionManager.appendCompaction()`, and `buildContextEntries()` contain no `retainedTail` support; they use `firstKeptEntryId` exclusively.

For the exact 0.84.2 baseline, runtime declarations and implementation are the relevant facts. The current repository's use of `firstKeptEntryId` matches the installed runtime. The upstream Markdown claim should not be used to design the later contract unless the baseline changes.

## Usage accounting findings

Pi's `Usage` has input, output, cache-read, cache-write, optional reasoning breakdown, total tokens, and cost components.

When an extension returns `compaction.usage`:

1. AgentSession passes it to `SessionManager.appendCompaction()`.
2. It is persisted at `CompactionEntry.usage`.
3. Footer aggregation, `AgentSession.getSessionStats()`, RPC session statistics, and usage/cost breakdowns add it to tool/summary totals.

Pi does not read usage from project `details`; current code correctly returns the remote usage both as the top-level compaction `usage` and, redundantly for project detail history, inside `remoteCompaction` details.

`calculateCost` is a loader-usable public pi-ai root export. The OpenAI Responses service-tier multiplier is not public. Copying or replacing that pricing policy is an adapter/parity concern, not a missing persistence or accounting seam.

## Tools, reasoning, text, and service-tier exposure

### Tools

Public compaction-adjacent tool information:

- `pi.getActiveTools()`: exact active names at call time;
- `pi.getAllTools()`: name, description, parameter schema, prompt guidelines, source metadata;
- persisted tool calls/results, including `ToolResultMessage.addedToolNames` load points;
- final serialized `payload.tools` and deferred input items in `before_provider_request` for an ordinary request.

Not publicly exposed through ExtensionAPI:

- complete `ToolDefinition`/pi-ai `Tool` objects;
- `constrainedSampling` metadata;
- the ordinary converter's grammar-input-property and deferred-tool maps.

Ordinary function-tool payload construction is expressible. Exact grammar `custom_tool_call` and deferred `tool_search_*` parity is not directly expressible from the dedicated compaction data. Under map #35, this is a non-core parity limitation unless the later human contract explicitly makes those tool classes core.

### Reasoning

`ctx.model`, `ctx.thinkingLevel`, `pi.getThinkingLevel()`, `model.reasoning`, and `model.thinkingLevelMap` are public. They support a deterministic fallback request. The exact final ordinary request's `reasoning` object is observable in `before_provider_request`, including model sampling-parameter overrides.

### Text configuration

There is no `ctx` getter for Responses `text`. The final provider payload is the available seam. The current project records only `text.verbosity` and rejects structured-output format carryover; that is project policy, not a Pi API guarantee.

### Service tier

There is no session-level service-tier getter. The final ordinary payload exposes `service_tier`; the API-specific model-call option can also set it. Associating the observed value with session/model key and deciding when it is stale are project-owned policies.

## Core adapter requirements

The following behavior is required from project-owned code even when all usable Pi seams are employed:

1. **Opaque Responses compaction extraction and validation.** Pi's high-level assistant result drops compaction items. Project code must capture/receive raw events, parse SSE, require completion, validate exactly one compaction item, and handle retry/abort/error semantics.

2. **Remote-compaction request policy.** The project must decide whether to:
   - construct and send direct HTTP/SSE using resolved auth/base URL; or
   - call the public high-level provider with `onPayload` plus a per-call fetch capture adapter for supported HTTP providers.

   Pi has no single public “raw Responses operation” abstraction that returns opaque items.

3. **Replacement-history domain logic.** Selecting retained explicit items, storing the compaction item, validating versions/model keys, normalizing prompt items, and reconstructing state from details are project semantics.

4. **Native replay mutation.** Pi supplies arbitrary final-payload replacement, but locating the replay replacement span, detecting ambiguity, removing stale continuation fields, and injecting replacement history are project semantics.

5. **Any exact Responses conversion beyond the indirect provider call.** A standalone build-only conversion path needs a project converter because the public converter subpaths are loader-unusable. Exact grammar/deferred behavior additionally lacks full tool metadata.

6. **Usage extraction from raw Responses events and any service-tier price adjustment.** Pi will persist and aggregate a completed `Usage`, but project code must produce it from the raw compaction response.

These are adapter requirements, not evidence that linear remote compaction is impossible on Pi 0.84.2.

## True capability gaps and conditional gaps

### Established

- **No public provider-aware raw Responses event-stream operation.** Pi exposes high-level model streams/results and per-call HTTP fetch injection, but not an opaque operation that an independent provider transport can handle and return unconsumed events. This is the capability described by issue #8 and is outside map #35's provider-aware transport scope.

- **No loader-usable standalone Responses converter.** The package-level converter is public, but the production loader prevents the import. This forces either an actual high-level provider call or a project-owned converter. It is a real loader/API seam gap, but not an unbridgeable core-product blocker.

### Conditional on a human definition

- **Exact post-`context`-hook compaction context.** If “core compaction context” means the final message list after every extension's ordinary `context` middleware, Pi does not expose that list to `session_before_compact` or provide a method to run the chain. If core means persisted compaction-aware session context, there is no gap.

- **Load-order-independent preservation of every payload extension.** `before_provider_request` is ordered middleware, not a final transaction. If the product requires this extension to preserve mutations made by later handlers without any load-order contract, Pi provides no final-payload commit hook. If normal middleware composition is acceptable, there is no gap.

- **All active tool protocol classes in remote compaction.** If grammar custom tools and deferred search are declared core, full tool metadata/converter exposure is insufficient. Under the map's current parity rule they are not a true core gap.

### No gap found

No true gap was found for:

- selecting eligible models by exact `model.api`;
- reading the selected model and thinking level;
- resolved auth, configured headers, credential base URL, and model base URL;
- constructing persisted, compaction-aware session context;
- cancelling or atomically returning custom compaction;
- persisting arbitrary compaction details;
- reconstructing details after reload/resume;
- repeated compaction;
- mutating ordinary provider payloads;
- recording compaction usage in Pi's normal totals.

## Non-gaps and out-of-scope parity

The following should not be graduated as necessary Pi capability gaps from this research alone:

- exact mirroring of Pi's private Responses implementation;
- exact Codex request fields, telemetry, identity headers, or client metadata;
- reuse of Pi's private service-tier price multiplier;
- grammar/custom-tool field parity and deferred tool-search synthesis, unless HITL expands core tool scope;
- fork/tree/model-switch matrices;
- version 1 project detail compatibility;
- provider-aware HTTP/WebSocket/raw transport composition;
- benchmark evidence.

## Comparison with the current repository

### Behavior aligned with verified seams

- `src/index.ts` imports `buildSessionContext`, `convertToLlm`, and `ExtensionAPI` from the supported coding-agent root.
- Runtime pi-ai values are imported from the supported root; no `api/*` or private runtime subpath is imported.
- `session_before_compact` returns Pi's standard compaction shape with `details` and top-level `usage`.
- `ctx.modelRegistry.getApiKeyAndHeaders(model)` is the correct public starting seam for model-specific resolved auth; the direct adapter must still decide whether core requires additional public `model.headers` and provider-generated headers.
- Credential-resolved `auth.baseUrl` is passed separately from stable provider/API/model identity, matching ADR 0004.
- `before_provider_request` patches ordinary requests without registering or overriding providers, matching ADR 0003's ordinary-request ownership boundary.
- Replay state is rebuilt from persisted compaction details on `session_start` and after lifecycle changes.
- Usage is returned in Pi's standard field and therefore reaches normal totals.

### Stale or over-broad claims

1. **The development baseline is stale.** `package.json` pins all three Pi development packages to `0.84.0`, directly conflicting with map #35's exact 0.84.2 baseline. Peer dependencies remain `*`, and the repository has no lockfile in the inspected checkout. This research used the installed 0.84.2 runtime, not those stale development declarations.

2. **“Pi 0.84's public extension surface does not expose the converter” needs precision.** The pi-ai converter and grammar helper are public package exports, but they are unusable through the production extension loader. The README should distinguish package-public from loader-usable. Its conclusion that the current root-only imports are required is correct.

3. **The README labels grammar/deferred conversion as a capability gap.** The underlying exposure limitation is factual, but under map #35 it is a non-core parity limitation unless the human contract explicitly requires those tool protocol classes. Inability to mirror those internals is not itself a necessary core capability gap.

4. **“Pi's effective context” is over-broad.** Current code uses `buildSessionContext(event.branchEntries)` plus `convertToLlm`, which is Pi's persisted compaction-aware context. It does not include ephemeral `context` hook transformations, the AgentSession image-blocking wrapper, or the final provider payload. The later specification must define which meaning is intended.

5. **The raw transport claim is directionally correct but incomplete.** Pi does not expose the provider-aware raw transport required by issue #8. It does expose per-call custom `fetch` and `onPayload` on public provider calls, which can capture raw HTTP/SSE for fetch-based providers. That is a possible project adapter seam, not independent transport composition and not a raw high-level result.

6. **The direct remote request does not reproduce Pi's complete final header assembly.** Current code passes `auth.headers` to its own header builder but does not merge public `model.headers`, and a direct `fetch` cannot automatically receive API-specific dynamic headers, session-affinity/attribution headers, or other extensions' `before_provider_headers` mutations. This does not invalidate resolved credentials/base URL, but README/CHANGELOG wording about Pi request auth should not be read as final-wire-header parity.

7. **Version 1 project details are still documented and implemented.** README says legacy version 1 details remain readable, and `extractRemoteCompactionDetails()` accepts them. Map #35 says version 1 compatibility is not required. This is stale scope for the later refactor, not a Pi limitation.

8. **README lifecycle scope exceeds the map.** It claims reconstruction after tree navigation, forks, and model-switch round trips. Those may remain tested current behavior, but they are not evidence of required core seams for this map.

### Pi documentation conflict

- Installed Pi `docs/session-format.md` documents `retainedTail` as a newer compaction field.
- Installed Pi 0.84.2 code and declarations have no such field and use `firstKeptEntryId`.

This is an upstream docs/runtime conflict. For an exact runtime baseline, the later spec should cite the runtime behavior. No project decision about adopting `retainedTail` should be made from the stale Markdown claim.

## HITL conflicts and open questions

These are factual conflicts or choices surfaced by the research; this asset does not decide them.

1. **What does the core contract mean by “effective context”?**
   - Persisted compaction-aware context: fully available with public APIs.
   - Exact ordinary-call context after every `context` hook and image setting: unavailable at the compaction event.
   - Final provider input: observable only during an actual request and relative to payload-handler load order.

2. **Which public-request strategy should the later design choose?**
   - Current direct HTTP/SSE adapter: explicit, provider-agnostic by endpoint/API shape, and already preserves the raw item, but bypasses provider hooks/transports.
   - `ModelRegistry.complete` plus `onPayload` and per-call fetch capture: reuses Pi conversion/auth/provider request construction for fetch-based providers, but the high-level result drops the item, custom fetch is not transport-neutral, and provider/extension hook composition differs.

   This is a product/architecture choice. Research establishes both seams; it does not select one.

3. **Does core tool support include grammar custom tools or deferred tool search?**
   - If no, current public basic tool metadata is sufficient for the minimum contract and the parity differences remain non-core.
   - If yes, the public compaction/tool surface lacks complete metadata and a loader-usable converter, creating an additional adapter/API requirement.

4. **Is normal extension load-order middleware acceptable for native replay?**
   - Current `before_provider_request` composition preserves prior handlers' payload additions and exposes the replacement to later handlers.
   - It cannot guarantee preservation if a later handler replaces the payload wholesale.

5. **The exact baseline must be made real in development tooling.** The map says 0.84.2; current development dependencies say 0.84.0. The later implementation plan must resolve that mismatch before its evidence can be considered 0.84.2 evidence.

## Source references

### Repository

- `CONTEXT.md`
- `README.md`
- `package.json`
- `CHANGELOG.md`
- `src/index.ts`
- `src/openai.ts`
- `src/remote-compaction.ts`
- `src/state.ts`
- `docs/adr/0001-select-models-by-api-contract.md`
- `docs/adr/0002-prefer-native-replay-continuity.md`
- `docs/adr/0003-keep-provider-transport-independent.md`
- `docs/adr/0004-keep-resolved-endpoints-out-of-model-identity.md`
- `tests/smoke.ts`
- GitHub issues #35, #37, and #8

### Installed Pi 0.84.2 documentation and examples

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- `docs/extensions.md`
- `docs/compaction.md`
- `docs/session-format.md`
- `docs/sessions.md`
- `docs/packages.md`
- `docs/models.md`
- `docs/providers.md`
- `docs/custom-provider.md`
- `docs/sdk.md`
- `examples/extensions/README.md`
- `examples/extensions/custom-compaction.ts`
- `examples/extensions/provider-payload.ts`
- `examples/extensions/reload-runtime.ts`
- `examples/extensions/trigger-compact.ts`
- `examples/extensions/summarize.ts`
- `examples/extensions/dynamic-tools.ts`
- `examples/extensions/handoff.ts`
- `examples/extensions/custom-provider-anthropic/index.ts`
- `examples/extensions/custom-provider-gitlab-duo/index.ts`

### Installed coding-agent runtime/declarations used as behavioral evidence

- `package.json`
- `dist/index.js`
- `dist/index.d.ts`
- `dist/core/extensions/loader.js`
- `dist/core/extensions/types.d.ts`
- `dist/core/extensions/runner.js`
- `dist/core/agent-session.js`
- `dist/core/compaction/compaction.d.ts`
- `dist/core/messages.js`
- `dist/core/model-registry.js`
- `dist/core/model-registry.d.ts`
- `dist/core/model-runtime.js`
- `dist/core/provider-composer.js`
- `dist/core/sdk.js`
- `dist/core/session-manager.js`
- `dist/core/session-manager.d.ts`
- `dist/core/usage-totals.js`
- `dist/modes/interactive/components/footer.js`

### Installed pi-ai 0.84.2 runtime/declarations used as behavioral evidence

- `package.json`
- `dist/index.d.ts`
- `dist/compat.d.ts`
- `dist/models.d.ts`
- `dist/types.d.ts`
- `dist/api/openai-responses.d.ts`
- `dist/api/openai-responses.js`
- `dist/api/openai-responses-shared.d.ts`
- `dist/api/openai-responses-shared.js`
- `dist/api/constrained-sampling.d.ts`
