# Keep provider transport independent

The extension owns remote compaction and replacement-history injection but does not register providers or choose the transport for ordinary requests. The remote-compaction RPC remains direct HTTP/SSE until Pi exposes a public provider-aware raw transport API; global fetch patching, provider inference, and private cross-extension protocols were rejected because they introduce ambiguous ownership and unsafe coupling.
