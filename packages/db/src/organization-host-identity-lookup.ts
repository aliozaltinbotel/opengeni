import {
  OrganizationAdministrationOverview,
  OrganizationInvitation,
  OrganizationMember,
} from "@opengeni/contracts";
import { CanonicalHumanIdentityProjection } from "@opengeni/contracts/canonical-human-identities";
import {
  HostOrganizationIdentity,
  HostOrganizationMember,
  type HostOrganizationIdentity as HostOrganizationIdentityType,
  type HostOrganizationMember as HostOrganizationMemberType,
} from "@opengeni/contracts/organization-governance";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database";
import { activeCanonicalHumanLoginBinding } from "./canonical-human-identities";
import { rawRows, setSubjectRlsContext, withRlsContext } from "./database";

/**
 * Migration 1016's lookup by identity. Its runtime EXECUTE is withheld for one
 * release (runtime-posture DEFERRED_RUNTIME_PRIVATE_ROUTINES); until it is
 * granted the lookup resolves the identity through the member list instead.
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
      return (await hostIdentityLookupGranted(scopedDb))
        ? await lookupByIdentity(scopedDb, input)
        : await lookupThroughMemberList(scopedDb, input);
    },
  );
}

/** Whether 1016's routine exists and the runtime may call it. */
export async function hostIdentityLookupGranted(db: Pick<Database, "execute">): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select has_function_privilege(
      to_regprocedure(${HOST_IDENTITY_LOOKUP_ROUTINE})::oid, 'EXECUTE'
    ) as granted`,
  );
  return row?.granted === true;
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

// ---------------------------------------------------------------------------
// Until 1016's routine is granted: resolve the identity among the
// organization's own members, through routines the runtime already holds.
// Remove together with the grant.
// ---------------------------------------------------------------------------

const MANAGED_HUMAN_SUBJECT_PREFIX = "user:";
const INVITATION_PAGE_SIZE = 100;

const MatchedMember = z.object({
  member: OrganizationMember,
  projection: CanonicalHumanIdentityProjection,
});
type MatchedMember = z.infer<typeof MatchedMember>;

async function lookupThroughMemberList(
  db: Database,
  input: LookupInput,
): Promise<HostOrganizationIdentityType | null> {
  const matched = await membersOfIdentity(db, input);
  const [first] = matched;
  if (!first) return null;
  const { activeIdentity, loginBindings } = first.projection;
  const active = activeCanonicalHumanLoginBinding(first.projection);
  const binding = active
    ? loginBindings.find((candidate) => candidate.id === active.id)
    : undefined;
  const membershipIds = new Set(matched.map(({ member }) => member.id));
  const oldestActive = matched.find(({ member }) => member.status === "active");
  let verifiedEmail: string | null = null;
  if (binding) {
    const authUserIds = matched.map(({ member }) => authUserIdOf(member.subjectId));
    verifiedEmail = await bindingVerifiedEmail(db, binding, authUserIds);
  } else if (oldestActive) {
    verifiedEmail = await verifiedEmailOf(db, authUserIdOf(oldestActive.member.subjectId));
  }
  return HostOrganizationIdentity.parse({
    identityStatus: activeIdentity.status,
    verifiedEmail,
    activeLoginBinding: binding ? { id: binding.id, revision: binding.revision } : null,
    memberships: await membershipsWithAccess(
      db,
      input,
      matched.map(({ member }) => member),
    ),
    // The member list cannot see 1016's accepted_at, so acceptedAt is the
    // invitation's updatedAt. They are equal for every accepted invitation:
    // 0263's accept branch is the only writer of status 'accepted' and sets
    // updated_at in that same statement (1016's trigger copies it), and every
    // later invitation write (revoke, email binding) filters on pending.
    acceptedInvitations: (await listAllInvitations(db, input)).flatMap(
      ({ id, status, acceptedMembershipId, updatedAt }) =>
        status === "accepted" &&
        acceptedMembershipId !== null &&
        membershipIds.has(acceptedMembershipId)
          ? [{ id, acceptedMembershipId, acceptedAt: new Date(updatedAt).toISOString() }]
          : [],
    ),
  });
}

type HostMembership = HostOrganizationIdentityType["memberships"][number];

/**
 * Each matched membership with the fences its commands compare: the
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

/**
 * This organization's managed-human members whose account belongs to the
 * identity, oldest first: list_organization_members orders by created_at, id,
 * and the array order is kept.
 */
async function membersOfIdentity(db: Database, input: LookupInput): Promise<MatchedMember[]> {
  const rows = await rawRows<{ member: unknown; projection: unknown }>(
    db,
    sql`
      select candidate.member, candidate.projection
      from (
        select
          member.position,
          member.value as member,
          get_canonical_human_identity_projection(
            substr(member.value ->> 'subjectId', ${MANAGED_HUMAN_SUBJECT_PREFIX.length + 1})
          ) as projection
        from jsonb_array_elements(
          list_organization_members(${input.organizationId}::uuid, ${input.actorSubjectId})
        ) with ordinality as member(value, position)
        where starts_with(member.value ->> 'subjectId', ${MANAGED_HUMAN_SUBJECT_PREFIX})
      ) candidate
      where candidate.projection -> 'activeIdentity' ->> 'id' = ${input.identityId}
      order by candidate.position
    `,
  );
  return rows.map((row) => MatchedMember.parse({ member: row.member, projection: row.projection }));
}

function authUserIdOf(subjectId: string): string {
  return subjectId.slice(MANAGED_HUMAN_SUBJECT_PREFIX.length);
}

/** The verified email of the matched account the login binding signs in to. */
async function bindingVerifiedEmail(
  db: Database,
  binding: { providerId: string; providerAccountId: string },
  authUserIds: readonly string[],
): Promise<string | null> {
  const [row] = await rawRows<{ email: string }>(
    db,
    sql`select account_user.email
      from auth_identities account
      join auth_users account_user on account_user.id = account.user_id
      where lower(account.provider_id) = ${binding.providerId}
        and account.account_id = ${binding.providerAccountId}
        and account.user_id = any(array[${sql.join(
          authUserIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[])
        and account_user.email_verified
      limit 1`,
  );
  return row?.email ?? null;
}

async function verifiedEmailOf(db: Database, authUserId: string): Promise<string | null> {
  const [row] = await rawRows<{ email: string }>(
    db,
    sql`select email from auth_users where id = ${authUserId} and email_verified`,
  );
  return row?.email ?? null;
}

async function listAllInvitations(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<OrganizationInvitation[]> {
  const invitations: OrganizationInvitation[] = [];
  let cursor: string | null = null;
  for (;;) {
    const [row] = await rawRows<{ result: unknown }>(
      db,
      sql`select list_organization_invitations(
        ${input.organizationId}::uuid,
        ${input.actorSubjectId},
        ${cursor}::uuid,
        ${INVITATION_PAGE_SIZE}
      ) as result`,
    );
    // The routine returns one row past the page when another page follows.
    const page = z.array(OrganizationInvitation).parse(row?.result ?? []);
    invitations.push(...page.slice(0, INVITATION_PAGE_SIZE));
    if (page.length <= INVITATION_PAGE_SIZE) return invitations;
    cursor = page[INVITATION_PAGE_SIZE - 1]!.id;
  }
}
