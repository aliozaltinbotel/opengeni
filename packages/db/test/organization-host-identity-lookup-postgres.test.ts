import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  acceptOrganizationInvitation,
  bindPendingOrganizationInvitationsForVerifiedEmail,
  createDb,
  createManagedOrganization,
  createOrganizationInvitation,
  createOrganizationWorkspace,
  lookupOrganizationHostIdentity,
  nestedPostgresSqlState,
  putOrganizationWorkspaceMember,
  type DbClient,
} from "../src";
import { synchronizeCanonicalHumanLoginBindings } from "../src/canonical-human-identities";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";

/*
 * Migration 1016 under the deployed posture: a NOSUPERUSER, NOBYPASSRLS
 * migration owner whose definers FORCE RLS binds, and the restricted runtime
 * role, which 1019 grants the lookup by identity. The acceptance trigger and
 * the backfill of earlier acceptances run as that owner.
 */

const MIGRATION = readFileSync(
  new URL("../drizzle/1016_organization_host_identity_lookup.sql", import.meta.url),
  "utf8",
);
const LOOKUP = "opengeni_private.lookup_organization_host_identity(uuid, text, uuid)";

let fixture: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;

type World = {
  organizationId: string;
  ownerSubjectId: string;
  memberSubjectId: string;
  memberEmail: string;
  identityId: string;
  invitationId: string;
};
let world: World;

async function authUser(email: string, withPassword: boolean): Promise<string> {
  const id = crypto.randomUUID();
  await fixture!.admin`
    insert into auth_users (id, name, email, email_verified) values (${id}, 'Person', ${email}, true)`;
  if (withPassword)
    await fixture!.admin`
      insert into auth_identities (id, user_id, account_id, provider_id, password)
      values (${crypto.randomUUID()}, ${id}, ${id}, 'credential', 'not-a-real-hash')`;
  return id;
}

beforeAll(async () => {
  fixture = await acquireRestrictedRuntimeTestDatabase("host-identity-lookup", "lookup_data");
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(fixture.appUrl, { max: 2, searchPath: fixture.schema });
  const db = client.db;
  const ownerId = await authUser(`${crypto.randomUUID()}@example.test`, false);
  const ownerSubjectId = `user:${ownerId}`;
  const created = await createManagedOrganization(db, {
    subjectId: ownerSubjectId,
    subjectLabel: "Owner",
    name: "Lookup organization",
    operationId: crypto.randomUUID(),
  });
  const organizationId = created.organization.id;
  const memberEmail = `${crypto.randomUUID()}@example.test`;
  const memberId = await authUser(memberEmail, true);
  const memberSubjectId = `user:${memberId}`;
  const { identityId } = await synchronizeCanonicalHumanLoginBindings(db, memberId);
  const invitation = await createOrganizationInvitation(db, {
    organizationId,
    actorSubjectId: ownerSubjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: null,
    targetEmail: memberEmail,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await bindPendingOrganizationInvitationsForVerifiedEmail(db, {
    subjectId: memberSubjectId,
    email: memberEmail,
  });
  const [bound] = await fixture.admin<{ revision: string }[]>`
    select revision from organization_membership_invitations where id = ${invitation.id}`;
  await acceptOrganizationInvitation(db, {
    organizationId,
    actorSubjectId: memberSubjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: Number(bound!.revision),
  });
  world = {
    organizationId,
    ownerSubjectId,
    memberSubjectId,
    memberEmail,
    identityId,
    invitationId: invitation.id,
  };
}, 900_000);

afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

/** A new account that accepts an invitation into the world's organization. */
async function memberAccount(): Promise<{ userId: string; subjectId: string; email: string }> {
  const db = client!.db;
  const email = `${crypto.randomUUID()}@example.test`;
  const userId = await authUser(email, true);
  const subjectId = `user:${userId}`;
  const invitation = await createOrganizationInvitation(db, {
    organizationId: world.organizationId,
    actorSubjectId: world.ownerSubjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: null,
    targetEmail: email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await bindPendingOrganizationInvitationsForVerifiedEmail(db, { subjectId, email });
  const [bound] = await fixture!.admin<{ revision: string }[]>`
    select revision from organization_membership_invitations where id = ${invitation.id}`;
  await acceptOrganizationInvitation(db, {
    organizationId: world.organizationId,
    actorSubjectId: subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: Number(bound!.revision),
  });
  return { userId, subjectId, email };
}

/** A second account of an existing identity, as account linking would leave it. */
async function attachAccount(identityId: string, authUserId: string): Promise<void> {
  await fixture!.admin`
    insert into canonical_human_identity_subjects (auth_user_id, identity_id)
    values (${authUserId}, ${identityId})`;
}

/** Whether the runtime may call 1016's lookup (1019 grants it). */
async function lookupGranted(): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    client!.db,
    sql`select has_function_privilege(to_regprocedure(${LOOKUP})::oid, 'EXECUTE') as granted`,
  );
  return row?.granted === true;
}

async function lookup(identityId: string, actorSubjectId = world.ownerSubjectId) {
  return await lookupOrganizationHostIdentity(client!.db, {
    organizationId: world.organizationId,
    actorSubjectId,
    identityId,
  });
}

describe("1016 under a NOSUPERUSER migration owner", () => {
  test("the acceptance trigger records accepted_at from the accepting write", async () => {
    if (!fixture) return;
    const [row] = await fixture.admin<{ accepted_at: Date | null; updated_at: Date }[]>`
      select accepted_at, updated_at from organization_membership_invitations
      where id = ${world.invitationId}`;
    expect(row!.accepted_at).not.toBeNull();
    expect(row!.accepted_at).toEqual(row!.updated_at);
  });

  test("1019 grants the lookup to the runtime", async () => {
    if (!fixture) return;
    expect(await lookupGranted()).toBe(true);
  });

  test("the lookup by identity answers the memberships, invitations, email and binding", async () => {
    if (!fixture) return;
    const byIdentity = await lookup(world.identityId);
    const [membership] = await fixture.admin<{ id: string; authorization_revision: string }[]>`
      select id, authorization_revision from organization_memberships
      where account_id = ${world.organizationId} and subject_id = ${world.memberSubjectId}`;
    const [invitation] = await fixture.admin<{ accepted_at: Date }[]>`
      select accepted_at from organization_membership_invitations where id = ${world.invitationId}`;
    expect(byIdentity).toEqual({
      identityStatus: "active",
      verifiedEmail: world.memberEmail,
      activeLoginBinding: { id: expect.any(String), revision: 1 },
      memberships: [
        {
          id: membership!.id,
          status: "active",
          role: "member",
          authorizationRevision: Number(membership!.authorization_revision),
          sharedWorkspaceAccess: [],
        },
      ],
      acceptedInvitations: [
        {
          id: world.invitationId,
          acceptedMembershipId: membership!.id,
          acceptedAt: invitation!.accepted_at.toISOString(),
        },
      ],
    });
  });

  test("the lookup by identity leaves the caller's lifecycle markers as it found them", async () => {
    if (!fixture) return;
    const markers = await withRlsContext(
      client!.db,
      { accountId: world.organizationId, workspaceId: null },
      async (scopedDb) => {
        await setSubjectRlsContext(scopedDb, world.ownerSubjectId);
        const [row] = await rawRows<{ found: boolean; tenancy: string; identity: string }>(
          scopedDb,
          sql`with called as materialized (
              select opengeni_private.lookup_organization_host_identity(
                ${world.organizationId}::uuid, ${world.ownerSubjectId}, ${world.identityId}::uuid
              ) is not null as found
            )
            select called.found,
              coalesce(current_setting('opengeni.organization_tenancy_lifecycle', true), '') as tenancy,
              coalesce(current_setting('opengeni.canonical_human_identity_lifecycle', true), '')
                as identity
            from called`,
        );
        return row;
      },
    );
    expect(markers).toEqual({ found: true, tenancy: "", identity: "" });
  });

  test("the lookup answers nothing for an unknown identity or a non-member one", async () => {
    if (!fixture) return;
    const outsiderId = await authUser(`${crypto.randomUUID()}@example.test`, true);
    const { identityId: outsider } = await synchronizeCanonicalHumanLoginBindings(
      client!.db,
      outsiderId,
    );
    expect(await lookup(crypto.randomUUID())).toBeNull();
    expect(await lookup(outsider)).toBeNull();
  });

  test("the lookup refuses an actor that is not an organization administrator", async () => {
    if (!fixture) return;
    const failure = await lookup(world.identityId, world.memberSubjectId).catch(
      (error: unknown) => error,
    );
    expect(nestedPostgresSqlState(failure)).toBe("42501");
  });

  test("the backfill fills earlier acceptances as the owner, which FORCE RLS binds", async () => {
    if (!fixture) return;
    const backfill = MIGRATION.slice(
      MIGRATION.indexOf("ALTER TABLE organization_membership_invitations NO FORCE"),
      MIGRATION.indexOf(
        "CREATE FUNCTION opengeni_private.record_organization_invitation_acceptance",
      ),
    );
    expect(backfill).toContain("SET accepted_at = updated_at");
    const updated = await fixture.admin.begin(async (tx) => {
      // An invitation accepted before 1016.
      await tx`update organization_membership_invitations set accepted_at = null
        where id = ${world.invitationId}`;
      await tx.unsafe(`SET LOCAL ROLE "${fixture!.ownerRole}"`);
      // Without the owner window, FORCE RLS hides every row from the owner.
      const bare = await tx`update organization_membership_invitations
        set accepted_at = updated_at where status = 'accepted' and accepted_at is null`;
      expect(bare.count).toBe(0);
      await tx.unsafe(backfill);
      await tx.unsafe("RESET ROLE");
      const [row] = await tx<{ accepted_at: Date | null; updated_at: Date }[]>`
        select accepted_at, updated_at from organization_membership_invitations
        where id = ${world.invitationId}`;
      const [posture] = await tx<{ forced: boolean }[]>`
        select relforcerowsecurity as forced from pg_class
        where oid = 'organization_membership_invitations'::regclass`;
      return { row: row!, forced: posture!.forced };
    });
    expect(updated.row.accepted_at).toEqual(updated.row.updated_at);
    expect(updated.forced).toBe(true);
  });

  test("an active binding on an account that is not a member here answers no email", async () => {
    if (!fixture) return;
    const member = await memberAccount();
    const { identityId } = await synchronizeCanonicalHumanLoginBindings(client!.db, member.userId);
    // The identity's other account never joined the organization, and the
    // identity's active login binding signs in to that account.
    const outsiderId = await authUser(`${crypto.randomUUID()}@example.test`, true);
    await attachAccount(identityId, outsiderId);
    const [binding] = await fixture.admin<{ id: string }[]>`
      insert into canonical_human_login_bindings (identity_id, provider_id, provider_account_id)
      values (${identityId}, 'credential', ${outsiderId}) returning id`;
    await fixture.admin`
      update canonical_human_identities set active_login_binding_id = ${binding!.id}
      where id = ${identityId}`;
    const byIdentity = await lookup(identityId);
    expect(byIdentity?.verifiedEmail).toBeNull();
    expect(byIdentity?.activeLoginBinding).toEqual({ id: binding!.id, revision: 1 });
    expect(byIdentity?.memberships).toHaveLength(1);
  });

  test("the lookup answers the revision and shared-workspace grants the fences compare", async () => {
    if (!fixture) return;
    const db = client!.db;
    const member = await memberAccount();
    const { identityId } = await synchronizeCanonicalHumanLoginBindings(db, member.userId);
    const [membership] = await fixture.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${world.organizationId} and subject_id = ${member.subjectId}`;
    const workspaces = [];
    for (const name of ["Zeta workspace", "alpha workspace"])
      workspaces.push(
        await createOrganizationWorkspace(db, {
          organizationId: world.organizationId,
          actorSubjectId: world.ownerSubjectId,
          name,
          operationId: crypto.randomUUID(),
        }),
      );
    const grants = [
      { role: "viewer" as const, expectedUpdatedAt: null, operationId: crypto.randomUUID() },
      {
        role: "custom" as const,
        permissions: ["workspace:read" as const, "sessions:read" as const],
        expectedUpdatedAt: null,
        operationId: crypto.randomUUID(),
      },
    ];
    for (const [index, access] of grants.entries())
      await putOrganizationWorkspaceMember(db, {
        organizationId: world.organizationId,
        actorSubjectId: world.ownerSubjectId,
        workspaceId: workspaces[index]!.id,
        targetOrganizationMembershipId: membership!.id,
        access,
      });
    const [revision] = await fixture.admin<{ authorization_revision: string }[]>`
      select authorization_revision from organization_memberships where id = ${membership!.id}`;
    // What the fences read, in the database's own text for the instant.
    const sharedWorkspaceAccess = await fixture.admin<
      {
        workspaceId: string;
        membershipId: string;
        permissions: string[];
        updatedAt: string;
        name: string;
      }[]
    >`
      select access.workspace_id as "workspaceId", access.id as "membershipId",
        access.permissions, to_jsonb(access.updated_at) #>> '{}' as "updatedAt",
        workspace.name
      from workspace_memberships access
      join workspaces workspace on workspace.id = access.workspace_id
      where access.subject_id = ${member.subjectId}
        and access.account_id = ${world.organizationId}
        and access.workspace_id in (${workspaces[0]!.id}, ${workspaces[1]!.id})
      order by lower(workspace.name), workspace.id`;
    const byIdentity = await lookup(identityId);
    expect(byIdentity?.memberships).toEqual([
      {
        id: membership!.id,
        status: "active",
        role: "member",
        authorizationRevision: Number(revision!.authorization_revision),
        sharedWorkspaceAccess: sharedWorkspaceAccess.map((row) => ({
          workspaceId: row.workspaceId,
          membershipId: row.membershipId,
          role: row.name === "alpha workspace" ? "custom" : "viewer",
          permissions: row.permissions,
          updatedAt: row.updatedAt,
        })),
      },
    ]);
    expect(byIdentity?.memberships[0]!.sharedWorkspaceAccess.map((grant) => grant.role)).toEqual([
      "custom",
      "viewer",
    ]);
  });

  test("an identity with two member accounts answers both", async () => {
    if (!fixture) return;
    const first = await memberAccount();
    const { identityId } = await synchronizeCanonicalHumanLoginBindings(client!.db, first.userId);
    const second = await memberAccount();
    await attachAccount(identityId, second.userId);
    const memberships = await fixture.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${world.organizationId}
        and subject_id in (${first.subjectId}, ${second.subjectId})
      order by created_at, id`;
    const byIdentity = await lookup(identityId);
    expect(byIdentity?.memberships.map((membership) => membership.id)).toEqual(
      memberships.map((membership) => membership.id),
    );
    expect(byIdentity?.acceptedInvitations).toHaveLength(2);
    // The active binding signs in to the first account, a member here.
    expect(byIdentity?.verifiedEmail).toBe(first.email);
  });
});
