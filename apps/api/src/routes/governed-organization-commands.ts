import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import {
  OrganizationInvitation,
  OrganizationMember,
  OrganizationWorkspaceAccessMember,
  UpdateOrganizationMemberRequest,
  verifyDelegatedAccessToken,
} from "@opengeni/contracts";
import {
  HOST_COMMAND_OPERATION_CONFLICT,
  HOST_COMMAND_PERMISSION_REQUIRED,
  HOST_COMMAND_SERVICE_TOKEN_REQUIRED,
  HostChangeOrganizationMemberRoleRequest,
  HostInviteOrganizationMemberRequest,
  HostOrganizationMemberLifecycleRequest,
  HostRevokeOrganizationInvitationRequest,
  HostSetOrganizationWorkspaceMemberRequest,
  ORGANIZATION_NOT_HOST_GOVERNED,
  type ActingExternalUser,
  type GovernedMutation,
} from "@opengeni/contracts/organization-governance";
import { applyGovernedOrganizationPolicy, hasPermission, type ApiRouteDeps } from "@opengeni/core";
import {
  createOrganizationInvitation,
  getOrganizationInvitationForAdministration,
  getWorkspace,
  putOrganizationWorkspaceMember,
  recordOrganizationHostCommandAttribution,
  revokeOrganizationInvitation,
  updateOrganizationMember,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { assertOrganizationUserSetupDeliveryConfigured } from "../auth/organization-user-setup";
import { ApiHttpError } from "../http/api-error";
import {
  organizationGovernanceDecision,
  organizationGovernedByHostError,
} from "../http/organization-governance";
import { readRequestJson } from "../http/request-body";
import {
  deliverOrganizationUserSetup,
  memberTransitionMutation,
  rethrowMembershipError,
} from "./organization-memberships";

const Uuid = z.string().uuid();
const SERVICE_TOKEN_PREFIX = "ogd2_";

/** What a verified host command runs as. */
type HostCommandAuthority = {
  organizationId: string;
  /** The service token's subject: the database actor, checked like any administrator. */
  actorSubjectId: string;
  serviceInitiatorSubjectId: string;
};

/**
 * Host commands for organizations an embedding host governs. Each one runs the
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
      rethrowMembershipError(error);
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
      rethrowMembershipError(error);
    }
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

  for (const kind of ["suspend", "reactivate", "offboard"] as const) {
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
      rethrowMembershipError(error);
    }
  });
}

async function transitionMember(
  deps: ApiRouteDeps,
  authority: HostCommandAuthority,
  membershipId: string,
  actingExternalUser: ActingExternalUser,
  input: unknown,
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
      }),
    );
  } catch (error) {
    rethrowMembershipError(error);
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
  const decision = await organizationGovernanceDecision(deps, {
    organizationId,
    mutation,
    via: "host",
  });
  if (decision === "ungoverned")
    throw new ApiHttpError(403, {
      code: "forbidden",
      message: "This organization is not managed by a host application.",
      retryable: false,
      outcomeUnknown: false,
      details: { code: ORGANIZATION_NOT_HOST_GOVERNED },
    });
  if (decision === "refuse") throw organizationGovernedByHostError(mutation);
  // A host provisions its organizations out of band, so its first command is
  // where the fork learns this one is governed: no Personal workspaces there.
  try {
    await applyGovernedOrganizationPolicy(deps, {
      organizationId,
      actorSubjectId: payload.subjectId,
    });
  } catch (error) {
    rethrowMembershipError(error);
  }
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
    mutation: GovernedMutation;
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
): Promise<z.infer<Schema>> {
  const parsed = schema.safeParse(await readRequestJson(context));
  if (!parsed.success) throw new HTTPException(422, { message: "invalid host command" });
  return parsed.data;
}

function parsePathId(context: Context, name: string): string {
  const parsed = Uuid.safeParse(context.req.param(name));
  if (!parsed.success) throw new HTTPException(422, { message: `invalid ${name}` });
  return parsed.data.toLowerCase();
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
