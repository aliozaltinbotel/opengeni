---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

A host that governs an organization can read what that organization knows about a native identity: `POST /v1/host/organizations/:id/identities/lookup` with `{ identityId }` (the host session token's `sub`) answers the identity's status, its verified email (or null), its active login binding `{ id, revision }` (or null), its memberships in the organization `[{ id, status, role }]` (any status answers; the host must refuse a membership that is not `active`) and the organization's invitations it accepted. Every answer is `cache-control: no-store`. It authenticates like the host commands (service delegated token for the organization with `members:manage`, an administrator subject, a governed organization) and writes nothing. An identity with no membership in the organization answers `404 HOST_IDENTITY_NOT_IN_ORGANIZATION`, the same as an unknown one. New contracts `HostLookupOrganizationIdentityRequest` and `HostOrganizationIdentity` in `@opengeni/contracts/organization-governance`. Without the governance port the route does not exist.

Host commands whose actor the database refuses (the token's subject is not an active owner or admin, or a role rule) keep their `403` and message and now carry `details.code = "HOST_COMMAND_ACTOR_NOT_AUTHORIZED"`.

Migration 1016 (rolling) adds `organization_membership_invitations.accepted_at`, set by trigger when an invitation is accepted and filled for invitations accepted before it, and `opengeni_private.lookup_organization_host_identity(uuid, text, uuid)`, the lookup by identity. Its runtime `EXECUTE` is withheld for one release (`DEFERRED_RUNTIME_PRIVATE_ROUTINES`; tests grant it with `grantDeferredRuntimeAccess`); until a later migration grants it, the route answers the same through the organization's member list.
