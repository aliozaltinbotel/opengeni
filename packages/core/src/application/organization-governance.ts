import {
  ORGANIZATION_GOVERNED_BY_HOST,
  type GovernedMutation,
  type GovernedMutationChannel,
  type OrganizationGovernancePort,
} from "@opengeni/contracts/organization-governance";
import { getManagedAccount, withAccountRls, type Database } from "@opengeni/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type OrganizationGovernanceDeps = {
  db: Database;
  organizationGovernance?: OrganizationGovernancePort | null;
};

export type OrganizationGovernanceDecision = "ungoverned" | "allow" | "refuse";

/**
 * The host's decision for one mutation in one organization. Without a bound
 * port every organization is ungoverned and nothing is read. A port that
 * throws, and a failed organization lookup, fail the caller (closed).
 */
export async function organizationGovernanceDecision(
  deps: OrganizationGovernanceDeps,
  input: { organizationId: string; mutation: GovernedMutation; via: GovernedMutationChannel },
): Promise<OrganizationGovernanceDecision> {
  const port = deps.organizationGovernance;
  if (!port) return "ungoverned";
  const externalSource = await organizationExternalSource(deps.db, input.organizationId);
  if (port.governs({ organizationId: input.organizationId, externalSource }) !== true)
    return "ungoverned";
  return port.decide(input) === "allow" ? "allow" : "refuse";
}

/** Raised where a governed organization's host refuses a mutation. */
export class OrganizationGovernedByHostError extends Error {
  readonly name = "OrganizationGovernedByHostError";
  readonly code = ORGANIZATION_GOVERNED_BY_HOST;
  constructor(readonly mutation: GovernedMutation) {
    super("This organization's members and credentials are managed by its host application.");
  }
}

/** Refuses `mutation` through `via: "native"` when a governing host refuses it. */
export async function requireNativeOrganizationMutationAllowed(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
  mutation: GovernedMutation,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  const decision = await organizationGovernanceDecision(deps, {
    organizationId,
    mutation,
    via: "native",
  });
  if (decision === "refuse") throw new OrganizationGovernedByHostError(mutation);
}

async function organizationExternalSource(
  db: Database,
  organizationId: string,
): Promise<string | null> {
  if (!UUID.test(organizationId)) return null;
  const account = await withAccountRls(db, organizationId, (scopedDb) =>
    getManagedAccount(scopedDb, organizationId),
  );
  return account?.externalSource ?? null;
}
