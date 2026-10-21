---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Allow hosts to condition a Goal status transition on its observed identity, version and pause owner. Refuse stale transitions before admission or wake, and preserve an explicit operator takeover of an agent pause.
