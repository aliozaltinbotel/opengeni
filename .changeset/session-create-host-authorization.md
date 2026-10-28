---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

`SessionAuthorizationPort` gains an optional, target-free `authorizeSessionCreate({ accountId, workspaceId, actor, surface })`. When a host provides it, `POST /v1/workspaces/:workspaceId/sessions` with an `initialMessage` asks it before creating anything: a refusal answers `403 SESSION_CREATE_NOT_AUTHORIZED`, a throw or an unreadable answer `503 SESSION_AUTHORIZATION_UNAVAILABLE`. New exports: the `AuthorizeSessionCreateInput` type (`@opengeni/contracts`) and `requireSessionCreateAuthorization` (`@opengeni/core`). Creates without a first message, and ports without the method, are unchanged.
