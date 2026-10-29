---
"@opengeni/contracts": minor
"@opengeni/api-router": minor
---

A host tool's MCP Apps `_meta.ui` that names no view and only a `visibility` (MCP Apps `McpUiToolMeta.resourceUri` is optional) is now forwarded on the workspace MCP's `tools/list` as `{ visibility }` instead of being dropped, so a client no longer applies the wider default. Such a tool serves no view. The catalog's `meta.ui` becomes a union of `McpAppToolUiMeta` and the new `McpAppToolVisibilityUiMeta`; `mcpAppToolUiMeta` returns either. A malformed `visibility`, which still falls back to the default, is logged as a host registration warning naming the server and tool.
