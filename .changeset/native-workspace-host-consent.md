---
"@opengeni/api-router": minor
"@opengeni/core": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
---

Add an optional human-authenticated embedding-host handoff to the existing native workspace OAuth consent form. Protected HOST proposal read/admit commands bind admission and existing attribution atomically on the pending request, and explicit native approval consumes the exact current admission once. Changed displayed material requires fresh approval; callback responses issue no credentials. Ungoverned consent and the governed organization-wide refusal are preserved.

The production backport appends `1028_mcp_oauth_host_consent.sql` after the published session-admission migration `1027`. Its SQL bytes match the candidate implementation's `1026` expansion; published predecessor migrations remain unchanged. Real database upgrade qualification from the installed production schema is required before activation.
