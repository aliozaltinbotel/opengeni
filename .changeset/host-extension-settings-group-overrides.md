---
"@opengeni/react": minor
---

Host extension nav overrides can move a native entry into one of the extension's settings groups: `HostExtensionNavOverride.settingsGroup` (validated against `settingsGroups`, exclusive with `group`, not for the inbox) lists the entry first in that group of the settings rail under its label and removes it from its native place. `insights` is now a `NativeNavId`, so a host can relabel the workspace Insights page, hide it (`group: "hidden"`) or move it into a settings group, where it keeps its `workspace:admin` gate. New pure helpers `nativeEntriesInSettingsGroup` and `nativeNavOverride` (`@opengeni/react/app/host-extension`). Without overrides the console is unchanged.
