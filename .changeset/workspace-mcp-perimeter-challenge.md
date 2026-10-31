---
"@opengeni/api-router": patch
---

A workspace MCP request (`/v1/workspaces/:workspaceId/mcp`, `/mcp/docs`, `/mcp/files`) that the deployment access-key perimeter refuses now carries the same `WWW-Authenticate: Bearer resource_metadata="…", scope="mcp:access"` challenge the MCP route sets, so a client with no token, or with a bearer that is not an MCP OAuth token, can discover the protected-resource metadata (RFC 9728). The challenge is built from the configured public base URL and the request's workspace MCP path only. The refusal is unchanged: still a 401 with no data, and no other route's 401 changes.
