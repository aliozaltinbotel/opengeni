---
"@opengeni/api-router": minor
---

`GOVERNED_MEMBER_SESSION_ROUTE_DENIALS` also lists `GET …/model-source-basis` (model and account provenance, `session.read`) and `PUT …/usage-limit` (the task budget, `session.control`) under `/v1/workspaces/:workspaceId/sessions/:sessionId`, so a person of a governed organization (`memberRouteAccess: "allowlist"`) gets `403 WORKSPACE_ROUTE_NOT_ALLOWED` on them. `GET …/usage-limit` and `POST …/retry` stay allowed. Without the opt-in nothing changes.
