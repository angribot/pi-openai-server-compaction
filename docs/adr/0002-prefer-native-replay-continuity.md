# Prefer native replay continuity

A successful remote compaction persists replacement history and a fixed checkpoint marker, without generating a second text summary. If the remote operation cannot complete after bounded retries, the extension cancels compaction instead of falling back to Pi's text compactor; this protects the compaction item's native replay semantics at the cost of portable pre-compaction context for incompatible models.
