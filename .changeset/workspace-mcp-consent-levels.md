---
"@opengeni/db": minor
"@opengeni/api-router": minor
---

The workspace MCP OAuth consent page offers an access level, as the organization sign-in does: Full (the default, and the behaviour of a form without the field), Read only, or Custom (chosen permissions). The form posts `access_preset` and, for Custom, `permission` values. The level narrows the grant's permissions to what the person holds and the level allows (`workspace:read` always kept), freezes only the tools the narrowed grant lists (under a read-only level only tools declaring `readOnlyHint: true`), and is recorded on the grant: migration 1021 adds the nullable `consent_preset` to the four MCP OAuth grant tables, and a workspace connection's host consent scope now names its `preset` (null for older consents). An unknown level is refused before a code is issued.

The new column's checks are added `NOT VALID`, so adding them scans no rows; migration 1024 (rolling) validates them under `SHARE UPDATE EXCLUSIVE`.
