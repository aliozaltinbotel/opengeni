---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

A person who belongs to a host-governed organization no longer creates organizations of their own unless the host allows it: `POST /v1/organizations`, `POST /v1/organizations/additional` and the self-service `POST /v1/auth/organization-onboarding` ask the governance port's `decide` for the new governed mutation `organization.create` (`via: "native"`) for every governed organization the person belongs to (revoked memberships excluded), and a refusal answers `403` with `details.code = "ORGANIZATION_CREATE_GOVERNED"` before anything is written. With the new port field `organizationCreation: "host"`, organizations are the host's to create: the same routes refuse every managed human with no governed membership whose host allows it, a freshly signed-up identity included. A host that does not recognize the new mutation refuses it, as the port contract requires. New exports: `ORGANIZATION_CREATE_GOVERNED` (`@opengeni/contracts/organization-governance`), `OrganizationCreateGovernedError` and `requireOrganizationCreateAllowed` (`@opengeni/core`). Without the field, people without a governed membership are unchanged, and so are deployments without a port.
