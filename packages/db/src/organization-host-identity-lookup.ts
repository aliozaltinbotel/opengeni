import { OrganizationInvitation, OrganizationMember } from "@opengeni/contracts";
import { CanonicalHumanIdentityProjection } from "@opengeni/contracts/canonical-human-identities";
import {
  HostOrganizationIdentity,
  type HostOrganizationIdentity as HostOrganizationIdentityType,
} from "@opengeni/contracts/organization-governance";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database";
import { rawRows, setSubjectRlsContext, withRlsContext } from "./database";

const MANAGED_HUMAN_SUBJECT_PREFIX = "user:";
const INVITATION_PAGE_SIZE = 100;

const MatchedMember = z.object({
  member: OrganizationMember,
  projection: CanonicalHumanIdentityProjection,
});
type MatchedMember = z.infer<typeof MatchedMember>;

/**
 * What one organization knows about a native identity, for its embedding host.
 * Null when no membership of this organization (in any status) belongs to the
 * identity, whether or not the identity exists: callers must not tell the two
 * apart.
 *
 * The actor is checked like any administrator (active owner or admin); the
 * organization's member list is the only way in, so an identity is resolved
 * only among this organization's own members. That costs one identity
 * projection per managed-human member and one invitation page per 100
 * invitations, in one read transaction.
 */
export async function lookupOrganizationHostIdentity(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; identityId: string },
): Promise<HostOrganizationIdentityType | null> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const matched = await membersOfIdentity(scopedDb, input);
      const [first] = matched;
      if (!first) return null;
      const identity = first.projection.activeIdentity;
      const binding = first.projection.loginBindings.find(
        (candidate) => candidate.id === identity.activeLoginBindingId,
      );
      const membershipIds = new Set(matched.map(({ member }) => member.id));
      return HostOrganizationIdentity.parse({
        identityStatus: identity.status,
        verifiedEmail: await verifiedEmailOf(scopedDb, authUserIdOf(first.member.subjectId)),
        activeLoginBinding:
          binding?.status === "active" ? { id: binding.id, revision: binding.revision } : null,
        acceptedInvitations: (await listAllInvitations(scopedDb, input)).flatMap(
          ({ id, status, acceptedMembershipId, updatedAt }) =>
            status === "accepted" &&
            acceptedMembershipId !== null &&
            membershipIds.has(acceptedMembershipId)
              ? [{ id, acceptedMembershipId, acceptedAt: new Date(updatedAt).toISOString() }]
              : [],
        ),
      });
    },
  );
}

/** This organization's managed-human members whose account belongs to the identity, oldest first. */
async function membersOfIdentity(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; identityId: string },
): Promise<MatchedMember[]> {
  const rows = await rawRows<{ member: unknown; projection: unknown }>(
    db,
    sql`
      select candidate.member, candidate.projection
      from (
        select
          member.value as member,
          get_canonical_human_identity_projection(
            substr(member.value ->> 'subjectId', ${MANAGED_HUMAN_SUBJECT_PREFIX.length + 1})
          ) as projection
        from jsonb_array_elements(
          list_organization_members(${input.organizationId}::uuid, ${input.actorSubjectId})
        ) member
        where starts_with(member.value ->> 'subjectId', ${MANAGED_HUMAN_SUBJECT_PREFIX})
      ) candidate
      where candidate.projection -> 'activeIdentity' ->> 'id' = ${input.identityId.toLowerCase()}
    `,
  );
  return rows
    .map((row) => MatchedMember.parse({ member: row.member, projection: row.projection }))
    .sort(
      (left, right) =>
        Date.parse(left.member.createdAt) - Date.parse(right.member.createdAt) ||
        left.member.id.localeCompare(right.member.id),
    );
}

function authUserIdOf(subjectId: string): string {
  return subjectId.slice(MANAGED_HUMAN_SUBJECT_PREFIX.length);
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
