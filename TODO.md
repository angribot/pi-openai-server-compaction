# TODO

## Route remote compaction through a generic provider transport seam

### Capability gap

Remote compaction currently sends its raw Responses request with `globalThis.fetch` and parses the returned SSE events itself. This preserves the opaque `compaction` item, but it bypasses provider transports registered through Pi's `streamSimple` path.

Consequently, a provider whose ordinary `openai-responses` requests are handled by an independently configured WebSocket transport still performs the remote-compaction request over HTTP/SSE.

### Desired behavior

When Pi exposes a public raw provider-transport API or middleware, remote compaction should submit its request through that seam with explicit metadata such as:

- model and provider;
- session ID;
- operation type (`compaction`);
- URL, headers, body, and abort signal.

A transport extension could then independently choose WebSocket or HTTP/SSE according to its own provider settings. This extension would remain responsible only for constructing the compaction payload, parsing the raw response events, validating the opaque artifact, and rebuilding replacement history.

### Required properties

- No import or direct dependency between this extension and a transport extension.
- No reading another extension's settings or internal state.
- No dependency on extension load order.
- Preserve the raw `response.output_item.done` event and opaque `compaction` item.
- Preserve an unchanged HTTP/SSE fallback when no transport middleware handles the request or WebSocket fails before streaming starts.
- Keep compaction off ordinary socket-bound continuation state; a WebSocket compaction request should use an isolated, non-pooled connection.
- Continue to work when loaded without any transport extension.

### Rejected workarounds

Do not implement this by:

- monkey-patching `globalThis.fetch`;
- inferring the provider from URL or authorization headers;
- importing a WebSocket implementation into this project;
- sharing a private global registry or hidden protocol between extensions;
- routing through the current high-level `streamSimple` result, which does not expose the raw opaque compaction artifact.

These approaches introduce unsafe concurrency/reload behavior, ambiguous provider attribution, or cross-extension coupling.

### Blocker

Pi currently has payload and header hooks but no public, provider-aware raw transport seam that returns the unconsumed Responses event stream. Revisit this item only when Pi provides that capability or an equivalent stable public API.

### Acceptance criteria

- A provider selected by an independent transport extension can send both ordinary Responses requests and remote-compaction requests through that transport.
- A provider not selected by such a transport continues to use HTTP/SSE.
- A pre-stream transport failure falls back once with the original request unchanged.
- The resulting remote-compaction artifact and replacement history are identical regardless of transport.
- Cross-extension composition remains an external validation; this repository stores only tests for its own transport-neutral compaction contract.
