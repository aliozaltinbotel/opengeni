---
"@opengeni/react": minor
---

A web console host extension can now load its tool cards on demand with `toolRegistryLoader`, so a long list of card names no longer has to sit in the console's startup bundle. The console calls the loader at most once, the first time a chat shows a tool call it has no card for, and checks each loaded entry with the same rules as `toolRegistryEntries`: an entry that names a built-in card, repeats a name or allows prefixed leaf matching is dropped, with one warning (`HOST_TOOL_REGISTRY_ENTRY_REFUSED`) that lists only the refused fields. Until the loader settles, such a call shows the generic tool card, never another card first; open chats then redraw with the loaded cards. A loader that rejects leaves the generic card for the rest of the page, warns once (`HOST_TOOL_REGISTRY_LOADER_FAILED`) and is not called again. `AppHost` has the matching `toolRegistryLoader` field. Without a loader nothing changes.
