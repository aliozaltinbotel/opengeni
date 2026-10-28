---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

A host that governs an organization can read one of its MCP connections (an outside MCP client a member signed in with, organization or workspace bound): `GET /v1/host/organizations/:id/mcp-connections/:connectionId` answers `HostOrganizationMcpConnection` (`connectionId`, `organizationId`, `workspaceId`, `clientId`, `status`, `reason`, `consentScope`, `revokedAt`, `updatedAt`). `status` is `active` only while the connection's next request would resolve a live grant; otherwise `revoked` with `reason` `revoked`, `expired`, `membership_not_live` or `permissions_lost` (`HOST_MCP_CONNECTION_NOT_LIVE_REASONS`). It authenticates like the other host reads, writes nothing and sends `cache-control: no-store`. An unknown connection and one in another organization both answer `404 HOST_MCP_CONNECTION_NOT_IN_ORGANIZATION`. New exports `HostOrganizationMcpConnection`, `HostMcpConnectionConsentScope`, `HOST_MCP_CONNECTION_NOT_LIVE_REASONS` and `HOST_MCP_CONNECTION_NOT_IN_ORGANIZATION` (`@opengeni/contracts/organization-governance`), and `getMcpOAuthConnectionRecord` and `accountPermissionsForOrganizationRole` (`@opengeni/db`). `resolveLiveMcpOAuthGrant` now accepts any grant snapshot with its refresh family id. The user-facing connected-agents routes are unchanged.
