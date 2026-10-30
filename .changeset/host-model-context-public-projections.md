---
"@opengeni/contracts": patch
"@opengeni/events": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Remove host-only `modelContext` and `initialModelContext` fields from public message/creation event projections, including HTTP forensic reads, SSE, MCP and message acceptance replies. Canonical stored events, model history and trusted worker claims retain the original context. Filtered HTTP responses no longer advertise exact forensic payloads; event identities, ordering and continuation cursors are preserved.

The authenticated `/model-context` diagnostic remains an explicit exception: its raw captured provider request can contain rendered host context for viewers already authorized to read that session. This change does not introduce a separate diagnostic permission.
