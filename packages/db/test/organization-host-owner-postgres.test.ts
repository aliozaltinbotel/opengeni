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
import {
  rawRows,
  setRlsContext,
  setSubjectRlsContext,
  withRlsContext,
  type Database,
} from "../src/database";
import { ensureBootstrappedOrganizationOwner } from "../src/organization-host-owner";

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

/** What the host does: bootstrap an organization asking for its owner. */
async function bootstrap(
  subjectId = `test-host:provisioner:${crypto.randomUUID()}`,
  options: { tenant?: string; owner?: boolean } = {},
) {
  const tenant = options.tenant ?? crypto.randomUUID();
  const context = await bootstrapWorkspace(client!.db, {
    accountExternalSource: SOURCE,
    accountExternalId: tenant,
    accountName: `Tenant ${tenant}`,
    workspaceExternalSource: SOURCE,
    workspaceExternalId: tenant,
    workspaceName: `Workspace ${tenant}`,
    subjectId,
    ...(options.owner === false ? {} : { governedOrganizationOwner: true }),
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

/** Backends waiting for the blocker's lock on this schema's workspaces table. */
async function workspacesLockWaiters(): Promise<number[]> {
  const rows = await fixture!.admin<{ pid: number }[]>`
    select pid from pg_locks
    where not granted and locktype = 'relation'
      and relation = to_regclass(${`"${fixture!.schema}".workspaces`})`;
  return rows.map((row) => row.pid);
}

/** Backends waiting for the transaction of `pid` (here: on its organization insert). */
async function transactionWaiters(pid: number): Promise<number> {
  const [row] = await fixture!.admin<{ waiting: number }[]>`
    select count(*)::int as waiting from pg_locks waiter
    where not waiter.granted and waiter.locktype = 'transactionid'
      and waiter.transactionid = (
        select holder.transactionid from pg_locks holder
        where holder.pid = ${pid} and holder.locktype = 'transactionid' and holder.granted
        limit 1
      )`;
  return row!.waiting;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(25);
  }
  throw new Error(`never observed: ${what}`);
}

describe("bootstrapWorkspace's owner write", () => {
  test("is opt-in: without governedOrganizationOwner a granted bootstrap writes no owner", async () => {
    if (!fixture) return;
    await setGrant(true);
    const organization = await bootstrap(undefined, { owner: false });
    expect(await memberships(organization.organizationId)).toEqual([]);
    const [counts] = await fixture.admin<{ workspaces: number; controls: number }[]>`
      select (select count(*)::int from workspaces
          where account_id = ${organization.organizationId}) as workspaces,
        (select count(*)::int from workspace_inference_controls
          where account_id = ${organization.organizationId}) as controls`;
    // Only the bootstrapped workspace: no hidden Personal workspace or its control row.
    expect(counts).toEqual({ workspaces: 1, controls: 1 });
  });

  test("two concurrent first bootstraps of one organization both complete, with one owner", async () => {
    if (!fixture) return;
    await setGrant(true);
    const tenant = crypto.randomUUID();
    const subjects = [1, 2].map((n) => `test-host:provisioner-${n}:${crypto.randomUUID()}`);
    // Hold the first bootstrap after its organization insert (its next
    // statement reads workspaces), so the second reads no organization yet,
    // inserts it too and waits on the first's row: both believe they created it.
    const blocker = await fixture.admin.reserve();
    let first: Promise<Organization> | undefined;
    let second: Promise<Organization> | undefined;
    try {
      await blocker`begin`;
      await blocker.unsafe(`lock table "${fixture.schema}".workspaces in access exclusive mode`);
      first = bootstrap(subjects[0], { tenant });
      // Exactly the first bootstrap, held on workspaces after its insert.
      const [firstPid] = await until(
        workspacesLockWaiters,
        (pids) => pids.length === 1,
        "the first bootstrap waiting on workspaces",
      );
      second = bootstrap(subjects[1], { tenant });
      // The second waits on the first's transaction: it inserted the same
      // organization after reading none, so the two really raced.
      await until(
        () => transactionWaiters(firstPid!),
        (waiting) => waiting === 1,
        "the second bootstrap waiting on the first's organization insert",
      );
    } finally {
      await blocker`commit`;
      blocker.release();
    }
    const [one, two] = await Promise.all([first!, second!]);
    expect(two.organizationId).toBe(one.organizationId);
    const rows = await memberships(one.organizationId);
    expect(rows.map(({ role, status }) => ({ role, status }))).toEqual([
      { role: "owner", status: "active" },
    ]);
    expect(subjects).toContain(rows[0]!.subject_id);
  });

  test("identity-backed subjects are skipped, as the routine refuses them", async () => {
    if (!fixture) return;
    await setGrant(true);
    for (const subjectId of [
      `user:${crypto.randomUUID()}`,
      `external_user:${crypto.randomUUID()}`,
    ]) {
      const organization = await bootstrap(subjectId);
      expect(await memberships(organization.organizationId)).toEqual([]);
    }
    // Only the exact prefixes: '_' is no wildcard.
    const lookalike = await bootstrap(`externalXuser:${crypto.randomUUID()}`);
    expect((await memberships(lookalike.organizationId)).map((row) => row.role)).toEqual(["owner"]);
  });

  test("while the routine is withheld it sets no subject context in the caller's transaction", async () => {
    if (!fixture) return;
    await setGrant(false);
    const organization = await bootstrap(undefined, { owner: false });
    const subject = await client!.db.transaction(async (tx) => {
      const scoped = tx as unknown as Database;
      await setRlsContext(scoped, { accountId: organization.organizationId, workspaceId: null });
      await ensureBootstrappedOrganizationOwner(scoped, {
        organizationId: organization.organizationId,
        subjectId: organization.subjectId,
        accountExternalSource: SOURCE,
      });
      const [row] = await rawRows<{ subject: string }>(
        scoped,
        sql`select coalesce(current_setting('opengeni.subject_id', true), '') as subject`,
      );
      return row!.subject;
    });
    expect(subject).toBe("");
    expect(await memberships(organization.organizationId)).toEqual([]);
  });
});
