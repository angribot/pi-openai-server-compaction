# Attempt optimistic GPT replay

Require a valid structured identity, either exact `openai-responses` or `openai-codex-responses` API, and a literal case-sensitive `gpt-` request-ID prefix for Remote compaction and both sides of Native replay. This supersedes ADR-0001's catalog/provider-scoped eligibility and ADR-0005's class/equality replay policy: removing catalog maintenance permits new GPT IDs and cross-model/provider/API replay, deliberately accepting runtime backend rejection rather than claiming proven interoperability.

Retain ADR-0006's derivation from persisted successful turns, but use eligibility instead of class equality retrospectively, so old class differences alone no longer invalidate a branch. Keep the existing checkpoint format, read valid historical string/null classes as metadata, and write null for new records; do not restore ADR-0004's exact-identity gate or migrate legacy records.

Preserve ADR-0002's native continuity and fail-closed integrity protections and ADR-0003's provider transport ownership, expanding its Codex scope to any configured provider on that API without identity normalization. Endpoint rejection never triggers item stripping or text fallback; host snapshots, unique replay spans, successful-turn continuity, and cache-warming protection remain mandatory.
