---
"@opengeni/api-router": minor
---

The governed default-deny (`memberRouteAccess: "allowlist"`) also refuses the session routes that reuse a generic allowed operation for a closed subject: `GET …/codex-accounts`, `GET …/model-account`, `GET …/background-commands`, `DELETE …/background-commands/:commandId`, `GET` and `POST …/sandbox-recovery`, and `GET …/admin-access` under `/v1/workspaces/:workspaceId/sessions/:sessionId`. A person of a governed organization gets `403 WORKSPACE_ROUTE_NOT_ALLOWED` on them; `governedRouteTable` lists them as refused. New export `GOVERNED_MEMBER_SESSION_ROUTE_DENIALS` (`@opengeni/api-router/app`). Without the opt-in nothing changes.
