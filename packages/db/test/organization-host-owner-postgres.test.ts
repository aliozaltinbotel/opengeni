import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  ensureOrganizationHostOwner,
  hostOrganizationOwnerGranted,
  nestedPostgresSqlState,
  recordOrganizationHostCommandAttribution,
  type DbClient,
} from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";

/*
 * Migration 1017's host owner routine under the deployed posture: a
 * NOSUPERUSER, NOBYPASSRLS migration owner whose definers FORCE RLS binds, and
 * the restricted runtime role. It makes the calling subject, and only that
 * subject, the owner of the calling organization, once, when that subject owns
 * one of the organization's workspaces (the subject the host bootstrapped the
 * organization for), and only into a new organization (bootstrapWorkspace) or
 * for a recorded host command. It never changes another membership.
 */

const ROUTINE = "opengeni_private.ensure_organization_host_owner(uuid, text, uuid)";
const SOURCE = "test-host:tenant";

let fixture: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;

type Organization = { organizationId: string; workspaceId: string; subjectId: string };
type MembershipRow = {
  id: string;
  subject_id: string;
  role: string;
  status: string;
  authorization_revision: string;
  personal_workspace_id: string | null;
  updated_at: Date;
};

beforeAll(async () => {
  fixture = await acquireRestrictedRuntimeTestDatabase("host-organization-owner", "owner_data");
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(fixture.appUrl, { max: 2, searchPath: fixture.schema });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

async function setGrant(granted: boolean): Promise<void> {
  await fixture!.admin.unsafe(
    `${granted ? "GRANT" : "REVOKE"} EXECUTE ON FUNCTION ${ROUTINE} ${granted ? "TO" : "FROM"} opengeni_app`,
  );
  expect(await hostOrganizationOwnerGranted(client!.db)).toBe(granted);
}

async function bootstrap(subjectId = `test-host:provisioner:${crypto.randomUUID()}`) {
  const tenant = crypto.randomUUID();
  const context = await bootstrapWorkspace(client!.db, {
    accountExternalSource: SOURCE,
    accountExternalId: tenant,
    accountName: `Tenant ${tenant}`,
    workspaceExternalSource: SOURCE,
    workspaceExternalId: tenant,
    workspaceName: `Workspace ${tenant}`,
    subjectId,
  });
  return {
    organizationId: context.defaultAccountId!,
    workspaceId: context.defaultWorkspaceId!,
    subjectId,
  } satisfies Organization;
}

async function memberships(organizationId: string): Promise<MembershipRow[]> {
  return await fixture!.admin<MembershipRow[]>`
    select id, subject_id, role, status, authorization_revision, personal_workspace_id, updated_at
    from organization_memberships where account_id = ${organizationId} order by created_at, id`;
}

/** Records the host command an ensure needs, as the route does first. */
async function recordEnsure(
  organization: Organization,
  options: { subjectId?: string; mutation?: string } = {},
): Promise<string> {
  const operationId = crypto.randomUUID();
  expect(
    await recordOrganizationHostCommandAttribution(client!.db, {
      organizationId: organization.organizationId,
      operationId,
      mutation: options.mutation ?? "host_owner.ensure",
      serviceSubjectId: options.subjectId ?? organization.subjectId,
      serviceInitiatorSubjectId: "test-host:governance",
      actingExternalUser: { source: "test-host:user", externalId: "staff-1" },
    }),
  ).toBe("recorded");
  return operationId;
}

/** The host command's ensure: recorded first, then run. */
async function hostEnsure(organization: Organization) {
  return await ensureOrganizationHostOwner(client!.db, {
    ...organization,
    operationId: await recordEnsure(organization),
  });
}

/** The routine called directly, under an arbitrary account and subject context. */
async function callAs(
  context: { accountId: string; subjectId: string },
  target: Organization,
  operationId: string | null,
) {
  return await withRlsContext(
    client!.db,
    { accountId: context.accountId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, context.subjectId);
      return await rawRows(
        scopedDb,
        sql`select opengeni_private.ensure_organization_host_owner(
          ${target.organizationId}::uuid, ${target.subjectId}, ${operationId}::uuid) as result`,
      );
    },
  );
}

async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  return nestedPostgresSqlState(await promise.then(() => null).catch((error: unknown) => error));
}

describe("1017 under a NOSUPERUSER migration owner", () => {
  test("the routine is withheld from the runtime, and bootstrap then writes no owner", async () => {
    if (!fixture) return;
    expect(await hostOrganizationOwnerGranted(client!.db)).toBe(false);
    const organization = await bootstrap();
    expect(await memberships(organization.organizationId)).toEqual([]);
    expect(await hostEnsure(organization)).toBeNull();
    expect(await memberships(organization.organizationId)).toEqual([]);
  });

  test("granted, bootstrap makes the subject the owner of the new organization", async () => {
    if (!fixture) return;
    await setGrant(true);
    const organization = await bootstrap();
    const rows = await memberships(organization.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_id: organization.subjectId,
      role: "owner",
      status: "active",
      authorization_revision: "1",
    });
    const [personal] = await fixture.admin<
      { external_source: string; external_id: string; access: string; controls: string }[]
    >`
      select workspace.external_source, workspace.external_id,
        (select count(*) from workspace_memberships access
          where access.workspace_id = workspace.id) as access,
        (select count(*) from workspace_inference_controls control
          where control.workspace_id = workspace.id) as controls
      from workspaces workspace where workspace.id = ${rows[0]!.personal_workspace_id}`;
    // The hidden Personal workspace every active membership has: no runtime
    // access, the same identity managed and external members get.
    expect(personal).toEqual({
      external_source: "opengeni:organization-membership",
      external_id: `${organization.organizationId}:${organization.subjectId}`,
      access: "0",
      controls: "1",
    });
  });

  test("ensure is idempotent and leaves every other membership alone", async () => {
    if (!fixture) return;
    await setGrant(false);
    const organization = await bootstrap();
    await setGrant(true);
    // Another membership of the organization (an external member).
    const [other] = await fixture.admin<{ id: string }[]>`
      with personal as (
        insert into workspaces (account_id, name, external_source, external_id)
        values (${organization.organizationId}, 'Personal workspace',
          'opengeni:organization-membership', ${`${organization.organizationId}:external_user:x`})
        returning id
      )
      insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
      select ${organization.organizationId}, 'external_user:x', 'member', 'active', personal.id
      from personal returning id`;
    const otherBefore = (await memberships(organization.organizationId)).find(
      (row) => row.id === other!.id,
    );
    const first = await hostEnsure(organization);
    expect(first?.created).toBe(true);
    const afterFirst = await memberships(organization.organizationId);
    expect(afterFirst.find((row) => row.id === other!.id)).toEqual(otherBefore);
    const owner = afterFirst.find((row) => row.subject_id === organization.subjectId);
    expect(first).toEqual({
      membershipId: owner!.id,
      subjectId: organization.subjectId,
      created: true,
    });
    const second = await hostEnsure(organization);
    expect(second).toEqual({ ...first!, created: false });
    expect(await memberships(organization.organizationId)).toEqual(afterFirst);
  });

  test("only the calling subject in the calling organization", async () => {
    if (!fixture) return;
    await setGrant(false);
    const target = await bootstrap();
    const elsewhere = await bootstrap();
    await setGrant(true);
    // Another subject's context, and another organization's context.
    const operationId = await recordEnsure(target);
    for (const context of [
      { accountId: target.organizationId, subjectId: elsewhere.subjectId },
      { accountId: elsewhere.organizationId, subjectId: target.subjectId },
    ])
      expect(await sqlState(callAs(context, target, operationId))).toBe("42501");
    // Its own context, but a subject that owns none of this organization's
    // workspaces, and identity-backed subjects.
    for (const subjectId of [
      elsewhere.subjectId,
      `user:${crypto.randomUUID()}`,
      `external_user:${crypto.randomUUID()}`,
    ]) {
      const candidate = { ...target, subjectId };
      expect(await sqlState(hostEnsure(candidate))).toBe("42501");
    }
    expect(await memberships(target.organizationId)).toEqual([]);
    expect(await memberships(elsewhere.organizationId)).toEqual([]);
  });

  test("a membership of the subject that is not an active owner is never changed", async () => {
    if (!fixture) return;
    await setGrant(true);
    const organization = await bootstrap();
    const [owner] = await memberships(organization.organizationId);
    for (const change of ["role = 'member'", "status = 'revoked', revoked_at = now()"]) {
      await fixture.admin.unsafe(
        `update organization_memberships set role = 'owner', status = 'active', revoked_at = null
         where id = '${owner!.id}'`,
      );
      await fixture.admin.unsafe(
        `update organization_memberships set ${change} where id = '${owner!.id}'`,
      );
      const before = await memberships(organization.organizationId);
      expect(await sqlState(hostEnsure(organization))).toBe("55000");
      expect(await memberships(organization.organizationId)).toEqual(before);
    }
  });

  test("an owner is added to an existing organization only for a recorded host command", async () => {
    if (!fixture) return;
    await setGrant(false);
    const organization = await bootstrap();
    const other = await bootstrap();
    await setGrant(true);
    const self = { accountId: organization.organizationId, subjectId: organization.subjectId };
    // No attribution, another command's, another subject's, another
    // organization's: each is refused.
    const unrecorded = crypto.randomUUID();
    const otherCommand = await recordEnsure(organization, { mutation: "membership.role.change" });
    const otherSubject = await recordEnsure(organization, { subjectId: other.subjectId });
    const otherOrganization = await recordEnsure(other);
    for (const operationId of [unrecorded, otherCommand, otherSubject, otherOrganization])
      expect(await sqlState(callAs(self, organization, operationId))).toBe("42501");
    expect(await memberships(organization.organizationId)).toEqual([]);
    // Without an operation id (bootstrapWorkspace's call), only while the
    // organization has no membership at all.
    await fixture.admin`
      with personal as (
        insert into workspaces (account_id, name, external_source, external_id)
        values (${organization.organizationId}, 'Personal workspace',
          'opengeni:organization-membership', ${`${organization.organizationId}:external_user:y`})
        returning id
      )
      insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
      select ${organization.organizationId}, 'external_user:y', 'member', 'active', personal.id
      from personal`;
    expect(await sqlState(callAs(self, organization, null))).toBe("42501");
    expect((await memberships(organization.organizationId)).map((row) => row.subject_id)).toEqual([
      "external_user:y",
    ]);
    const [created] = await callAs(self, organization, await recordEnsure(organization));
    expect((created as { result: { created: boolean } }).result.created).toBe(true);
  });
});
