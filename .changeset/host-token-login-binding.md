---
"@opengeni/api-router": minor
---

Host session tokens name the identity's active login binding: two new top-level claims, `login_binding_id` and `login_binding_revision`, carry the same pair the host identity lookup answers as `activeLoginBinding`, read at mint time. `login_binding_id` changes when another sign-in method becomes the active binding, and `login_binding_revision` increases when that binding's own state changes, so a host can detect a rebound sign-in locally. A signed-in identity with no active binding is refused with `403 HOST_TOKEN_LOGIN_BINDING_UNKNOWN`. New export `activeCanonicalHumanLoginBinding` (`@opengeni/db/canonical-human-identities`).
