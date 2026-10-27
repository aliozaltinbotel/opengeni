---
"@opengeni/config": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

A managed deployment that embeds Opengeni in a host product can let the host verify a signed-in person locally. Set `OPENGENI_HOST_TOKEN_AUDIENCE` (and optionally `OPENGENI_HOST_TOKEN_TTL_SECONDS`, 60 to 900, default 300) and `GET /v1/auth/host-token?workspace=<id>` returns a short-lived ES256 JWT for that workspace, minted only for the signed-in browser session of an active identity that belongs to the workspace's organization. Its claims are `iss` (the public origin), `aud`, `sub` (the canonical identity), `sid`, `org`, `ws`, `auth_time`, `amr`, `identity_status`, `iat`, `exp` and `jti`. `GET /v1/auth/jwks` publishes the public keys (cached in process and by verifiers for 300 seconds), and one session may mint 30 tokens a minute (`429 HOST_TOKEN_RATE_LIMITED`). Better Auth's own `/v1/auth/token` stays closed. The keys live in the new `auth_jwks` table (migration 1013), encrypted with `OPENGENI_BETTER_AUTH_SECRET`: after rotating that secret, clear `auth_jwks`. Without an audience nothing is signed and `/v1/auth/jwks` is not served.
