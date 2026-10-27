---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

A host that governs an organization can read what that organization knows about a native identity: `POST /v1/host/organizations/:id/identities/lookup` with `{ identityId }` (the host session token's `sub`) answers the identity's status, its verified email (or null), its active login binding `{ id, revision }` (or null) and the organization's invitations it accepted. It authenticates like the host commands (service delegated token for the organization with `members:manage`, an administrator subject, a governed organization) and writes nothing. An identity with no membership in the organization answers `404 HOST_IDENTITY_NOT_IN_ORGANIZATION`, the same as an unknown one. New contracts `HostLookupOrganizationIdentityRequest` and `HostOrganizationIdentity` in `@opengeni/contracts/organization-governance`; no migration. Without the governance port the route does not exist.
