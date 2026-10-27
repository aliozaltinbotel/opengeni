---
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
---

An embedding host can serve its own tools in process on the workspace tool gateway. Bind `workspaceToolServers({ grant, signal })` (`AppDependencies` or the `startApi` option) to return `LocalMcpServerRegistration`s; each one whose id names a deployment-static `OPENGENI_MCP_SERVERS` entry replaces that entry's remote transport for the workspace MCP server, HTTP `/tools/*`, Sites and current-human calls, under that entry's allowed tools, approval policy and the connector tool policy. A registration whose id collides with a first-party server, `codex_apps`, a workspace-installed server or another registration is refused with `HOST_TOOL_SERVER_ID_CONFLICT`. Without the port the catalog is unchanged.
