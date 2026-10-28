---
"@opengeni/runtime": minor
"@opengeni/core": patch
"@opengeni/api-router": patch
---

A `workspaceToolServers` host server whose connect or `tools/list` fails no longer fails the whole workspace tool catalog: its tools are left out and the preparation records it in `unavailableMcpServers`, the same as a failed connector. A call to one of its tools is refused like any tool not in the catalog (`tool_not_found`), and a listed host tool whose call fails still fails loud. New optional `LocalMcpServerRegistration.listingBestEffort`, which the workspace tool gateway sets on host registrations; every other registration is unchanged.
