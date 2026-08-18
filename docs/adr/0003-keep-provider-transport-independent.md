# Keep provider transport independent

The extension owns Remote compaction protocol behavior and replacement-history injection but does not register providers or choose transport for ordinary requests. Ordinary post-checkpoint requests continue through the selected provider's independently configured transport.

Pi `0.84.2` does not expose a production-loader-usable raw Responses seam that both proves explicit `response.completed` and preserves unknown output items such as `compaction`. The narrow Remote compaction operation therefore remains direct HTTP/SSE through Pi's public routing and credential seams. Global fetch patching, provider inference, and private cross-extension transport protocols remain rejected because they create ambiguous ownership and unsafe coupling.

The direct adapter should be deleted wholesale when Pi exposes a public provider-aware raw Responses operation that preserves explicit completion and opaque output items, propagates abort, and allows this extension to own the shared retry budget.
