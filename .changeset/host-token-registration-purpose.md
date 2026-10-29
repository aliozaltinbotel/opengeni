---
"@opengeni/api-router": minor
---

`GET /v1/auth/host-token?purpose=registration` mints a registration-purpose host session token for a signed-in managed person who may have no workspace: no `org` or `ws` (the keys are absent), `purpose: "registration"`, the verified `email` with `email_verified: true` and the `login_binding_*` claims. It shares the per-session mint limit with workspace tokens, refuses an unverified email (`403 HOST_TOKEN_EMAIL_NOT_VERIFIED`) and a `purpose` other than `registration` or together with `workspace` (`400 HOST_TOKEN_PURPOSE_INVALID`). Opengeni accepts no host session token as a credential. New export `getVerifiedAuthUserEmail` (`@opengeni/db/canonical-human-identities`).
