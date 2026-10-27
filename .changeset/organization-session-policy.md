---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/react": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

An organization that a bound `organizationGovernance` port governs gets a session policy (migration 1017, `@opengeni/contracts/organization-session-policy`): whether people may attach files in its workspaces' sessions, and which generic tool families (`shell`, `codemode`, `browser`, `computerUse`) its sessions never receive. The governed default turns attachments off and denies all four families; the host replaces it with `PUT /v1/host/organizations/:id/session-policy` (mutation `session_policy.update`), and no native route writes it. Refusals are `403 ATTACHMENTS_DISABLED` (uploads, upload completion, file attachments on session create and messages) and `403 SESSION_TOOL_FAMILY_DENIED` (Codemode, browser, computer and terminal routes); denied tools are never registered by the first-party MCP server and are removed from every turn's catalog in the worker, which also mints no Codemode bearer for them. The workspace-scoped client config reports `fileUploads.enabled: false` and the console hides attach controls. Ungoverned organizations, and deployments without the port, are unchanged.
