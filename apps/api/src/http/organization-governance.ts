import {
  ORGANIZATION_GOVERNED_BY_HOST,
  type GovernedMutation,
} from "@opengeni/contracts/organization-governance";
import {
  OrganizationGovernedByHostError,
  requireAccessContext,
  requireNativeOrganizationMutationAllowed,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getWorkspace } from "@opengeni/db";
import type { Context } from "hono";
import { ApiHttpError } from "./api-error";

export { organizationGovernanceDecision } from "@opengeni/core";

type GovernanceDeps = Pick<ApiRouteDeps, "db" | "organizationGovernance">;

/**
 * Called by every native membership, role and credential mutation route after
 * it has authenticated the caller and before it changes anything.
 */
export async function requireNativeOrganizationMutation(
  deps: GovernanceDeps,
  organizationId: string,
  mutation: GovernedMutation,
): Promise<void> {
  try {
    await requireNativeOrganizationMutationAllowed(deps, organizationId, mutation);
  } catch (error) {
    if (error instanceof OrganizationGovernedByHostError)
      throw organizationGovernedByHostError(error.mutation);
    throw error;
  }
}

/** The workspace-addressed form: the workspace's organization decides. */
export async function requireNativeWorkspaceMutation(
  deps: GovernanceDeps,
  workspaceId: string,
  mutation: GovernedMutation,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  // A lookup failure propagates (fail closed); only a missing workspace keeps
  // the route's own not-found answer.
  const workspace = await getWorkspace(deps.db, workspaceId);
  if (!workspace) return;
  await requireNativeOrganizationMutation(deps, workspace.accountId, mutation);
}

/**
 * For routes whose handler authenticates only after reading the body: with a
 * bound port the caller is authenticated before the host is asked; without
 * one nothing runs, so the stock status order is unchanged.
 */
export async function requireNativeOrganizationMutationForRequest(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
  mutation: GovernedMutation,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  await requireAccessContext(context, deps);
  await requireNativeOrganizationMutation(deps, organizationId, mutation);
}

/** The workspace-addressed form of `requireNativeOrganizationMutationForRequest`. */
export async function requireNativeWorkspaceMutationForRequest(
  context: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  mutation: GovernedMutation,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  await requireAccessContext(context, deps);
  await requireNativeWorkspaceMutation(deps, workspaceId, mutation);
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
