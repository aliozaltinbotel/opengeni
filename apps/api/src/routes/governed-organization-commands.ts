import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import {
  OrganizationInvitation,
  OrganizationMember,
  OrganizationWorkspaceAccessMember,
  RevokeOrganizationWorkspaceMemberResponse,
  UpdateOrganizationMemberRequest,
  verifyDelegatedAccessToken,
} from "@opengeni/contracts";
import {
  HOST_COMMAND_ACTOR_NOT_AUTHORIZED,
  HOST_COMMAND_OPERATION_CONFLICT,
  HOST_COMMAND_PERMISSION_REQUIRED,
  HOST_COMMAND_SERVICE_TOKEN_REQUIRED,
  HOST_IDENTITY_NOT_IN_ORGANIZATION,
  HOST_INVITATION_NOT_IN_ORGANIZATION,
  HOST_INVITATION_NOT_PENDING,
  HOST_INVITATION_REVISION_CONFLICT,
  HOST_MCP_CONNECTION_NOT_IN_ORGANIZATION,
  HOST_MEMBER_NOT_IN_ORGANIZATION,
  HOST_ORGANIZATION_OWNER_CONFLICT,
  HOST_ORGANIZATION_OWNER_ENSURE,
  HOST_ORGANIZATION_OWNER_UNAVAILABLE,
  HostChangeOrganizationMemberRoleRequest,
  HostEnsureOrganizationOwnerRequest,
  HostInviteOrganizationMemberRequest,
  HostLookupOrganizationIdentityRequest,
  HostOrganizationIdentity,
  HostOrganizationInvitation,
  HostOrganizationMcpConnection,
  HostOrganizationMember,
  HostOrganizationMemberLifecycleRequest,
  HostOrganizationOwner,
  HostReactivateOrganizationMemberRequest,
  HostRevokeOrganizationInvitationRequest,
  HostRevokeOrganizationWorkspaceMemberRequest,
  HostSetOrganizationWorkspaceMemberRequest,
  ORGANIZATION_NOT_HOST_GOVERNED,
  type ActingExternalUser,
  type GovernedMutation,
} from "@opengeni/contracts/organization-governance";
import {
  HOST_SESSION_POLICY_UNAVAILABLE,
  HostPutOrganizationSessionPolicyRequest,
  HostPutOrganizationSessionPolicyResponse,
  OrganizationSessionPolicyView,
  SESSION_POLICY_OPERATION_CONFLICT,
  SESSION_POLICY_REVISION_CONFLICT,
} from "@opengeni/contracts/organization-session-policy";
import {
  applyGovernedOrganizationPolicy,
  hasPermission,
  organizationGovernedByHost,
  readOrganizationSessionPolicy,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createOrganizationInvitation,
  ensureOrganizationHostOwner,
  getOrganizationInvitationForAdministration,
  getWorkspace,
  hostOrganizationOwnerGranted,
  hostSessionPolicyWriteGranted,
  lookupOrganizationHostIdentity,
  nestedPostgresSqlState,
  putHostOrganizationSessionPolicy,
  putOrganizationWorkspaceMember,
  readOrganizationHostMember,
  SessionPolicyOperationConflictError,
  SessionPolicyRevisionConflictError,
  recordOrganizationHostCommandAttribution,
  revokeOrganizationInvitation,
  revokeOrganizationWorkspaceMember,
  updateOrganizationMember,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { assertOrganizationUserSetupDeliveryConfigured } from "../auth/organization-user-setup";
import { ApiHttpError } from "../http/api-error";
import { readHostMcpConnection } from "../http/host-mcp-connection";
import {
  lastSharedWorkspaceRemovalHttpError,
  organizationGovernanceDecision,
  organizationGovernedByHostError,
  requireGovernedInvitationWorkspace,
  requireGovernedReactivationWorkspaces,
} from "../http/organization-governance";
import { readRequestJson } from "../http/request-body";
import {
  deliverOrganizationUserSetup,
  memberTransitionMutation,
  rethrowMembershipError,
} from "./organization-memberships";

const Uuid = z.string().uuid();
const SERVICE_TOKEN_PREFIX = "ogd2_";
/** The 409 message when the identity lookup's member-list fallback is past its bound (54000). */
const HOST_IDENTITY_LOOKUP_RESOURCE_LIMIT =
  "organization access inventory exceeds the identity lookup's member-list bound";
/** The 409 message when the member read's administration overview is past its bound (54000). */
const HOST_MEMBER_READ_RESOURCE_LIMIT =
  "organization access inventory exceeds the member read's overview bound";
/** The 409 message when the connection read's administration overview is past its bound (54000). */
const HOST_MCP_CONNECTION_READ_RESOURCE_LIMIT =
  "organization access inventory exceeds the MCP connection read's overview bound";

/** What a verified host command runs as. */
type HostCommandAuthority = {
  organizationId: string;
  /** The service token's subject: the database actor, checked like any administrator. */
  actorSubjectId: string;
  serviceInitiatorSubjectId: string;
};

/**
 * Host commands for organizations an embedding host governs, the host's
 * identity lookup, its invitation, member and MCP connection reads, and the ensure of the host's own owner
 * membership. Each membership command runs the
 * same membership, invitation or workspace-access operation as the native
 * route, so its receipt and lifecycle event are the native ones; the acting
 * external user is recorded next to them under the same operation id.
 *
 * Authentication is a service delegated token (`ogd2_`, signed with the
 * deployment's delegation secret) for the addressed organization. Registered
 * only when the host binds `organizationGovernance`.
 */
export function registerGovernedOrganizationCommandRoutes(app: Hono, deps: ApiRouteDeps): void {
  if (!deps.organizationGovernance) return;
  const base = "/v1/host/organizations/:organizationId";

  app.post(`${base}/invitations`, async (context) => {
    const authority = await requireHostCommand(context, deps, "invitation.create");
    const { actingExternalUser, command } = await parseCommand(
      context,
      HostInviteOrganizationMemberRequest,
    );
    await requireGovernedInvitationWorkspace(
      deps,
      authority.organizationId,
      command.initialWorkspaceIds,
    );
    try {
      assertOrganizationUserSetupDeliveryConfigured(deps.settings, deps.managedEmailTransport);
    } catch {
      throw new HTTPException(503, {
        message: "invited-user account setup delivery is not configured on this deployment",
      });
    }
    await recordAttribution(deps, authority, {
      mutation: "invitation.create",
      operationId: command.operationId,
      actingExternalUser,
    });
    try {
      const invitation = OrganizationInvitation.parse(
        await createOrganizationInvitation(deps.db, {
          organizationId: authority.organizationId,
          actorSubjectId: authority.actorSubjectId,
          operationId: command.operationId,
          targetSubjectId: null,
          targetEmail: command.email.trim().toLowerCase(),
          ...(command.name === undefined ? {} : { targetName: command.name }),
          initialWorkspaceIds: command.initialWorkspaceIds,
          role: command.role,
          expiresAt: command.expiresAt,
        }),
      );
      await deliverOrganizationUserSetup(deps, {
        organizationId: authority.organizationId,
        actorSubjectId: authority.actorSubjectId,
        invitationId: invitation.id,
        invitationOperationId: command.operationId,
        operationId: command.operationId,
      });
      return context.json(
        OrganizationInvitation.parse(
          await getOrganizationInvitationForAdministration(deps.db, {
            organizationId: authority.organizationId,
            actorSubjectId: authority.actorSubjectId,
            invitationId: invitation.id,
          }),
        ),
        201,
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      rethrowHostMembershipError(error);
    }
  });

  app.post(`${base}/invitations/:invitationId/revoke`, async (context) => {
    const authority = await requireHostCommand(context, deps, "invitation.revoke");
    const invitationId = parsePathId(context, "invitationId");
    const { actingExternalUser, command } = await parseCommand(
      context,
      HostRevokeOrganizationInvitationRequest,
    );
    await recordAttribution(deps, authority, {
      mutation: "invitation.revoke",
      operationId: command.operationId,
      actingExternalUser,
    });
    try {
      return context.json(
        OrganizationInvitation.parse(
          await revokeOrganizationInvitation(deps.db, {
            organizationId: authority.organizationId,
            actorSubjectId: authority.actorSubjectId,
            operationId: command.operationId,
            invitationId,
            expectedRevision: command.expectedRevision,
          }),
        ),
      );
    } catch (error) {
      const refusal = await invitationRevokeRefusal(
        deps,
        authority,
        { invitationId, expectedRevision: command.expectedRevision },
        error,
      );
      if (refusal) throw refusal;
      rethrowHostMembershipError(error);
    }
  });

  // A read: no governed mutation to decide and no attribution to record.
  app.get(`${base}/invitations/:invitationId`, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await requireHostService(context, deps);
    if (!(await organizationGovernedByHost(deps, authority.organizationId)))
      throw organizationNotHostGoverned();
    const invitation = await readHostInvitation(
      deps,
      authority,
      parsePathId(context, "invitationId"),
    );
    // An invitation elsewhere and an unknown one get this same answer.
    if (!invitation)
      throw new ApiHttpError(404, {
        code: "not_found",
        message: "This invitation is not in this organization.",
        retryable: false,
        outcomeUnknown: false,
        details: { code: HOST_INVITATION_NOT_IN_ORGANIZATION },
      });
    return context.json(invitation);
  });

  // A read: no governed mutation to decide and no attribution to record.
  app.get(`${base}/members/:membershipId`, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await requireHostService(context, deps);
    if (!(await organizationGovernedByHost(deps, authority.organizationId)))
      throw organizationNotHostGoverned();
    const membershipId = parsePathId(context, "membershipId");
    let member: HostOrganizationMember | null;
    try {
      member = await readOrganizationHostMember(deps.db, {
        organizationId: authority.organizationId,
        actorSubjectId: authority.actorSubjectId,
        membershipId,
      });
    } catch (error) {
      // The shared-workspace access reads the bounded administration overview.
      rethrowHostMembershipError(error, HOST_MEMBER_READ_RESOURCE_LIMIT);
    }
    // A membership elsewhere and an unknown one get this same answer.
    if (!member)
      throw new ApiHttpError(404, {
        code: "not_found",
        message: "This membership is not in this organization.",
        retryable: false,
        outcomeUnknown: false,
        details: { code: HOST_MEMBER_NOT_IN_ORGANIZATION },
      });
    return context.json(HostOrganizationMember.parse(member));
  });

  // A read: no governed mutation to decide and no attribution to record.
  // An organization connection that consented `account:read` (every preset
  // does) stays live for as long as its person is an active member, since
  // every active membership holds `account:read`: it practically never
  // reaches `permissions_lost`; only a custom setting without it can.
  app.get(`${base}/mcp-connections/:connectionId`, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await requireHostService(context, deps);
    if (!(await organizationGovernedByHost(deps, authority.organizationId)))
      throw organizationNotHostGoverned();
    const connectionId = parsePathId(context, "connectionId");
    let connection: HostOrganizationMcpConnection | null;
    try {
      connection = await readHostMcpConnection(deps, {
        organizationId: authority.organizationId,
        actorSubjectId: authority.actorSubjectId,
        connectionId,
      });
    } catch (error) {
      // An organization connection's access reads the bounded overview.
      rethrowHostMembershipError(error, HOST_MCP_CONNECTION_READ_RESOURCE_LIMIT);
    }
    // A connection elsewhere and an unknown one get this same answer.
    if (!connection)
      throw new ApiHttpError(404, {
        code: "not_found",
        message: "This MCP connection is not in this organization.",
        retryable: false,
        outcomeUnknown: false,
        details: { code: HOST_MCP_CONNECTION_NOT_IN_ORGANIZATION },
      });
    return context.json(HostOrganizationMcpConnection.parse(connection));
  });

  app.post(`${base}/members/:membershipId/change-role`, async (context) => {
    const authority = await requireHostCommand(context, deps, "membership.role.change");
    const membershipId = parsePathId(context, "membershipId");
    const { actingExternalUser, command } = await parseCommand(
      context,
      HostChangeOrganizationMemberRoleRequest,
    );
    return context.json(
      await transitionMember(deps, authority, membershipId, actingExternalUser, {
        kind: "change_role",
        ...command,
      }),
    );
  });

  app.post(`${base}/members/:membershipId/reactivate`, async (context) => {
    const authority = await requireHostCommand(context, deps, "membership.reactivate");
    const membershipId = parsePathId(context, "membershipId");
    const {
      actingExternalUser,
      command: { workspaceIds, ...command },
    } = await parseCommand(context, HostReactivateOrganizationMemberRequest);
    await requireGovernedReactivationWorkspaces(deps, authority.organizationId, workspaceIds);
    return context.json(
      await transitionMember(
        deps,
        authority,
        membershipId,
        actingExternalUser,
        { kind: "reactivate", ...command },
        workspaceIds,
      ),
    );
  });

  for (const kind of ["suspend", "offboard"] as const) {
    app.post(`${base}/members/:membershipId/${kind}`, async (context) => {
      const authority = await requireHostCommand(context, deps, memberTransitionMutation[kind]);
      const membershipId = parsePathId(context, "membershipId");
      const { actingExternalUser, command } = await parseCommand(
        context,
        HostOrganizationMemberLifecycleRequest,
      );
      return context.json(
        await transitionMember(deps, authority, membershipId, actingExternalUser, {
          kind,
          ...command,
        }),
      );
    });
  }

  app.put(`${base}/workspaces/:workspaceId/members/:membershipId`, async (context) => {
    const authority = await requireHostCommand(context, deps, "workspace_member.update");
    const workspaceId = parsePathId(context, "workspaceId");
    const membershipId = parsePathId(context, "membershipId");
    const { actingExternalUser, command } = await parseCommand(
      context,
      HostSetOrganizationWorkspaceMemberRequest,
    );
    await recordAttribution(deps, authority, {
      mutation: "workspace_member.update",
      operationId: command.operationId,
      actingExternalUser,
    });
    try {
      return context.json(
        OrganizationWorkspaceAccessMember.parse(
          await putOrganizationWorkspaceMember(deps.db, {
            organizationId: authority.organizationId,
            workspaceId,
            actorSubjectId: authority.actorSubjectId,
            targetOrganizationMembershipId: membershipId,
            access: command,
          }),
        ),
      );
    } catch (error) {
      rethrowHostMembershipError(error);
    }
  });

  app.delete(`${base}/workspaces/:workspaceId/members/:membershipId`, async (context) => {
    const authority = await requireHostCommand(context, deps, "workspace_member.remove");
    const workspaceId = parsePathId(context, "workspaceId");
    const membershipId = parsePathId(context, "membershipId");
    const { actingExternalUser, command } = await parseCommand(
      context,
      HostRevokeOrganizationWorkspaceMemberRequest,
    );
    await recordAttribution(deps, authority, {
      mutation: "workspace_member.remove",
      operationId: command.operationId,
      actingExternalUser,
    });
    try {
      return context.json(
        RevokeOrganizationWorkspaceMemberResponse.parse(
          await revokeOrganizationWorkspaceMember(deps.db, {
            organizationId: authority.organizationId,
            workspaceId,
            actorSubjectId: authority.actorSubjectId,
            targetOrganizationMembershipId: membershipId,
            expectedUpdatedAt: command.expectedUpdatedAt,
            operationId: command.operationId,
            // A host command's organization is governed: its members keep one.
            requireRemainingSharedWorkspace: true,
          }),
        ),
      );
    } catch (error) {
      rethrowHostMembershipError(error);
    }
  });

  // The token's own subject becomes the owner of the token's own organization,
  // for an organization bootstrapped without that owner (without
  // governedOrganizationOwner, or before its routine was granted). Not a governed mutation: no native route does it, and the host is
  // the caller. Recorded like a host command, under its own attribution name.
  // Before the owner exists the subject is no administrator, so this runs on
  // requireHostService and applies the governed policy only afterwards.
  app.post(`${base}/host-owner/ensure`, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await requireHostService(context, deps);
    if (!(await organizationGovernedByHost(deps, authority.organizationId)))
      throw organizationNotHostGoverned();
    const { actingExternalUser, command } = await parseCommand(
      context,
      HostEnsureOrganizationOwnerRequest,
    );
    if (!(await hostOrganizationOwnerGranted(deps.db))) throw hostOrganizationOwnerUnavailable();
    await recordAttribution(deps, authority, {
      mutation: HOST_ORGANIZATION_OWNER_ENSURE,
      operationId: command.operationId,
      actingExternalUser,
    });
    let owner: HostOrganizationOwner | null;
    try {
      owner = await ensureOrganizationHostOwner(deps.db, {
        organizationId: authority.organizationId,
        subjectId: authority.actorSubjectId,
        operationId: command.operationId,
      });
    } catch (error) {
      if (nestedPostgresSqlState(error) === "55000")
        throw new ApiHttpError(409, {
          code: "conflict",
          message: "This subject's membership here is not an active owner; it is never promoted.",
          retryable: false,
          outcomeUnknown: false,
          details: { code: HOST_ORGANIZATION_OWNER_CONFLICT },
        });
      rethrowHostMembershipError(error);
    }
    if (!owner) throw hostOrganizationOwnerUnavailable();
    try {
      await applyGovernedOrganizationPolicy(deps, {
        organizationId: authority.organizationId,
        actorSubjectId: authority.actorSubjectId,
      });
    } catch (error) {
      rethrowHostMembershipError(error);
    }
    return context.json(HostOrganizationOwner.parse(owner));
  });

  // A read: no governed mutation to decide and no attribution to record.
  app.post(`${base}/identities/lookup`, async (context) => {
    // Every answer, refusals included, is about one person: never cached.
    context.header("cache-control", "no-store");
    const authority = await requireHostService(context, deps);
    if (!(await organizationGovernedByHost(deps, authority.organizationId)))
      throw organizationNotHostGoverned();
    const { identityId } = await parseCommand(
      context,
      HostLookupOrganizationIdentityRequest,
      "invalid host identity lookup",
    );
    let identity: HostOrganizationIdentity | null;
    try {
      identity = await lookupOrganizationHostIdentity(deps.db, {
        organizationId: authority.organizationId,
        actorSubjectId: authority.actorSubjectId,
        identityId: identityId.toLowerCase(),
      });
    } catch (error) {
      // The member-list fallback reads the administration overview, which is
      // bounded (500 shared workspaces, 1000 grants each).
      rethrowHostMembershipError(error, HOST_IDENTITY_LOOKUP_RESOURCE_LIMIT);
    }
    // An identity elsewhere and an unknown one get this same answer.
    if (!identity)
      throw new ApiHttpError(404, {
        code: "not_found",
        message: "This identity is not in this organization.",
        retryable: false,
        outcomeUnknown: false,
        details: { code: HOST_IDENTITY_NOT_IN_ORGANIZATION },
      });
    return context.json(HostOrganizationIdentity.parse(identity));
  });

  // The organization's session policy: attachments and generic tool families
  // for every session in its workspaces. No native route writes it.
  // A read: no governed mutation to decide, no attribution, no stored default.
  app.get(`${base}/session-policy`, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await requireHostService(context, deps);
    if (!(await organizationGovernedByHost(deps, authority.organizationId)))
      throw organizationNotHostGoverned();
    return context.json(
      OrganizationSessionPolicyView.parse(
        await readOrganizationSessionPolicy(deps, authority.organizationId),
      ),
    );
  });

  app.put(`${base}/session-policy`, async (context) => {
    context.header("cache-control", "no-store");
    const authority = await requireHostCommand(context, deps, "session_policy.update");
    const { actingExternalUser, command } = await parseCommand(
      context,
      HostPutOrganizationSessionPolicyRequest,
    );
    // Before anything is recorded, as the owner ensure does: an unavailable
    // command leaves its operation id unused.
    if (!(await hostSessionPolicyWriteGranted(deps.db))) throw hostSessionPolicyUnavailable();
    await recordAttribution(deps, authority, {
      mutation: "session_policy.update",
      operationId: command.operationId,
      actingExternalUser,
    });
    let written: Awaited<ReturnType<typeof putHostOrganizationSessionPolicy>>;
    try {
      written = await putHostOrganizationSessionPolicy(deps.db, {
        organizationId: authority.organizationId,
        subjectId: authority.actorSubjectId,
        operationId: command.operationId,
        policy: command.policy,
        expectedRevision: command.expectedRevision,
      });
    } catch (error) {
      if (error instanceof SessionPolicyOperationConflictError)
        throw sessionPolicyConflict(SESSION_POLICY_OPERATION_CONFLICT, error.message);
      if (error instanceof SessionPolicyRevisionConflictError)
        throw sessionPolicyConflict(SESSION_POLICY_REVISION_CONFLICT, error.message);
      rethrowHostMembershipError(error);
    }
    if (!written) throw hostSessionPolicyUnavailable();
    const { stored, replay } = written;
    return context.json(
      HostPutOrganizationSessionPolicyResponse.parse({
        organizationId: stored.organizationId,
        policy: stored.policy,
        source: stored.source,
        revision: stored.revision,
        updatedAt: stored.updatedAt.toISOString(),
        replay,
      }),
    );
  });
}

/**
 * One of the organization's invitations as the host sees it, or null when it
 * is unknown or another organization's (the same database answer for both).
 */
async function readHostInvitation(
  deps: ApiRouteDeps,
  authority: HostCommandAuthority,
  invitationId: string,
): Promise<HostOrganizationInvitation | null> {
  let invitation: OrganizationInvitation;
  try {
    invitation = await getOrganizationInvitationForAdministration(deps.db, {
      organizationId: authority.organizationId,
      actorSubjectId: authority.actorSubjectId,
      invitationId,
    });
  } catch (error) {
    if (nestedPostgresSqlState(error) === "P0002") return null;
    rethrowHostMembershipError(error);
  }
  return HostOrganizationInvitation.parse({
    id: invitation.id,
    organizationId: invitation.organizationId,
    status: invitation.status,
    revision: invitation.revision,
    acceptedMembershipId: invitation.acceptedMembershipId,
    // The accepting write is an invitation's last: only pending ones are
    // revoked or rebound. So an accepted invitation's update time is when it
    // was accepted.
    acceptedAt: invitation.status === "accepted" ? isoInstant(invitation.updatedAt) : null,
    expiresAt: isoInstant(invitation.expiresAt),
  });
}

/**
 * Why the database refused a host revoke, when it was the invitation's state:
 * the native refusal is the same 409 for a stale revision and for an
 * invitation no longer pending (the revision check runs first, and accepting
 * or revoking bumps the revision), so the invitation is read back. Null keeps
 * the native refusal: any other error, a failed read-back, or a pending
 * invitation still at the expected revision.
 */
async function invitationRevokeRefusal(
  deps: ApiRouteDeps,
  authority: HostCommandAuthority,
  revoke: { invitationId: string; expectedRevision: number },
  error: unknown,
): Promise<ApiHttpError | null> {
  const sqlState = nestedPostgresSqlState(error);
  if (sqlState !== "40001" && sqlState !== "55000") return null;
  const current = await readHostInvitation(deps, authority, revoke.invitationId).catch(() => null);
  if (!current) return null;
  if (current.status === "pending" && current.revision === revoke.expectedRevision) return null;
  const pending = current.status === "pending";
  return new ApiHttpError(409, {
    code: "conflict",
    message: pending
      ? "This invitation changed; read it back and retry at its current revision."
      : "This invitation is no longer pending.",
    retryable: false,
    outcomeUnknown: false,
    details: {
      code: pending ? HOST_INVITATION_REVISION_CONFLICT : HOST_INVITATION_NOT_PENDING,
      status: current.status,
    },
  });
}

function isoInstant(value: string): string {
  return new Date(value).toISOString();
}

async function transitionMember(
  deps: ApiRouteDeps,
  authority: HostCommandAuthority,
  membershipId: string,
  actingExternalUser: ActingExternalUser,
  input: unknown,
  reactivationWorkspaceIds?: readonly string[],
) {
  const parsed = UpdateOrganizationMemberRequest.safeParse(input);
  if (!parsed.success)
    throw new HTTPException(422, { message: "invalid organization membership request" });
  const transition = parsed.data;
  await recordAttribution(deps, authority, {
    mutation: memberTransitionMutation[transition.kind],
    operationId: transition.operationId,
    actingExternalUser,
  });
  try {
    return OrganizationMember.parse(
      await updateOrganizationMember(deps.db, {
        organizationId: authority.organizationId,
        actorSubjectId: authority.actorSubjectId,
        operationId: transition.operationId,
        membershipId,
        transition,
        ...(reactivationWorkspaceIds ? { reactivationWorkspaceIds } : {}),
      }),
    );
  } catch (error) {
    rethrowHostMembershipError(error);
  }
}

/**
 * A service token for this organization whose workspace belongs to it and
 * which may manage members, for an organization the host governs and a command
 * the host allows. Anything else is refused before the body is read.
 */
async function requireHostCommand(
  context: Context,
  deps: ApiRouteDeps,
  mutation: GovernedMutation,
): Promise<HostCommandAuthority> {
  const authority = await requireHostService(context, deps);
  const { organizationId } = authority;
  const decision = await organizationGovernanceDecision(deps, {
    organizationId,
    mutation,
    via: "host",
  });
  if (decision === "ungoverned") throw organizationNotHostGoverned();
  if (decision === "refuse") throw organizationGovernedByHostError(mutation);
  // A host provisions its organizations out of band, so its first command is
  // where the fork learns this one is governed: no Personal workspaces there.
  try {
    await applyGovernedOrganizationPolicy(deps, {
      organizationId,
      actorSubjectId: authority.actorSubjectId,
    });
  } catch (error) {
    rethrowHostMembershipError(error);
  }
  return authority;
}

/**
 * A service token for the addressed organization, for one of its workspaces,
 * that may manage members. Whether the host governs the organization is the
 * caller's check.
 */
async function requireHostService(
  context: Context,
  deps: ApiRouteDeps,
): Promise<HostCommandAuthority> {
  const organizationId = parsePathId(context, "organizationId");
  const authorization = context.req.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  const secret = resolveFirstPartyDelegationSecret(deps.settings);
  const payload =
    token?.startsWith(SERVICE_TOKEN_PREFIX) && secret
      ? await verifyDelegatedAccessToken(secret, token)
      : null;
  if (
    !payload ||
    payload.principalKind !== "service" ||
    !payload.serviceInitiator ||
    payload.accountId.toLowerCase() !== organizationId
  )
    throw serviceTokenRequired();
  const workspace = await getWorkspace(deps.db, payload.workspaceId).catch(() => null);
  if (!workspace || workspace.accountId.toLowerCase() !== organizationId)
    throw serviceTokenRequired();
  if (!hasPermission(payload.permissions, "members:manage"))
    throw new ApiHttpError(403, {
      code: "forbidden",
      message: "The service token cannot manage this organization's members.",
      retryable: false,
      outcomeUnknown: false,
      details: { code: HOST_COMMAND_PERMISSION_REQUIRED },
    });
  return {
    organizationId,
    actorSubjectId: payload.subjectId,
    serviceInitiatorSubjectId: payload.serviceInitiator.subjectId,
  };
}

async function recordAttribution(
  deps: ApiRouteDeps,
  authority: HostCommandAuthority,
  input: {
    mutation: GovernedMutation | typeof HOST_ORGANIZATION_OWNER_ENSURE;
    operationId: string;
    actingExternalUser: ActingExternalUser;
  },
): Promise<void> {
  const result = await recordOrganizationHostCommandAttribution(deps.db, {
    organizationId: authority.organizationId,
    operationId: input.operationId,
    mutation: input.mutation,
    serviceSubjectId: authority.actorSubjectId,
    serviceInitiatorSubjectId: authority.serviceInitiatorSubjectId,
    actingExternalUser: input.actingExternalUser,
  });
  if (result === "conflict")
    throw new ApiHttpError(409, {
      code: "idempotency_conflict",
      message: "This operation id was already used for a different host command.",
      retryable: false,
      outcomeUnknown: false,
      details: { code: HOST_COMMAND_OPERATION_CONFLICT },
    });
}

async function parseCommand<Schema extends z.ZodTypeAny>(
  context: Context,
  schema: Schema,
  invalidMessage = "invalid host command",
): Promise<z.infer<Schema>> {
  const parsed = schema.safeParse(await readRequestJson(context));
  if (!parsed.success) throw new HTTPException(422, { message: invalidMessage });
  return parsed.data;
}

function parsePathId(context: Context, name: string): string {
  const parsed = Uuid.safeParse(context.req.param(name));
  if (!parsed.success) throw new HTTPException(422, { message: `invalid ${name}` });
  return parsed.data.toLowerCase();
}

/**
 * `rethrowMembershipError`, with a refusal code on the 403 a database fence
 * gives when the service token's subject may not do this in the organization
 * (not an active owner or admin, or a role rule). Status and message are the
 * native ones.
 */
function rethrowHostMembershipError(error: unknown, resourceLimitMessage?: string): never {
  if (!lastSharedWorkspaceRemovalHttpError(error) && nestedPostgresSqlState(error) === "42501")
    throw new ApiHttpError(403, {
      code: "forbidden",
      message: "organization administration is not authorized",
      retryable: false,
      outcomeUnknown: false,
      details: { code: HOST_COMMAND_ACTOR_NOT_AUTHORIZED },
    });
  rethrowMembershipError(error, resourceLimitMessage);
}

function organizationNotHostGoverned(): ApiHttpError {
  return new ApiHttpError(403, {
    code: "forbidden",
    message: "This organization is not managed by a host application.",
    retryable: false,
    outcomeUnknown: false,
    details: { code: ORGANIZATION_NOT_HOST_GOVERNED },
  });
}

function hostOrganizationOwnerUnavailable(): ApiHttpError {
  return new ApiHttpError(503, {
    code: "upstream_unavailable",
    message: "Ensuring a host owner is not available on this deployment yet.",
    retryable: true,
    outcomeUnknown: false,
    details: { code: HOST_ORGANIZATION_OWNER_UNAVAILABLE },
  });
}

function serviceTokenRequired(): ApiHttpError {
  return new ApiHttpError(401, {
    code: "unauthenticated",
    message: "A service token for this organization is required.",
    retryable: false,
    outcomeUnknown: false,
    details: { code: HOST_COMMAND_SERVICE_TOKEN_REQUIRED },
  });
}

function sessionPolicyConflict(code: string, message: string): ApiHttpError {
  return new ApiHttpError(409, {
    code: "conflict",
    message,
    retryable: false,
    outcomeUnknown: false,
    details: { code },
  });
}

function hostSessionPolicyUnavailable(): ApiHttpError {
  return new ApiHttpError(503, {
    code: "upstream_unavailable",
    message: "Setting a host session policy is not available on this deployment yet.",
    retryable: true,
    outcomeUnknown: false,
    details: { code: HOST_SESSION_POLICY_UNAVAILABLE },
  });
}
