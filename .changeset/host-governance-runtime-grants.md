---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

Migration 1019 (rolling) grants every application role `EXECUTE` on the three host governance routines that 1016, 1017 and 1018 created withheld: `opengeni_private.lookup_organization_host_identity(uuid, text, uuid)`, `opengeni_private.ensure_organization_host_owner(uuid, text, uuid)` and `opengeni_private.put_host_organization_session_policy(uuid, text, uuid, text, text, text[], text, bigint)`. It also grants `opengeni_private.session_machine_owner_subject_v1(uuid, uuid, uuid)` (0978) and `opengeni_private.rearm_unanswered_connected_commands(uuid, uuid, text)` (0984), which the previous release knows as well, so the personal-machine owner wait and the connected-command re-arm on a runner's report are now on. All five leave `DEFERRED_RUNTIME_PRIVATE_ROUTINES` (now empty), so readiness and provisioning now require them; a runtime without one of the grants is unready and names the routine (`runtime role lacks EXECUTE on private routine …`).

Their "not yet" paths are gone. The host identity lookup always reads by identity (no member-list fallback, so no `409` past the administration overview's bound). `bootstrapWorkspace({ governedOrganizationOwner: true })` always writes the owner of an organization it creates, and `POST /v1/host/organizations/:id/host-owner/ensure` and `PUT /v1/host/organizations/:id/session-policy` no longer answer `503`. Removed exports: `HOST_ORGANIZATION_OWNER_UNAVAILABLE` (`@opengeni/contracts/organization-governance`), `HOST_SESSION_POLICY_UNAVAILABLE` (`@opengeni/contracts/organization-session-policy`), and `hostOrganizationOwnerGranted`, `hostIdentityLookupGranted` and `hostSessionPolicyWriteGranted` (`@opengeni/db`). `ensureOrganizationHostOwner` and `putHostOrganizationSessionPolicy` no longer return `null`.

For an organization bootstrapped before its owner could be written, call `POST /v1/host/organizations/:id/host-owner/ensure` once after 1019 is applied.
