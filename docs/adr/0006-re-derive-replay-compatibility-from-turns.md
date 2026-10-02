---
status: accepted; class-based predicate superseded by ADR-0007
---

# Re-derive Native replay compatibility from persisted turns

Native replay re-derives compatibility from persisted successful assistant turns instead of writing request-time Compatibility decision records, superseding only the decision-record mechanism of ADR-0005 while retaining creation-time Compaction compatibility classes. To remove the persistence and decision-to-outcome pairing machinery, we accept that later catalog revisions can reinterpret existing history rather than preserve request-time compatibility judgments. Restoring record writes later cannot recover the original judgments for turns persisted without them.

ADR-0007 retains persisted-turn derivation but replaces class comparisons with the same optimistic eligibility policy for all supported checkpoints and historical turns.
