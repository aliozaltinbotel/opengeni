---
"@opengeni/contracts": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
---

The workspace MCP forwards a host tool's whole MCP Apps `_meta.ui`, not only `resourceUri`: `visibility` (`"model"`, `"app"`) now reaches `tools/list`, the deprecated flat `ui/resourceUri` key is read as a fallback view, and `resources/read` contents carry the view's resource `_meta.ui` (`csp`, `permissions`, `domain`, `prefersBorder`) when the host's `readResource` returns one (`LocalMcpServerRegistration.readResource` may now return `_meta`). The catalog's `meta.ui` gains the optional `visibility`. New exports in `@opengeni/contracts`: `McpAppToolUiMeta`, `McpAppToolVisibility`, `McpAppResourceUiMeta`, `mcpAppToolUiMeta`, `mcpAppResourceUiMeta`.
