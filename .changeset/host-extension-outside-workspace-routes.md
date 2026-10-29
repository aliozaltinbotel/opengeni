---
"@opengeni/react": minor
---

A web console host extension can mount pages outside any workspace, for people who have none yet: `HostExtension.outsideWorkspaceRoutes` takes `{ path, load, access? }` entries at the console's top level. A `"public"` page renders before configuration and sign-in (a signed-out visitor reaches it); a `"signedIn"` page (the default) renders once the person is signed in, before the workspace access and onboarding gates. They render inside the new `outsideWorkspaceProviders` (components that take only `children`), since `shellProviders` take a workspace. The console refuses a path with params, with uppercase, or whose first segment is one of its own top-level routes or the API and asset paths beside it. New type: `HostExtensionOutsideWorkspaceRoute`. A console without these pages is unchanged.
