import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "../src";

// Cendra fork (1011). With first-use membership off, every request from a
// product's own user resolves its identity through the existing-only
// read_existing_external_identity (1005), which fences the identity's
// organization membership. Like upstream's 0925 fences it must use FOR NO KEY
// UPDATE: a FOR UPDATE fence and a turn re-checking its session owner key
// (FOR KEY SHARE on the membership) deadlock (40P01).
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("existing-external-identity-key-checks");
  if (!acquired) throw new Error("membership fence tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("the existing-only identity fence and a repeated session write do not deadlock", async () => {
  const [account] = await shared.admin<Array<{ id: string }>>`
    insert into managed_accounts (name) values ('Membership fence fixture') returning id`;
  const accountId = String(account!.id);
  const source = "example:instance";
  const externalId = crypto.randomUUID();
  const identity = await ensureExternalIdentity(client.db, { accountId, source, externalId });
  const team = await createWorkspace(client.db, { accountId, name: "Team workspace" });
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${team.id}, ${identity.subjectId}, 'member',
      opengeni_private.workspace_member_role_permissions('member'))`;
  await shared.admin`
    insert into session_tenancy_activations
      (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'membership-fence-test')`;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: team.id,
    initialMessage: "membership fence",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: identity.subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [owned] = await shared.admin<Array<{ owner: string | null }>>`
    select owner_organization_membership_id as "owner" from sessions where id = ${session.id}`;
  expect(owned?.owner).toBe(identity.organizationMembershipId);

  const writer = postgres(shared.adminUrl, { max: 1 });
  const fence = postgres(shared.adminUrl, { max: 1 });
  try {
    const [fenceBackend] = await fence<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
    const fencePid = fenceBackend!.pid;
    let releaseWriter!: () => void;
    const writerMayContinue = new Promise<void>((resolve) => (releaseWriter = resolve));
    let writerHoldsSession!: () => void;
    const writerHoldsSessionRow = new Promise<void>((resolve) => (writerHoldsSession = resolve));

    // A turn transition: write the session row, then write it again.
    const writing = writer.begin(async (tx) => {
      await tx`set local lock_timeout = '15s'`;
      await tx`update sessions set updated_at = clock_timestamp() where id = ${session.id}`;
      writerHoldsSession();
      await writerMayContinue;
      await tx`update sessions set updated_at = clock_timestamp() where id = ${session.id}`;
    });
    await writerHoldsSessionRow;

    // An external request: fence the identity's membership, then write the
    // same session. It waits for the writer's session row lock.
    const fencing = fence.begin(async (tx) => {
      await tx`set local lock_timeout = '15s'`;
      await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
      await tx`select read_existing_external_identity(${accountId}::uuid, ${source}, ${externalId})`;
      await tx`update sessions set updated_at = clock_timestamp() where id = ${session.id}`;
    });
    for (let attempt = 0; ; attempt += 1) {
      const [waiting] = await shared.admin<Array<{ waiting: boolean }>>`
        select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${fencePid}`;
      if (waiting?.waiting) break;
      if (attempt > 200) throw new Error("the fencing transaction never reached the session row");
      await Bun.sleep(25);
    }

    // The writer's second update re-checks the owner key while the fence holds
    // the membership. Both transactions must commit.
    releaseWriter();
    const outcomes = await Promise.allSettled([writing, fencing]);
    expect(
      outcomes.map((outcome) =>
        outcome.status === "fulfilled"
          ? "committed"
          : `${(outcome.reason as { code?: string }).code ?? ""} ${String(outcome.reason)}`,
      ),
    ).toEqual(["committed", "committed"]);
  } finally {
    await writer.end();
    await fence.end();
  }
}, 120_000);

test("the existing-only identity fence locks the membership row FOR NO KEY UPDATE", async () => {
  const rows = await shared.admin<Array<{ fence: boolean; blocks: boolean }>>`
    select
      p.prosrc ~* 'from\\s+organization_memberships\\M[^;]*\\mfor\\s+no\\s+key\\s+update\\M' as "fence",
      p.prosrc ~* 'from\\s+organization_memberships\\M[^;]*\\mfor\\s+update\\M' as "blocks"
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'read_existing_external_identity'`;
  expect(rows.map((row) => ({ fence: row.fence, blocks: row.blocks }))).toEqual([
    { fence: true, blocks: false },
  ]);
});
