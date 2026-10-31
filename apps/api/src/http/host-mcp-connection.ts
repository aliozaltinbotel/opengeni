import { Permission } from "@opengeni/contracts";
import {
  HostOrganizationMcpConnection,
  type HostMcpConnectionNotLiveReason,
} from "@opengeni/contracts/organization-governance";
import { hasPermission, organizationWorkspaceInScope, type ApiRouteDeps } from "@opengeni/core";
import {
  accountPermissionsForOrganizationRole,
  getMcpOAuthConnectionRecord,
  getOrganizationAdministrationOverview,
  listOrganizationMembers,
  managedPersonalWorkspacePermissions,
  mcpOAuthConnectionConsentScope,
  resolveLiveMcpOAuthGrant,
  type McpOAuthConnectionRecord,
} from "@opengeni/db";

type Liveness =
  | { status: "active"; reason: null }
  | { status: "revoked"; reason: HostMcpConnectionNotLiveReason };

const LIVE: Liveness = { status: "active", reason: null };

function notLive(reason: HostMcpConnectionNotLiveReason): Liveness {
  return { status: "revoked", reason };
}

/**
 * One MCP connection of the organization as its embedding host sees it, or
 * null when it is unknown or another organization's (the same answer for
 * both). `actorSubjectId` reads the member list and the administration
 * overview, so it is checked like any administrator.
 */
export async function readHostMcpConnection(
  deps: Pick<ApiRouteDeps, "db">,
  input: { organizationId: string; actorSubjectId: string; connectionId: string },
): Promise<HostOrganizationMcpConnection | null> {
  const record = await getMcpOAuthConnectionRecord(deps.db, {
    accountId: input.organizationId,
    connectionId: input.connectionId,
  });
  if (!record) return null;
  const liveness = await connectionLiveness(deps, input, record);
  return HostOrganizationMcpConnection.parse({
    ...(record.grant.hostAdmission ? { hostAdmission: record.grant.hostAdmission } : {}),
    connectionId: record.id,
    organizationId: record.accountId,
    workspaceId: record.grant.workspaceId,
    clientId: record.clientId,
    status: liveness.status,
    reason: liveness.reason,
    consentScope: mcpOAuthConnectionConsentScope(record),
    revokedAt:
      liveness.reason === "revoked"
        ? record.revokedAt!.toISOString()
        : liveness.reason === "expired"
          ? record.grant.expiresAt.toISOString()
          : null,
    updatedAt: record.updatedAt.toISOString(),
  });
}

/**
 * Whether the connection's next request would resolve a live grant, checked in
 * `HOST_MCP_CONNECTION_NOT_LIVE_REASONS` order. A workspace connection asks
 * the live-grant resolution its requests use. An organization connection
 * resolves per action as its person, within the consented permissions and
 * scope: it is live while the person, still an active member, holds at least
 * one consented permission at the organization or in a workspace in scope
 * (the same rule consent offers permissions by).
 */
async function connectionLiveness(
  deps: Pick<ApiRouteDeps, "db">,
  input: { organizationId: string; actorSubjectId: string },
  record: McpOAuthConnectionRecord,
): Promise<Liveness> {
  if (record.revokedAt) return notLive("revoked");
  if (record.grant.expiresAt.getTime() <= Date.now()) return notLive("expired");
  const member = (await listOrganizationMembers(deps.db, input)).find(
    (candidate) => candidate.subjectId === record.grant.subjectId && candidate.status === "active",
  );
  if (!member) return notLive("membership_not_live");
  if (record.grant.workspaceId !== null)
    return (await resolveLiveMcpOAuthGrant(deps.db, record.grant))
      ? LIVE
      : notLive("permissions_lost");
  const access = record.grant.organizationAccess;
  if (!access) return notLive("permissions_lost");
  const overview = await getOrganizationAdministrationOverview(deps.db, input);
  const workspaceGrants: { workspaceId: string; permissions: Permission[] }[] =
    overview.workspaces.flatMap((workspace) =>
      workspace.members
        .filter((grant) => grant.organizationMembershipId === member.id)
        .map((grant) => ({
          workspaceId: workspace.id,
          permissions: grant.permissions.filter(
            (permission): permission is Permission => Permission.safeParse(permission).success,
          ),
        })),
    );
  if (member.personalWorkspaceId)
    workspaceGrants.push({
      workspaceId: member.personalWorkspaceId,
      permissions: managedPersonalWorkspacePermissions,
    });
  const inScope = workspaceGrants.filter((grant) =>
    organizationWorkspaceInScope(access.workspaceScope, grant.workspaceId),
  );
  const organizationPermissions = accountPermissionsForOrganizationRole(member.role);
  const held = access.permissions.some(
    (permission) =>
      hasPermission(organizationPermissions, permission) ||
      inScope.some((grant) => hasPermission(grant.permissions, permission)),
  );
  return held ? LIVE : notLive("permissions_lost");
}
