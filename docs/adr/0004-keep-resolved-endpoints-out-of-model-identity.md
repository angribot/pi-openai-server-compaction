# Keep resolved endpoints out of model identity

Persisted Native replay uses the exact provider/API/model key as a conservative compatibility boundary because Pi `0.84.2` does not expose Codex's provider-resolved Compaction compatibility class; resolved endpoints, accounts, authentication routes, and headers remain per-request routing data. This matches Codex's treatment of opaque compaction items without proving that a newly resolved route will accept old ciphertext, so service acceptance remains a runtime assumption rather than a reason to couple session state to credentials.
