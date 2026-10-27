---
"@opengeni/config": minor
"@opengeni/core": minor
---

`OPENGENI_PRODUCT_NAME` (default `Opengeni`) names the product in the managed auth emails (email verification, password reset, organization invitation and sign-in-method changed) and in the authenticator-app issuer; the sender stays `OPENGENI_EMAIL_FROM`. Unset, every email is unchanged. An organization that a bound `organizationGovernance` port governs has Personal workspaces turned off when the fork first sees it governed (native creation, or before a host command), so its members land in the business workspace, and its owners cannot turn them back on natively (`403 ORGANIZATION_GOVERNED_BY_HOST`). Ungoverned organizations, and deployments without the port, are unchanged.
