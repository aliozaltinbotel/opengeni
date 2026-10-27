---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Managed deployments can ask a signed-in person to confirm it's them again. `POST /v1/auth/reauthenticate` takes their password (or a social sign-in they finished in the last five minutes) and, when they set one up, a code from their authenticator app; it records a fresh authentication on the session without signing in again, and the host session token's `auth_time` and `amr` follow it (`amr` adds `otp` when the code was checked). A refreshed session never moves `auth_time`. With `OPENGENI_MANAGED_AUTH_TOTP_ENABLED=true` people can set up an authenticator app under Personal settings > Security, and the client config gains `managedAuthTotp: { enabled: true }`. The web app adds `/reauthenticate?return=<path>`, which returns only to a path on the same site.
