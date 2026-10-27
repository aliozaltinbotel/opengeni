---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

An embedding host can govern the organizations it provisions. Bind `organizationGovernance` (`AppDependencies` or the `startApi` option) with `governs({ organizationId, externalSource })`, which must answer a boolean synchronously, and `decide({ organizationId, mutation, via })`. In a governed organization every native route that invites, changes roles, suspends, reactivates or offboards members, changes workspace or external members, creates or revokes API keys, personal API keys and service accounts, connects MCP agents, runs an organization recovery operation, or deletes a workspace answers `403 ORGANIZATION_GOVERNED_BY_HOST` unless the host allows it (`GOVERNED_MUTATIONS` in the new `@opengeni/contracts/organization-governance` export). The host runs the same operations through `/v1/host/organizations/:id/...` commands (invitations, invitation revoke, role change, suspend, reactivate, offboard, and setting or revoking a member's workspace access) with a service delegated token, and `organization_host_command_attributions` (migration 1015) names the acting external user next to each receipt. Without the port nothing changes and the host routes do not exist.
