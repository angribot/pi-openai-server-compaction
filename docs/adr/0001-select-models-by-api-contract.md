# Select models by API contract

Remote compaction eligibility is determined by exact, case-sensitive `model.api === "openai-responses"`, not by provider name, endpoint hostname, or model name. The extension targets the Remote compaction v2 protocol contract, which permits custom providers and relays while excluding similarly named APIs with different request semantics.

Eligibility permits an attempt; it does not assert Remote compaction capability. Whether the selected endpoint accepts the terminal `compaction_trigger` and returns one valid compaction item is discovered from the operation's outcome.
