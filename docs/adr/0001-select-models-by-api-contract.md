# Select models by API contract

Remote compaction eligibility uses exact `openai-responses` for any provider, plus Pi's built-in `openai-codex` provider with exact `openai-codex-responses`; the latter is provider-scoped because Pi's Codex API is the ChatGPT OAuth protocol rather than a third-party-compatible Responses API. Eligibility only permits an attempt, while endpoint capability remains runtime-discovered.
