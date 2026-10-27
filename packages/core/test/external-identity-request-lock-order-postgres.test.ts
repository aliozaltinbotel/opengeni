import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createOrganizationApiKey, createWorkspace } from "@opengeni/db";
import {
  EXTERNAL_FIRST_USE_MEMBER_PERMISSIONS,
  requireAccessContext,
  requireAccessGrantAuthorization,
} from "../src/access";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  rawRows,
  withAccountRls,
  withSessionRlsActorContext,
  type DbClient,
} from "../../db/src/database";
import {
  ensureExternalIdentity,
  lockExternalWorkspaceMembershipLifecycle,
  readExistingExternalIdentity,
} from "../../db/src/external-identities";
import { assertActiveManagedHumanOrganizationMembership } from "../../db/src/organization-membership-lifecycle";
import { nestedPostgresSqlState } from "../../db/src/persistence-errors";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("external-identity-lock-order");
  if (!acquired) throw new Error("External identity lock-order checks require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  // A changed migration fingerprint rebuilds the native template before cloning.
}, 300_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("external identity lookup uses a non-owner role without RLS bypass", async () => {
  const [posture] = await rawRows<{
    superuser: boolean;
    bypassRls: boolean;
    ownsMemberships: boolean;
    forcedRls: boolean;
  }>(
    client.db,
    sql`select role.rolsuper as superuser, role.rolbypassrls as "bypassRls",
      relation.relowner = role.oid as "ownsMemberships",
      relation.relforcerowsecurity as "forcedRls"
      from pg_roles role, pg_class relation
      where role.rolname = current_user
        and relation.oid = 'organization_memberships'::regclass`,
  );
  expect(posture).toEqual({
    superuser: false,
    bypassRls: false,
    ownsMemberships: false,
    forcedRls: true,
  });
});

test("concurrent identity lookup cannot invert a membership-fenced writer", async () => {
  const [account] = await shared.admin`
    insert into managed_accounts (name) values ('External identity concurrency') returning id`;
  if (!account) throw new Error("Account fixture missing");
  const input = {
    accountId: String(account.id),
    source: "example.test",
    externalId: crypto.randomUUID(),
  };
  const identity = await ensureExternalIdentity(client.db, input);
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId: input.accountId,
    name: "External request fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:read"],
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  app.get("/context", async (c) =>
    c.json(
      await requireAccessContext(c, {
        db: client.db,
        settings: testSettings({ productAccessMode: "configured" }),
      }),
    ),
  );
  const lookup = () =>
    app.request("http://example.test/context", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source: input.source, externalId: input.externalId },
          }),
        ),
      },
    });
  const writerReady = Promise.withResolvers<number>();
  const continueWriter = Promise.withResolvers<void>();
  const writer = withSessionRlsActorContext({ subjectId: identity.subjectId }, () =>
    withAccountRls(client.db, input.accountId, async (tx) => {
      await lockExternalWorkspaceMembershipLifecycle(tx, input.accountId);
      const revision = await assertActiveManagedHumanOrganizationMembership(tx, {
        accountId: input.accountId,
        subjectId: identity.subjectId,
      });
      expect(revision).toBe(1);
      const [backend] = await rawRows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`);
      if (!backend) throw new Error("Writer backend missing");
      writerReady.resolve(backend.pid);
      await continueWriter.promise;
      // A private session writer rechecks the identity after locking its live
      // membership. The organization fence must be reentrant on this backend.
      return await ensureExternalIdentity(tx, input);
    }),
  ).then(
    (value) => ({ value, code: null }),
    (error) => {
      writerReady.reject(error);
      return { value: null, code: nestedPostgresSqlState(error) ?? String(error) };
    },
  );
  let reader: Promise<Response> | undefined;
  let waitingLock: string | undefined;
  try {
    const writerPid = await writerReady.promise;
    reader = lookup();
    const deadline = Date.now() + 5_000;
    do {
      const [waiting] = await shared.admin<{ locktype: string }[]>`
        select lock.locktype from pg_locks lock
        join pg_stat_activity activity on activity.pid = lock.pid
        where activity.datname = current_database() and lock.pid <> ${writerPid}
          and not lock.granted
          and ${writerPid} = any(pg_blocking_pids(lock.pid))`;
      if (waiting) {
        waitingLock = waiting.locktype;
        break;
      }
      await Bun.sleep(10);
    } while (Date.now() < deadline);
    if (!waitingLock) throw new Error("Concurrent identity lookup did not reach its lock barrier");
    continueWriter.resolve();
    const [writeResult, readResponse] = await Promise.all([writer, reader]);
    expect(writeResult.code).toBeNull();
    expect(writeResult.value?.id).toBe(identity.id);
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({ subjectId: identity.subjectId });
    expect(waitingLock).toBe("advisory");
  } finally {
    continueWriter.resolve();
    await Promise.all([writer, ...(reader ? [reader] : [])]);
  }
}, 30_000);

async function existingOnlyRequestFixture() {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Existing-only identity fixture') returning id`;
  if (!account) throw new Error("Account fixture missing");
  const accountId = String(account.id),
    token = crypto.randomUUID(),
    externalId = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId,
    name: "Existing-only request fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [...EXTERNAL_FIRST_USE_MEMBER_PERMISSIONS, "members:manage"],
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  app.on(["GET", "POST"], "/context", async (c) =>
    c.json(
      await requireAccessContext(c, {
        db: client.db,
        settings: testSettings({
          productAccessMode: "configured",
          externalMemberFirstUseEnabled: true,
        }),
      }),
    ),
  );
  app.get("/workspaces/:workspaceId", async (c) =>
    c.json(
      await requireAccessGrantAuthorization(
        c,
        {
          db: client.db,
          settings: testSettings({
            productAccessMode: "configured",
            externalMemberFirstUseEnabled: true,
          }),
        },
        c.req.param("workspaceId"),
        "workspace:read",
      ),
    ),
  );
  const read = (existingOnly = true, method = "GET", path = "/context") =>
    app.request(`http://example.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source: "existing-only-fixture", externalId },
            ...(existingOnly ? { existingOnly: true } : {}),
          }),
        ),
      },
    });
  const state = async () =>
    (
      await shared.admin`
    select (select count(*)::int from workspace_memberships where account_id=${accountId}) as "workspaceMemberships",
      (select count(*)::int from external_identities where account_id=${accountId}) as identities,
      (select count(*)::int from organization_memberships where account_id=${accountId}) as memberships,
      (select count(*)::int from workspaces where account_id=${accountId}) as workspaces,
      (select count(*)::int from workspace_inference_controls c join workspaces w on w.id=c.workspace_id where w.account_id=${accountId}) as controls,
      (select count(*)::int from agent_learning_revisions where account_id=${accountId}) as learning`
    )[0];
  return { accountId, externalId, read, state };
}

test("existing-only absent identity never provisions on GET or read-shaped POST", async () => {
  const fixture = await existingOnlyRequestFixture(),
    before = await fixture.state();
  for (const method of ["GET", "POST"]) {
    const response = await fixture.read(true, method);
    expect({ status: response.status, state: await fixture.state() }).toEqual({
      status: 403,
      state: before,
    });
  }
}, 30_000);

test("existing-only preserves an active identity and ordinary provisioning remains compatible", async () => {
  const fixture = await existingOnlyRequestFixture();
  expect((await fixture.read(false)).status).toBe(200);
  const before = await fixture.state();
  expect(before?.identities).toBe(1);
  const identity = await readExistingExternalIdentity(client.db, {
    accountId: fixture.accountId,
    source: "existing-only-fixture",
    externalId: fixture.externalId,
  });
  for (const method of ["GET", "POST"]) {
    const response = await fixture.read(true, method);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ subjectId: identity.subjectId });
    expect(await fixture.state()).toEqual(before);
  }
}, 30_000);

test("existing-only does not heal disabled identities or inactive organization memberships", async () => {
  for (const disabledIdentity of [true, false]) {
    const fixture = await existingOnlyRequestFixture();
    expect((await fixture.read(false)).status).toBe(200);
    if (disabledIdentity) {
      await shared.admin`update external_identities set status='disabled' where account_id=${fixture.accountId}`;
    } else {
      await shared.admin`update organization_memberships set status='suspended' where account_id=${fixture.accountId}`;
    }
    const before = await fixture.state();
    expect((await fixture.read()).status).toBe(403);
    expect(await fixture.state()).toEqual(before);
    const [status] = await shared.admin`
      select i.status as identity, m.status as membership from external_identities i
      join organization_memberships m on m.account_id=i.account_id and m.id=i.organization_membership_id
      where i.account_id=${fixture.accountId}`;
    expect(status).toEqual({
      // Native membership suspension also disables its external identity.
      identity: "disabled",
      membership: disabledIdentity ? "active" : "suspended",
    });
  }
}, 30_000);

test("existing-only rejects a foreign account tuple without provisioning", async () => {
  const fixture = await existingOnlyRequestFixture(),
    foreign = await existingOnlyRequestFixture();
  await ensureExternalIdentity(client.db, {
    accountId: foreign.accountId,
    source: "existing-only-fixture",
    externalId: fixture.externalId,
  });
  const before = await fixture.state();
  expect((await fixture.read()).status).toBe(403);
  expect(await fixture.state()).toEqual(before);
}, 30_000);

test("existing-only observes deletion committed while authentication waits on the lifecycle fence", async () => {
  const fixture = await existingOnlyRequestFixture();
  expect((await fixture.read(false)).status).toBe(200);
  const writerReady = Promise.withResolvers<number>(),
    releaseWriter = Promise.withResolvers<void>();
  const writer = shared.admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${"organization-membership:"} || ${fixture.accountId},0))`;
    const [backend] = await tx`select pg_backend_pid() as pid`;
    if (!backend) throw new Error("Writer backend missing");
    writerReady.resolve(Number(backend.pid));
    await releaseWriter.promise;
    await tx`delete from external_identities where account_id=${fixture.accountId}`;
  });
  let reader: Promise<Response> | undefined;
  try {
    const pid = await writerReady.promise;
    reader = fixture.read();
    let waiting = false;
    const deadline = Date.now() + 5_000;
    do {
      const [blocked] =
        await shared.admin`select 1 from pg_stat_activity where datname=current_database()
        and ${pid}=any(pg_blocking_pids(pid))`;
      if (blocked) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    } while (Date.now() < deadline);
    expect(waiting).toBe(true);
    releaseWriter.resolve();
    await writer;
    const afterDelete = await fixture.state();
    expect((await reader).status).toBe(403);
    expect(afterDelete?.identities).toBe(0);
    expect(await fixture.state()).toEqual(afterDelete);
  } finally {
    releaseWriter.resolve();
    await Promise.all([writer, ...(reader ? [reader] : [])]);
  }
}, 30_000);

test("existing-only resolver is EXECUTE-only with pinned definer metadata", async () => {
  const [posture] = await rawRows<{
    execute: boolean;
    tableAccess: boolean;
    definer: boolean;
    ownerMatches: boolean;
    publicExecute: boolean;
    searchPath: boolean;
  }>(
    client.db,
    sql`
    select has_function_privilege(current_user,p.oid,'EXECUTE') as execute,
      (has_table_privilege(current_user,'external_identities','SELECT') or
       has_table_privilege(current_user,'external_identities','INSERT') or
       has_table_privilege(current_user,'organization_memberships','SELECT')) as "tableAccess",
      p.prosecdef as definer,
      (p.proowner=(select relowner from pg_class where oid='external_identities'::regclass)
       and p.proowner=(select relowner from pg_class where oid='organization_memberships'::regclass)) as "ownerMatches",
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as "publicExecute",
      exists(select 1 from unnest(p.proconfig) c where c like 'search_path=%') as "searchPath"
      from pg_proc p where p.oid='read_existing_external_identity(uuid,text,text)'::regprocedure`,
  );
  expect(posture).toEqual({
    execute: true,
    tableAccess: false,
    definer: true,
    ownerMatches: true,
    publicExecute: false,
    searchPath: true,
  });
});

test("existing-only never triggers enabled first-use workspace membership provisioning", async () => {
  const fixture = await existingOnlyRequestFixture();
  expect((await fixture.read(false)).status).toBe(200);
  const workspace = await createWorkspace(client.db, {
    accountId: fixture.accountId,
    name: "Shared existing-only fixture",
  });
  const before = await fixture.state(),
    path = `/workspaces/${workspace.id}`;
  expect((await fixture.read(true, "GET", path)).status).toBe(403);
  expect(await fixture.state()).toEqual(before);
  // A positive control using the same deployed opt-in and credential proves
  // the restrictive actor flag, rather than missing key authority, prevented onboarding.
  expect((await fixture.read(false, "GET", path)).status).toBe(200);
  expect((await fixture.state())?.workspaceMemberships).toBe(
    (before?.workspaceMemberships ?? 0) + 1,
  );
}, 30_000);
