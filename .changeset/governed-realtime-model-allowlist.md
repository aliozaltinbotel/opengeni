---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

A governing host can limit the realtime voice models of the organizations it governs: set `allowedRealtimeModels` (realtime catalog ids, for example `opengeni-gateway/openai/gpt-realtime-2.1`) on `OrganizationGovernancePort`. Such an organization's realtime model catalog then lists only those models, and the server refuses any other one: a voice start answers 403 `forbidden` with `details.code: "REALTIME_MODEL_NOT_ALLOWED"` and the refused `model` before anything is written, and a WebRTC or WebSocket connection of a voice mode whose model is no longer allowed is refused the same way. An empty list allows none. Unset, and for an organization the host does not govern, nothing changes. New exports: `REALTIME_MODEL_NOT_ALLOWED` from `@opengeni/contracts/organization-governance`, and `organizationAllowedRealtimeModels`, `requireOrganizationRealtimeModelAllowed` and `RealtimeModelNotAllowedError` from `@opengeni/core`.
