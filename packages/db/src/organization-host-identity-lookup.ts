import { OrganizationAdministrationOverview, OrganizationMember } from "@opengeni/contracts";
import { CanonicalHumanIdentityProjection } from "@opengeni/contracts/canonical-human-identities";
import {
  HostOrganizationIdentity,
  HostOrganizationMember,
  type HostOrganizationIdentity as HostOrganizationIdentityType,
  type HostOrganizationMember as HostOrganizationMemberType,
} from "@opengeni/contracts/organization-governance";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, setSubjectRlsContext, withRlsContext } from "./database";

/**
 * Migration 1016's lookup by identity (runtime EXECUTE granted by 1019;
 * readiness requires it).
 */
export const HOST_IDENTITY_LOOKUP_ROUTINE =
  "opengeni_private.lookup_organization_host_identity(uuid, text, uuid)";

type LookupInput = { organizationId: string; actorSubjectId: string; identityId: string };

/**
 * What one organization knows about a native identity, for its embedding host.
 * Null when no membership of this organization (in any status) belongs to the
 * identity, whether or not the identity exists: callers must not tell the two
 * apart. The actor is checked like any administrator (active owner or admin).
 */
export async function lookupOrganizationHostIdentity(
  db: Database,
  input: LookupInput,
): Promise<HostOrganizationIdentityType | null> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      return await lookupByIdentity(scopedDb, input);
    },
  );
}

async function lookupByIdentity(
  db: Database,
  input: LookupInput,
): Promise<HostOrganizationIdentityType | null> {
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select opengeni_private.lookup_organization_host_identity(
      ${input.organizationId}::uuid, ${input.actorSubjectId}, ${input.identityId}::uuid
    ) as result`,
  );
  return row?.result ? HostOrganizationIdentity.parse(row.result) : null;
}

const MANAGED_HUMAN_SUBJECT_PREFIX = "user:";

type HostMembership = HostOrganizationIdentityType["memberships"][number];

/**
 * Each membership with the fences its commands compare: the
 * authorization revision, and the shared-workspace grants as the
 * administration overview gives them (workspaces by name, Personal workspaces
 * excluded, updatedAt in the database's own text). Bounded like the overview:
 * 500 shared workspaces, 1000 grants each (54000 beyond).
 */
async function membershipsWithAccess(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
  members: readonly OrganizationMember[],
): Promise<HostMembership[]> {
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select get_organization_administration_overview(
      ${input.organizationId}::uuid, ${input.actorSubjectId}
    ) as result`,
  );
  const { workspaces } = OrganizationAdministrationOverview.parse(row?.result);
  return members.map((member) => ({
    id: member.id,
    status: member.status,
    role: member.role,
    authorizationRevision: member.authorizationRevision,
    sharedWorkspaceAccess: workspaces.flatMap((workspace) =>
      workspace.members
        .filter((access) => access.organizationMembershipId === member.id)
        .map((access) => ({
          workspaceId: workspace.id,
          membershipId: access.membershipId,
          role: access.role,
          permissions: access.permissions,
          updatedAt: access.updatedAt,
        })),
    ),
  }));
}

/**
 * One of the organization's memberships in any status, for its embedding
 * host, or null when it is unknown or another organization's (the same answer
 * for both). Read through the member list and the administration overview, so
 * the actor is checked like any administrator (active owner or admin).
 */
export async function readOrganizationHostMember(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; membershipId: string },
): Promise<HostOrganizationMemberType | null> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select list_organization_members(
          ${input.organizationId}::uuid, ${input.actorSubjectId}
        ) as result`,
      );
      const member = OrganizationMember.array()
        .parse(row?.result ?? [])
        .find(({ id }) => id === input.membershipId);
      if (!member) return null;
      const [access] = await membershipsWithAccess(scopedDb, input, [member]);
      const userId = member.subjectId.startsWith(MANAGED_HUMAN_SUBJECT_PREFIX)
        ? authUserIdOf(member.subjectId)
        : null;
      return HostOrganizationMember.parse({
        membershipId: member.id,
        organizationId: member.organizationId,
        userId,
        identityId: userId ? await identityIdOf(scopedDb, userId) : null,
        status: member.status,
        role: member.role,
        authorizationRevision: member.authorizationRevision,
        sharedWorkspaceAccess: access?.sharedWorkspaceAccess ?? [],
        updatedAt: member.updatedAt,
      });
    },
  );
}

async function identityIdOf(db: Database, authUserId: string): Promise<string | null> {
  const [row] = await rawRows<{ projection: unknown }>(
    db,
    sql`select get_canonical_human_identity_projection(${authUserId}) as projection`,
  );
  if (row?.projection === null || row?.projection === undefined) return null;
  return CanonicalHumanIdentityProjection.parse(row.projection).activeIdentity.id;
}

function authUserIdOf(subjectId: string): string {
  return subjectId.slice(MANAGED_HUMAN_SUBJECT_PREFIX.length);
}
