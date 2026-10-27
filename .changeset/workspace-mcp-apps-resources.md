---
"@opengeni/contracts": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
---

A host tool server can ship MCP Apps views. When a host registration lists resources (`listResources`/`readResource` on `LocalMcpServerRegistration`), its tools' `_meta.ui.resourceUri` (`ui://….html`) reaches the workspace MCP `tools/list`, the workspace MCP server declares `resources`, and `resources/list` and `resources/read` serve each view (`text/html;profile=mcp-app`) only through a tool the caller's catalog lists. Every other URI answers `-32002` without saying whether it exists, and a caller whose authority was revoked gets the same refusal for every URI. Tool catalog entries gain an optional `meta.ui.resourceUri` (`AttemptToolCatalogMeta`), and `MCP_APP_RESOURCE_MIME_TYPE` and `McpAppResourceUri` are exported. Without a host registration that lists resources nothing changes.
