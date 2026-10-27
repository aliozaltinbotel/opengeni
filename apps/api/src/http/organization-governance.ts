import {
  ORGANIZATION_GOVERNED_BY_HOST,
  type GovernedMutation,
  type GovernedMutationChannel,
  type OrganizationGovernancePort,
} from "@opengeni/contracts/organization-governance";
import type { ApiRouteDeps } from "@opengeni/core";
import { getManagedAccount, getWorkspace, withAccountRls, type Database } from "@opengeni/db";
import { ApiHttpError } from "./api-error";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type GovernanceDeps = Pick<ApiRouteDeps, "db" | "organizationGovernance">;

export type OrganizationGovernanceDecision = "ungoverned" | "allow" | "refuse";

/**
 * The host's decision for one mutation in one organization. Without a bound
 * port every organization is ungoverned. A port that throws fails the request.
 */
export async function organizationGovernanceDecision(
  deps: GovernanceDeps,
  input: { organizationId: string; mutation: GovernedMutation; via: GovernedMutationChannel },
): Promise<OrganizationGovernanceDecision> {
  const port = deps.organizationGovernance;
  if (!port) return "ungoverned";
  const externalSource = await organizationExternalSource(deps.db, input.organizationId);
  if (!governs(port, input.organizationId, externalSource)) return "ungoverned";
  return port.decide(input) === "allow" ? "allow" : "refuse";
}

/**
 * Called by every native membership, role and credential mutation route after
 * it has authenticated the caller and before it changes anything.
 */
export async function requireNativeOrganizationMutation(
  deps: GovernanceDeps,
  organizationId: string,
  mutation: GovernedMutation,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  const decision = await organizationGovernanceDecision(deps, {
    organizationId,
    mutation,
    via: "native",
  });
  if (decision === "refuse") throw organizationGovernedByHostError(mutation);
}

/** The workspace-addressed form: the workspace's organization decides. */
export async function requireNativeWorkspaceMutation(
  deps: GovernanceDeps,
  workspaceId: string,
  mutation: GovernedMutation,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  const workspace = await getWorkspace(deps.db, workspaceId).catch(() => null);
  // An unknown workspace keeps the route's own not-found answer.
  if (!workspace) return;
  await requireNativeOrganizationMutation(deps, workspace.accountId, mutation);
}

export function organizationGovernedByHostError(mutation: GovernedMutation): ApiHttpError {
  return new ApiHttpError(403, {
    code: "forbidden",
    message: "This organization's members and credentials are managed by its host application.",
    retryable: false,
    outcomeUnknown: false,
    details: { code: ORGANIZATION_GOVERNED_BY_HOST, mutation },
  });
}

function governs(
  port: OrganizationGovernancePort,
  organizationId: string,
  externalSource: string | null,
): boolean {
  return port.governs({ organizationId, externalSource }) === true;
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
