---
"@opengeni/runtime": minor
"@opengeni/api-router": minor
---

A host tool server can serve MCP protocol-extension methods (for example `events/list`) on the workspace MCP server. `LocalMcpServerRegistration.extensionMethods` maps each method name to a handler called with the request's grant and abort signal, after the same live reauthorization as `tools/list`; the methods are advertised under `capabilities.experimental[<server id>]`. An MCP error a handler raises (SDK v1 `McpError` or SDK v2 `ProtocolError`) reaches the client with its code, message and data; anything else is a generic internal error. A malformed name, a core MCP method or namespace, or a method two registrations declare is refused with `HOST_MCP_METHOD_CONFLICT`. Without such a registration the workspace MCP server is unchanged.
