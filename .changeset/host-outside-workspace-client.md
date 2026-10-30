---
"@opengeni/react": minor
---

Add `OpenGeniClientProvider`: a client with no workspace, for pages outside every workspace. `useOpenGeniClient` falls back to it, so client-scoped hooks such as `useWorkspaces` work below it, while workspace-scoped hooks still need an `OpenGeniProvider`. The console mounts it, with the signed-in person's own client, above a host extension's signed-in outside-workspace pages; signed-out pages are unchanged.
