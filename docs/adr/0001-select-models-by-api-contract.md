# Select models by API contract

Remote compaction eligibility is determined by the exact `openai-responses` API type, not by provider name, endpoint hostname, or model name. The extension targets a protocol contract: this permits custom providers and relays while excluding similarly named APIs whose request and compaction semantics differ.
