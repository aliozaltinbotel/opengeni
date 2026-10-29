---
"@opengeni/api-router": minor
---

A workspace MCP OAuth connection whose recorded consent level is read-only (Read only, or Custom whose permissions change nothing) now checks each frozen tool's current annotations on every request, on `/mcp`, `/mcp/files` and `/mcp/docs`: a tool that keeps its name but no longer declares `readOnlyHint: true` (or becomes destructive) leaves `tools/list`, and `tools/call` answers `-32602` with `data.code: "TOOL_NOT_CONSENTED"`. The check keys on the recorded level (`McpOAuthRouteAccess.consentPreset`), so a Full consent, or one recorded before levels existed, is never narrowed. `prepareMcpOAuthWorkspaceToolGateway` takes the recorded consent (`{ preset, toolSetVersions }`) as its fourth argument. The consent page's Read only option now reads "Only tools that declare they only read."
