# Prompt Caching

Shannon Code now builds the system prompt from named sections. Static sections are
safe to cache across turns, while dynamic sections are rebuilt for each request.

Cacheable static sections:

- `agent_core`: role, tool-use guidance, and general safety policy.
- `skills`: stable skill names, descriptions, modes, and allowed tool lists.

Dynamic sections:

- `workspace`: current workspace and date.
- `project_rules`: local AGENTS/CLAUDE/rules content.
- `memory`: recalled memories for the current prompt.

Providers advertise support through `supportsPromptCaching`. If a provider does
not support caching, Shannon sends the same plain text system prompt as before.
If a provider supports caching, the system message includes a generic
`cacheControl: { type: "ephemeral", key, sectionNames }` hint plus the prompt
sections. Anthropic-style providers can translate this metadata to their native
`cache_control` fields; OpenAI-compatible chat providers currently ignore it.

Cost impact: cache hits reduce repeated static prompt input cost and latency on
providers that bill or process cached tokens differently. Dynamic sections are
not included in the cache key, so changing cwd, project rules, or memory recall
does not accidentally reuse stale context.

