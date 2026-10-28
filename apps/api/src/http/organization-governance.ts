import {
  GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE,
  ORGANIZATION_CREATE_GOVERNED,
  ORGANIZATION_GOVERNED_BY_HOST,
  type GovernedMutation,
} from "@opengeni/contracts/organization-governance";
import {
  GovernedMemberRequiresSharedWorkspaceError,
  OrganizationCreateGovernedError,
  requireOrganizationCreateAllowed,
  OrganizationGovernedByHostError,
  PersonalWorkspacesGovernedByHostError,
  requireAccessContext,
  requireNativeOrganizationMutationAllowed,
  organizationGovernedByHost,
  requireGovernedInvitationSharedWorkspace,
  requireGovernedReactivationSharedWorkspace,
  requirePersonalWorkspacesSettingAllowed,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getWorkspace, LastSharedWorkspaceRemovalError } from "@opengeni/db";
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

/**
 * A governed organization keeps Personal workspaces off: turning them on
 * answers 403 ORGANIZATION_GOVERNED_BY_HOST with `setting: "personalWorkspaces"`.
 */
export async function requirePersonalWorkspacesSetting(
  deps: GovernanceDeps,
  organizationId: string,
  personalWorkspaces: boolean | undefined,
): Promise<void> {
  try {
    await requirePersonalWorkspacesSettingAllowed(deps, { organizationId, personalWorkspaces });
  } catch (error) {
    if (!(error instanceof PersonalWorkspacesGovernedByHostError)) throw error;
    throw new ApiHttpError(403, {
      code: "forbidden",
      message: error.message,
      retryable: false,
      outcomeUnknown: false,
      details: { code: ORGANIZATION_GOVERNED_BY_HOST, setting: "personalWorkspaces" },
    });
  }
}

/**
 * A governed organization's invitation names a shared workspace: `422
 * GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE` otherwise.
 */
export async function requireGovernedInvitationWorkspace(
  deps: GovernanceDeps,
  organizationId: string,
  initialWorkspaceIds: readonly string[],
): Promise<void> {
  await withSharedWorkspaceRefusal(() =>
    requireGovernedInvitationSharedWorkspace(deps, { organizationId, initialWorkspaceIds }),
  );
}

/**
 * Reactivating a governed organization's member re-grants a shared workspace:
 * `422 GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE` otherwise.
 */
export async function requireGovernedReactivationWorkspaces(
  deps: GovernanceDeps,
  organizationId: string,
  workspaceIds: readonly string[] | undefined,
): Promise<void> {
  await withSharedWorkspaceRefusal(() =>
    requireGovernedReactivationSharedWorkspace(deps, { organizationId, workspaceIds }),
  );
}

/**
 * Whether a removal must leave the member a shared workspace: true in a
 * governed organization. The removal command checks it under its own lock.
 */
export async function removalRequiresRemainingSharedWorkspace(
  deps: GovernanceDeps,
  organizationId: string,
): Promise<boolean> {
  return await organizationGovernedByHost(deps, organizationId);
}

/** The `409 GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE` for a refused removal, else null. */
export function lastSharedWorkspaceRemovalHttpError(error: unknown): ApiHttpError | null {
  if (!(error instanceof LastSharedWorkspaceRemovalError)) return null;
  return sharedWorkspaceRefusal(new GovernedMemberRequiresSharedWorkspaceError("removal"));
}

async function withSharedWorkspaceRefusal(check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (!(error instanceof GovernedMemberRequiresSharedWorkspaceError)) throw error;
    throw sharedWorkspaceRefusal(error);
  }
}

/** A request that would leave no shared workspace is 422; a removal that would is 409. */
function sharedWorkspaceRefusal(error: GovernedMemberRequiresSharedWorkspaceError): ApiHttpError {
  const removal = error.operation === "removal";
  return new ApiHttpError(removal ? 409 : 422, {
    code: removal ? "conflict" : "validation_failed",
    message: error.message,
    retryable: false,
    outcomeUnknown: false,
    details: { code: GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE },
  });
}

/**
 * Refuses `POST /v1/organizations` and `/v1/organizations/additional` for a
 * person who belongs to a governed organization whose host does not allow
 * `organization.create`: 403 ORGANIZATION_CREATE_GOVERNED.
 */
export async function requireOrganizationCreate(
  deps: GovernanceDeps,
  subjectId: string,
): Promise<void> {
  try {
    await requireOrganizationCreateAllowed(deps, subjectId);
  } catch (error) {
    if (error instanceof OrganizationCreateGovernedError)
      throw new ApiHttpError(403, {
        code: "forbidden",
        message: error.message,
        retryable: false,
        outcomeUnknown: false,
        details: { code: ORGANIZATION_CREATE_GOVERNED },
      });
    throw error;
  }
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
