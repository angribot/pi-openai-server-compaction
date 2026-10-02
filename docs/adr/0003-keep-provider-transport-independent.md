# Keep provider transport independent

The extension owns Remote compaction protocol and Native replay but does not register providers or control ordinary-request transport. Because Pi `0.84.3` has no provider-aware raw Responses operation that preserves explicit completion and opaque `compaction` items, the extension keeps narrow SSE adapters—direct for `openai-responses` and Pi-mediated response capture for Codex Responses on any configured provider—until that public seam exists, while rejecting global patches, copied provider authentication, and private cross-extension coupling.

ADR-0007 expands the original built-in-only Codex scope while preserving provider-owned authentication and routing; the actual selected provider is never rewritten.
