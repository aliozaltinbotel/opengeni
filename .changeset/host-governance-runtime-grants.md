---
"@opengeni/db": minor
---

Migration 1019 (rolling) grants every application role `EXECUTE` on the three host governance routines that 1016, 1017 and 1018 created withheld: `opengeni_private.lookup_organization_host_identity(uuid, text, uuid)`, `opengeni_private.ensure_organization_host_owner(uuid, text, uuid)` and `opengeni_private.put_host_organization_session_policy(uuid, text, uuid, text, text, text[], text, bigint)`. They leave `DEFERRED_RUNTIME_PRIVATE_ROUTINES`, so readiness and provisioning now require them; a runtime without one of the grants is unready and names the routine (`runtime role lacks EXECUTE on private routine …`).
