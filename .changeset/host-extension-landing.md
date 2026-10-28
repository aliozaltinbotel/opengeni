---
"@opengeni/react": minor
---

A web console host extension can choose where the console opens a workspace: `HostExtension.landing` is a workspace-relative path, `"sessions"` (the default) or one of the extension's own routes without params, and both the root redirect and `workspaces/$workspaceId/` open it. The console refuses a landing that is not a registered route or has a param. New export: `workspaceLanding(extension)`, a pure resolver. A console without a landing opens sessions as before.
