---
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
---

An embedding host's tool server can publish its tool-set version (`LocalMcpServerRegistration.toolSetVersion`). An MCP OAuth consent records each used host server's version (migration 1022 adds the nullable `tool_set_versions` to the four MCP OAuth grant tables), and the workspace MCP's `tools/list` result carries `_meta["opengeni/toolSets"]` with each server's current `version` and, on an MCP OAuth connection, the `consentedVersion` (null for an older consent), so a client can prompt the person to consent again when they differ. Without a published version nothing changes.

The new column's checks are added `NOT VALID`, so adding them scans no rows; migration 1024 (rolling) validates them under `SHARE UPDATE EXCLUSIVE`.
