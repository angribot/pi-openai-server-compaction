# Keep resolved endpoints out of model identity

Persisted native replay compatibility uses a structured model key containing provider, exact API type, and model ID. Credential-resolved endpoints and request headers are per-request routing data and do not participate in that identity.

Separating identity from routing keeps persisted Remote compaction v2 state stable when credentials or endpoint resolution change. The direct operation may send a compaction request to a credential-resolved base URL while replay still compares exact structured provider/API/model identity.

The trade-off remains that two routes sharing the same model key are assumed to accept the same opaque compaction item. The extension cannot prove endpoint-level compatibility without persisting routing data, which would couple session identity to credentials and deployment details.
