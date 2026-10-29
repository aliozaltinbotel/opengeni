---
"@opengeni/contracts": minor
"@opengeni/api-router": minor
---

The workspace MCP answers a `tools/call` for a tool this connection cannot call with a named JSON-RPC error instead of `-32603`: code `-32602` (MCP's answer to an unknown tool) with `data: { code, name }`, where `code` is `TOOL_NOT_CONSENTED` on an MCP OAuth connection for a tool outside its frozen consent, `TOOL_APPROVAL_REQUIRED` for a tool classified for human approval, and `TOOL_NOT_FOUND` otherwise. New export `WORKSPACE_MCP_TOOL_REFUSAL_CODES` (`@opengeni/contracts`).
