# Keep provider transport independent

The extension owns Remote compaction protocol and Native replay but does not register providers or control ordinary-request transport. Keep narrow SSE adapters until an equivalent public provider-aware raw Responses operation exists; reject global patches, copied provider authentication, and private cross-extension coupling.

The original adapter decision was made against Pi `0.84.3`, which lacked that public operation. The current baseline is Pi `1.2.0`; the remaining constraints are narrower than an inability to observe opaque output.

ADR-0007 expands the original built-in-only Codex scope while preserving provider-owned authentication and routing; the actual selected provider is never rewritten.

At the Pi `1.2.0` baseline, Codex success capture uses the public per-call `onProviderStreamEvent` observer before normalization. It preserves opaque compaction fields and explicit `response.completed`/`response.done` events, but is not a raw-operation interface: HTTP failures never reach it, and an idle stream produces no callback. A narrow cloned-response supervisor therefore remains for HTTP diagnostics and `Retry-After`, raw framing and JSON failures, idle timeout, and explicit wire completion. It does not collect successful output items or usage; those come from the observer and require successful provider completion as well as raw completion. Attempt-owned cancellation still settles both readers without server EOF.

This supersedes success-item capture from the raw Codex response, not provider transport ownership. Direct Responses retains HTTP/SSE adaptation; no equivalent provider-owned raw operation is established by a parsed-event observer. The [technical reference](../reference.md#transport-boundary-and-limitations) owns the current adapter and loader boundaries.
