---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

A host that governs an organization can read one of its memberships back: `GET /v1/host/organizations/:id/members/:membershipId` answers `HostOrganizationMember` (`membershipId`, `organizationId`, `userId`, `identityId`, `status`, `role`, `authorizationRevision`, `sharedWorkspaceAccess`, `updatedAt`) for a membership in any status, with the identity lookup's field meanings. It authenticates like the invitation read (service delegated token for the organization with `members:manage`, an administrator subject, a governed organization), writes nothing and sends `cache-control: no-store`. An unknown membership and one in another organization both answer `404 HOST_MEMBER_NOT_IN_ORGANIZATION`. New exports `HostOrganizationMember` and `HOST_MEMBER_NOT_IN_ORGANIZATION` (`@opengeni/contracts/organization-governance`) and `readOrganizationHostMember` (`@opengeni/db`). Without the governance port the route does not exist.
