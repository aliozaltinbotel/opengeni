---
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Preserve Cendra's source receipts and current dispatch authorization when synchronizing the native runtime with upstream. Keep parallel tool receipts atomic with their timeline events, await required title accounting across cancellation and provider failures, retain distinct compaction calls, and normalize realtime credential expiry before issuing the native relay grant.
