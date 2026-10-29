import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { OrganizationSessionPolicy } from "@opengeni/contracts/organization-session-policy";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createDb, rawRows, withAccountRls, type DbClient } from "../src/database";
import {
  bootstrapWorkspace,
  ensureGovernedOrganizationSessionPolicy,
  getOrganizationSessionPolicy,
  HOST_SESSION_POLICY_ROUTINE,
  nestedPostgresSqlState,
  putHostOrganizationSessionPolicy,
  recordOrganizationHostCommandAttribution,
  SessionPolicyOperationConflictError,
  SessionPolicyRevisionConflictError,
} from "../src/index";

/*
 * Migration 1018's write boundary, as the runtime role under FORCE RLS: the
 * runtime may read a policy and insert exactly the governed default; it can
 * never widen, update or delete one, nor touch the receipts. A host's policy
 * goes through the routine (granted by 1019), only for a recorded host command.
 */

// The documented posture: a NOSUPERUSER, NOBYPASSRLS migration owner (which
// owns the routine), a dedicated data schema and the restricted runtime role,
// all under FORCE RLS.
let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase(
    "organization-session-policies",
    "policy_data",
  );
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2, searchPath: shared.schema });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const SERVICE_SUBJECT = "test-host:provisioner";

async function organization(governed = false): Promise<string> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test-host:tenant",
    accountExternalId: `policies-${suffix}`,
    accountName: "Policies",
    workspaceExternalSource: "test",
    workspaceExternalId: `policies-${suffix}`,
    workspaceName: "Policies",
    subjectId: `${SERVICE_SUBJECT}:${suffix}`,
    ...(governed ? { governedSessionPolicy: true } : {}),
  });
  return access.workspaceGrants[0]!.accountId;
}

async function runtimeStatement(organizationId: string, statement: ReturnType<typeof sql>) {
  try {
    await withAccountRls(client.db, organizationId, (scoped) => rawRows(scoped, statement));
    return "ok";
  } catch (error) {
    return nestedPostgresSqlState(error);
  }
}

const OPEN: OrganizationSessionPolicy = {
  attachments: "enabled",
  toolFamilies: { mode: "deny", families: [] },
};

describe("the runtime's direct access", () => {
  test("bootstrapWorkspace stores the governed default when asked, and nothing otherwise", async () => {
    const governed = await organization(true);
    expect(await getOrganizationSessionPolicy(client.db, governed)).toMatchObject({
      source: "governed_default",
      revision: 1,
      policy: { attachments: "disabled", toolFamilies: { mode: "deny" } },
    });
    const stock = await organization();
    expect(await getOrganizationSessionPolicy(client.db, stock)).toBeNull();
  });

  test("the runtime may insert only the governed default", async () => {
    const id = await organization();
    expect(
      await runtimeStatement(
        id,
        sql`insert into organization_session_policies
            (account_id, attachments, tool_family_mode, tool_families, source)
          values (${id}::uuid, 'enabled', 'deny', '{}'::text[], 'governed_default')`,
      ),
    ).toBe("42501");
    expect(
      await runtimeStatement(
        id,
        sql`insert into organization_session_policies
            (account_id, attachments, tool_family_mode, tool_families, source, revision,
             last_operation_id)
          values (${id}::uuid, 'enabled', 'deny', '{}'::text[], 'host', 2, ${crypto.randomUUID()}::uuid)`,
      ),
    ).toBe("42501");
    expect(await getOrganizationSessionPolicy(client.db, id)).toBeNull();
    await ensureGovernedOrganizationSessionPolicy(client.db, id);
    expect((await getOrganizationSessionPolicy(client.db, id))?.source).toBe("governed_default");
  });

  test("the runtime's governed default cannot name recordings (1023)", async () => {
    const id = await organization();
    for (const recordings of ["allowed", "denied"]) {
      expect(
        await runtimeStatement(
          id,
          sql`insert into organization_session_policies
              (account_id, attachments, tool_family_mode, tool_families, source, recordings)
            values (${id}::uuid, 'disabled', 'deny',
              array['shell', 'codemode', 'browser', 'computerUse']::text[], 'governed_default',
              ${recordings})`,
        ),
      ).toBe("42501");
    }
    expect(await getOrganizationSessionPolicy(client.db, id)).toBeNull();
    await ensureGovernedOrganizationSessionPolicy(client.db, id);
    const stored = await getOrganizationSessionPolicy(client.db, id);
    expect(stored?.source).toBe("governed_default");
    expect(stored?.policy.recordings).toBeUndefined();
  });

  test("the runtime can neither update nor delete a policy, nor read the receipts", async () => {
    const id = await organization(true);
    expect(
      await runtimeStatement(
        id,
        sql`update organization_session_policies set attachments = 'enabled'
          where account_id = ${id}::uuid`,
      ),
    ).toBe("42501");
    expect(
      await runtimeStatement(
        id,
        sql`delete from organization_session_policies where account_id = ${id}::uuid`,
      ),
    ).toBe("42501");
    expect(
      await runtimeStatement(id, sql`select * from organization_session_policy_receipts`),
    ).toBe("42501");
    expect((await getOrganizationSessionPolicy(client.db, id))?.policy.attachments).toBe(
      "disabled",
    );
  });
});

describe("the host's routine", () => {
  test("is granted to the runtime by 1019", async () => {
    // It runs as a migration owner that FORCE RLS binds.
    const [owner] = await shared.admin<{ bypass: boolean }[]>`
      select role.rolbypassrls as bypass from pg_proc proc
      join pg_roles role on role.oid = proc.proowner
      where proc.proname = 'put_host_organization_session_policy'`;
    expect(owner?.bypass).toBe(false);
    const [row] = await rawRows<{ granted: boolean | null }>(
      client.db,
      sql`select has_function_privilege(
        to_regprocedure(${HOST_SESSION_POLICY_ROUTINE})::oid, 'EXECUTE') as granted`,
    );
    expect(row?.granted).toBe(true);
  });

  test("writes only for a recorded host command, replays by body and refuses stale revisions", async () => {
    const id = await organization(true);
    const operationId = crypto.randomUUID();
    const input = { organizationId: id, subjectId: SERVICE_SUBJECT, operationId, policy: OPEN };
    await expect(
      putHostOrganizationSessionPolicy(client.db, { ...input, expectedRevision: 0 }),
    ).rejects.toThrow();
    await recordOrganizationHostCommandAttribution(client.db, {
      organizationId: id,
      operationId,
      mutation: "session_policy.update",
      serviceSubjectId: SERVICE_SUBJECT,
      serviceInitiatorSubjectId: "test-host:governance",
      actingExternalUser: { source: "test-host:user", externalId: "staff-1" },
    });
    // Another subject cannot use this subject's attribution.
    await expect(
      putHostOrganizationSessionPolicy(client.db, {
        ...input,
        subjectId: "test-host:someone-else",
        expectedRevision: 0,
      }),
    ).rejects.toThrow();
    const written = await putHostOrganizationSessionPolicy(client.db, {
      ...input,
      expectedRevision: 0,
    });
    expect(written).toMatchObject({ replay: false, stored: { source: "host", revision: 2 } });
    expect(
      await putHostOrganizationSessionPolicy(client.db, { ...input, expectedRevision: 0 }),
    ).toMatchObject({ replay: true, stored: { revision: 2 } });
    await expect(
      putHostOrganizationSessionPolicy(client.db, {
        ...input,
        policy: { ...OPEN, attachments: "disabled" },
        expectedRevision: 2,
      }),
    ).rejects.toBeInstanceOf(SessionPolicyOperationConflictError);
    const later = crypto.randomUUID();
    await recordOrganizationHostCommandAttribution(client.db, {
      organizationId: id,
      operationId: later,
      mutation: "session_policy.update",
      serviceSubjectId: SERVICE_SUBJECT,
      serviceInitiatorSubjectId: "test-host:governance",
      actingExternalUser: { source: "test-host:user", externalId: "staff-1" },
    });
    await expect(
      putHostOrganizationSessionPolicy(client.db, {
        ...input,
        operationId: later,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(SessionPolicyRevisionConflictError);
    expect((await getOrganizationSessionPolicy(client.db, id))?.revision).toBe(2);
  });
});

describe("the host routine racing the runtime's default", () => {
  test("a default stored at the same moment never makes the host write fail", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = await organization();
      const operationId = crypto.randomUUID();
      await recordOrganizationHostCommandAttribution(client.db, {
        organizationId: id,
        operationId,
        mutation: "session_policy.update",
        serviceSubjectId: SERVICE_SUBJECT,
        serviceInitiatorSubjectId: "test-host:governance",
        actingExternalUser: { source: "test-host:user", externalId: "staff-1" },
      });
      const [, written] = await Promise.all([
        ensureGovernedOrganizationSessionPolicy(client.db, id).catch(() => null),
        putHostOrganizationSessionPolicy(client.db, {
          organizationId: id,
          subjectId: SERVICE_SUBJECT,
          operationId,
          policy: OPEN,
          expectedRevision: 0,
        }),
      ]);
      expect(written).toMatchObject({ replay: false, stored: { source: "host", revision: 2 } });
    }
  });
});

describe("1018's backfill", () => {
  test("stores the default, once, for organizations that already ran a host command", async () => {
    const commanded = await organization();
    const untouched = await organization();
    await recordOrganizationHostCommandAttribution(client.db, {
      organizationId: commanded,
      operationId: crypto.randomUUID(),
      mutation: "invitation.create",
      serviceSubjectId: SERVICE_SUBJECT,
      serviceInitiatorSubjectId: "test-host:governance",
      actingExternalUser: { source: "test-host:user", externalId: "staff-1" },
    });
    const migration = readFileSync(
      new URL("../drizzle/1018_organization_session_policies.sql", import.meta.url),
      "utf8",
    );
    const backfill = migration.split("-- backfill:begin")[1]!.split("-- backfill:end")[0]!;
    for (let run = 0; run < 2; run += 1) {
      await shared.admin.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${shared.schema}", public`);
        await tx.unsafe(backfill);
      });
    }
    expect(await getOrganizationSessionPolicy(client.db, commanded)).toMatchObject({
      source: "governed_default",
      revision: 1,
      policy: { attachments: "disabled" },
    });
    expect(await getOrganizationSessionPolicy(client.db, untouched)).toBeNull();
    // FORCE RLS is back on the attributions table.
    const [attributions] = await shared.admin<{ forced: boolean }[]>`
      select relforcerowsecurity as forced from pg_class
      where oid = ${`"${shared.schema}".organization_host_command_attributions`}::regclass`;
    expect(attributions?.forced).toBe(true);
  });
});
