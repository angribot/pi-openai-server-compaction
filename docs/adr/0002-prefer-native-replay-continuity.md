# Prefer native replay continuity

A successful Remote compaction v2 operation atomically persists exactly one opaque compaction item as replacement history together with the fixed, non-summary checkpoint marker. Later compatible ordinary requests replace the uniquely reconstructed replay replacement span with that item.

The extension never generates a second text summary or falls back to Pi's text compactor. If preparation, the remote operation, persisted-state validation, or safe replay cannot complete, it cancels or aborts instead of sending incomplete context. This preserves native replay continuity at the cost of portability to incompatible models and pre-refactor checkpoints.
