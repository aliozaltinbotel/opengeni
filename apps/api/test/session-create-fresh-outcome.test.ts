import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  CreateSessionResponse,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  Session,
  signDelegatedAccessToken,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import { resolveSessionAgentConfigForCreate, type SessionWorkflowClient } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  getActiveSessionHistoryItemsPaged,
  persistModelCallSourceReceipt,
  getOrCreateCompanyProfileSnapshot,
  getOrCreateWorkspaceInstructionPolicySnapshot,
  getOrCreatePreferenceRegistrySnapshot,
  withSessionRlsActorContext,
  createDb,
  createSessionWithIdempotencyKeyResult,
  getSession,
} from "@opengeni/db";
import { OpenGeniClient } from "@opengeni/sdk";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createApp } from "../src/app";

const secret = "session-create-fresh-outcome-test-secret";
const legacyRoot = process.env.OPENGENI_SESSION_CREATE_LEGACY_ROOT;
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let server: ReturnType<typeof Bun.serve>;
let appRole: string;
let appSettings: ReturnType<typeof testSettings>;

beforeAll(async () => {
  const appUrl = process.env.OPENGENI_SESSION_CREATE_TEST_APP_URL;
  const adminUrl = process.env.OPENGENI_SESSION_CREATE_TEST_ADMIN_URL;
  if (appUrl && adminUrl) {
    // The caller owns this exact disposable clone and its runtime role. Never
    // print either URL or mutate a shared source database/role.
    const admin = postgres(adminUrl, { max: 2 });
    shared = { appUrl, adminUrl, admin, release: () => admin.end() };
  } else {
    const database = await acquireSharedTestDatabase("session-create-fresh-outcome");
    if (!database) throw new Error("Session create outcome verification requires PostgreSQL");
    shared = database;
  }
  client = createDb(shared.appUrl, { max: 8 });
  appRole = decodeURIComponent(new URL(shared.appUrl).username);
  const noop = async () => undefined;
  appSettings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "managed",
    delegationSecret: secret,
    sandboxBackend: "none",
    // Exercise the production API-contract fence, not its test bypass.
    environment: "development",
  });
  const app = createApp({
    settings: appSettings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
      startRigVerification: noop,
    } satisfies SessionWorkflowClient,
  });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, fetch: app.fetch });
}, 180_000);

afterAll(async () => {
  await server?.stop(true);
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-create-fresh-outcome",
    accountExternalId: id,
    accountName: "Session creation verification",
    workspaceExternalSource: "session-create-fresh-outcome",
    workspaceExternalId: id,
    workspaceName: "Session creation verification",
    subjectId: `create-outcome:${id}`,
  });
  const grant = access.workspaceGrants[0]!;
  const request = {
    initialMessage: "Verify committed session creation",
    model: "scripted-model",
    sandboxBackend: "none" as const,
    requestedSessionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  };
  return { grant, request };
}

async function bearer(grant: AccessGrant, permissions: Permission[] = grant.permissions) {
  return `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    principalKind: "human_session",
    permissions,
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`;
}

async function post(
  grant: AccessGrant,
  payload: unknown,
  options: { permissions?: Permission[]; workspaceId?: string; signal?: AbortSignal } = {},
) {
  return fetch(`${server.url}v1/workspaces/${options.workspaceId ?? grant.workspaceId}/sessions`, {
    method: "POST",
    headers: {
      authorization: await bearer(grant, options.permissions),
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    },
    body: JSON.stringify(payload),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function counts(workspaceId: string, key: string) {
  const [row] = await shared.admin<{ sessions: number; turns: number }[]>`
    select count(*)::int as sessions,
      (select count(*)::int from session_turns t join sessions s on t.session_id = s.id
        where s.workspace_id = ${workspaceId} and s.create_idempotency_key = ${key}) as turns
    from sessions where workspace_id = ${workspaceId} and create_idempotency_key = ${key}`;
  return row!;
}

async function waitUntil(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(description);
}

describe("REST committed fresh session outcome (real PostgreSQL, real API composition)", () => {
  test("new creation returns true only with a committed scoped birth and tolerates legacy consumers", async () => {
    const [role] = await shared.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = ${appRole}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [table] = await shared.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class where oid = 'sessions'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const { grant, request } = await fixture();
    const response = await post(grant, request);
    expect(response.status).toBe(202);
    expect(response.headers.get(OPENGENI_API_CONTRACT_HEADER)).toBe(OPENGENI_API_CONTRACT_REVISION);
    const body = await response.json();
    expect(body.freshCreated).toBe(true);
    expect(body.id).toBe(request.requestedSessionId);
    const parsed = CreateSessionResponse.parse(body);
    expect(parsed.freshCreated).toBe(true);
    const stored = await getSession(client.db, grant.workspaceId, body.id);
    expect(stored).not.toBeNull();
    expect(stored!.accountId).toBe(grant.accountId);
    expect(stored!.workspaceId).toBe(grant.workspaceId);
    expect(stored!.createdBy).toMatchObject({ kind: "subject", subjectId: grant.subjectId });
    expect(stored!.createdAt).toBe(body.createdAt);
    expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
      sessions: 1,
      turns: 1,
    });
    expect(Session.parse(body).id).toBe(body.id);
    const { freshCreated: _freshCreated, ...legacy } = body;
    expect(CreateSessionResponse.parse(legacy).freshCreated).toBeUndefined();
    expect(CreateSessionResponse.safeParse({ ...body, freshCreated: "true" }).success).toBe(false);
  });

  test("keyed SDK retry returns false and preserves the committed entity and turn", async () => {
    const { grant, request } = await fixture();
    const sdk = new OpenGeniClient({
      baseUrl: String(server.url),
      apiKey: (await bearer(grant)).slice(7),
    });
    const created = await sdk.createSession(grant.workspaceId, request);
    expect(created.freshCreated).toBe(true);
    const replay = await sdk.createSession(grant.workspaceId, request);
    expect(replay.freshCreated).toBe(false);
    expect(replay.id).toBe(created.id);
    expect(replay.initialTurnId).toBe(created.initialTurnId);
    expect(replay.createdAt).toBe(created.createdAt);
    expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
      sessions: 1,
      turns: 1,
    });
  });

  test.skipIf(!legacyRoot)(
    "clean production SDK and response schema tolerate the additive field",
    async () => {
      const legacyRequire = createRequire(`${legacyRoot}/package.json`);
      const {
        OpenGeniClient: LegacyClient,
      }: Pick<typeof import("@opengeni/sdk"), "OpenGeniClient"> = await import(
        legacyRequire.resolve("@opengeni/sdk")
      );
      const {
        CreateSessionResponse: LegacyResponse,
      }: Pick<typeof import("@opengeni/contracts"), "CreateSessionResponse"> = await import(
        legacyRequire.resolve("@opengeni/contracts")
      );
      const { grant, request } = await fixture();
      const sdk = new LegacyClient({
        baseUrl: String(server.url),
        apiKey: (await bearer(grant)).slice(7),
      });
      const created = await sdk.createSession(grant.workspaceId, request);
      expect(created.freshCreated).toBe(true);
      expect(LegacyResponse.parse(created).id).toBe(created.id);
      const replay = await sdk.createSession(grant.workspaceId, request);
      expect(replay.freshCreated).toBe(false);
      expect(LegacyResponse.parse(replay).id).toBe(created.id);
      expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
        sessions: 1,
        turns: 1,
      });
    },
  );

  test("concurrent requests have one committed fresh winner and false replay losers", async () => {
    const { grant, request } = await fixture();
    const responses = await Promise.all(Array.from({ length: 6 }, () => post(grant, request)));
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(202));
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.filter((body) => body.freshCreated === true)).toHaveLength(1);
    expect(bodies.filter((body) => body.freshCreated === false)).toHaveLength(5);
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.initialTurnId)).size).toBe(1);
    expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
      sessions: 1,
      turns: 1,
    });
  }, 60_000);

  test("repairing an existing keyed birth returns false even when start state changes", async () => {
    const { grant, request } = await fixture();
    // The keyed birth mirrors what this API writes for the same request, including the agent
    // configuration it freezes at creation (upstream 0559); a differing configuration is a
    // different request by design, not a repair.
    const [workspace] = await shared.admin<{ settings: unknown }[]>`
      select settings from workspaces where id = ${grant.workspaceId}`;
    const agentConfig = resolveSessionAgentConfigForCreate({
      settings: appSettings,
      creator: "api",
      request: undefined,
      instructions: undefined,
      workspaceSettings: workspace?.settings ?? {},
      parent: null,
      goal: false,
    }).config;
    const existing = await createSessionWithIdempotencyKeyResult(client.db, {
      agentConfig,
      requestedSessionId: request.requestedSessionId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createIdempotencyKey: request.idempotencyKey,
      initialMessage: request.initialMessage,
      resources: [],
      metadata: {},
      model: request.model,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: grant.subjectId, label: grant.subjectId },
      subjectId: grant.subjectId,
    });
    expect(existing.created).toBe(true);
    expect(existing.denied).toBe(false);
    if (existing.denied) throw new Error("Existing birth was denied");
    expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
      sessions: 1,
      turns: 0,
    });
    const response = await post(grant, request);
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.id).toBe(existing.session.id);
    expect(body.freshCreated).toBe(false);
    expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
      sessions: 1,
      turns: 1,
    });
  });

  test("authorization, foreign scope, invalid input and forged freshness cannot mint true", async () => {
    const { grant, request } = await fixture();
    const foreign = await fixture();
    for (const options of [
      { permissions: ["sessions:read"] as Permission[] },
      { workspaceId: foreign.grant.workspaceId },
    ]) {
      const response = await post(grant, request, options);
      expect(response.status).toBe(403);
      expect((await response.json()).freshCreated).toBeUndefined();
    }
    const malformed = await post(grant, { ...request, initialMessage: {} });
    expect(malformed.status).toBe(422);
    expect((await malformed.json()).freshCreated).toBeUndefined();
    expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
      sessions: 0,
      turns: 0,
    });
    const created = await post(grant, request);
    expect(created.status).toBe(202);
    await created.body?.cancel();
    const forged = await post(grant, { ...request, freshCreated: true });
    // A request cannot turn an existing birth into a new one, regardless of
    // whether the compatible request parser ignores or rejects this unknown key.
    const body = await forged.json();
    expect(body.freshCreated).not.toBe(true);
    expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
      sessions: 1,
      turns: 1,
    });
  });

  test("database rejection before commit returns no fresh claim or birth", async () => {
    const { grant, request } = await fixture();
    await shared.admin
      .unsafe(`create function public.fresh_outcome_reject() returns trigger language plpgsql as $$
      begin if new.workspace_id = '${grant.workspaceId}'::uuid then raise exception 'synthetic create rejection'; end if;
      return new; end $$`);
    await shared.admin`create trigger fresh_outcome_reject before insert on sessions for each row execute function public.fresh_outcome_reject()`;
    try {
      const response = await post(grant, request);
      expect(response.status).toBe(500);
      expect((await response.json()).freshCreated).toBeUndefined();
      expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
        sessions: 0,
        turns: 0,
      });
    } finally {
      await shared.admin`drop trigger fresh_outcome_reject on sessions`;
      await shared.admin`drop function public.fresh_outcome_reject()`;
    }
  });

  test("post-commit projection dependency failure returns no claim and reconciled retry is false", async () => {
    const { grant, request } = await fixture();
    await shared.admin
      .unsafe(`create function public.fresh_outcome_projection_failure() returns trigger language plpgsql security definer as $$
      begin if new.workspace_id = '${grant.workspaceId}'::uuid then revoke select on workspaces from opengeni_app; end if;
      return new; end $$`);
    await shared.admin`create trigger fresh_outcome_projection_failure after insert on usage_events for each row execute function public.fresh_outcome_projection_failure()`;
    try {
      const response = await post(grant, request);
      expect(response.status).toBe(500);
      expect((await response.json()).freshCreated).toBeUndefined();
      expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
        sessions: 1,
        turns: 1,
      });
    } finally {
      await shared.admin`grant select on workspaces to opengeni_app`;
      await shared.admin`drop trigger fresh_outcome_projection_failure on usage_events`;
      await shared.admin`drop function public.fresh_outcome_projection_failure()`;
    }
    const replay = await post(grant, request);
    expect(replay.status).toBe(202);
    expect((await replay.json()).freshCreated).toBe(false);
  });

  test("cancelled HTTP observation grants no freshness; committed unknown outcome replays false", async () => {
    const { grant, request } = await fixture();
    let release!: () => void;
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = shared.admin.begin(async (tx) => {
      await tx`select id from workspaces where id = ${grant.workspaceId} for update`;
      locked();
      await releasePromise;
    });
    const abort = new AbortController();
    let pending: Promise<Response> | undefined;
    try {
      await lockedPromise;
      pending = post(grant, request, { signal: abort.signal });
      pending.catch(() => undefined);
      await waitUntil(async () => {
        const rows = await shared.admin<{ blocked: boolean }[]>`
          select exists(select 1 from pg_stat_activity where datname = current_database()
            and usename = ${appRole} and wait_event_type = 'Lock') as blocked`;
        return rows[0]!.blocked;
      }, "Create did not reach the database fence");
      abort.abort(new Error("synthetic cancelled observation"));
      await expect(pending).rejects.toThrow("synthetic cancelled observation");
    } finally {
      abort.abort();
      release();
      await blocker;
    }
    // Transport cancellation supplies no birth evidence. Reconcile storage
    // before repeating the exact key; the API may have committed after abort.
    await waitUntil(
      async () => (await counts(grant.workspaceId, request.idempotencyKey)).turns === 1,
      "Cancelled observation did not settle its accepted session start",
    );
    const replay = await post(grant, request);
    expect(replay.status).toBe(202);
    expect((await replay.json()).freshCreated).toBe(false);
    expect(await counts(grant.workspaceId, request.idempotencyKey)).toEqual({
      sessions: 1,
      turns: 1,
    });
  }, 60_000);
});


test("public host message origins survive create/send/steer into exact first-call receipt", async () => {
  for(const mode of ["create","send","steer"] as const) {
    const {grant,request}=await fixture();
    const refs=[{owner:"cendra.knowledge.retrieval_use",id:crypto.randomUUID(),sha256:"a".repeat(64),version:"1"}];
    const createPayload=mode==="create"
      ? {...request,initialMessageModelSourceRefs:refs,modelContext:"Selected document passage"}
      : {...request,initialMessage:undefined,startMode:"realtime"};
    const created=await post(grant,createPayload);
    expect(created.status).toBe(202);
    const session=await created.json();
    if(mode==="create") {
      expect((await post(grant,createPayload)).status).toBe(202);
      expect((await post(grant,{...createPayload,initialMessageModelSourceRefs:[]})).status).toBe(409);
      expect((await post(grant,{...createPayload,initialMessage:"Altered passage"})).status).toBe(409);
    } else {
      const eventId=crypto.randomUUID();
      const payload={text:"Selected host passage",modelContext:"Selected document context",messageModelSourceRefs:refs,clientEventId:eventId};
      // Keep the bearer in memory and use the real authenticated HTTP boundary.
      const auth=await bearer(grant);
      const submit=async(body:typeof payload)=>fetch(`${server.url}v1/workspaces/${grant.workspaceId}/sessions/${session.id}/${mode==="send"?"events":"steer"}`,{
        method:"POST",headers:{authorization:auth,"content-type":"application/json",[OPENGENI_API_CONTRACT_HEADER]:OPENGENI_API_CONTRACT_REVISION},
        body:JSON.stringify(mode==="send"?{type:"user.message",clientEventId:eventId,payload:{text:body.text,modelContext:body.modelContext,messageModelSourceRefs:body.messageModelSourceRefs}}:body),
      });
      const accepted=await submit(payload);expect(accepted.ok).toBe(true);
      expect((await submit(payload)).ok).toBe(true);
      expect((await submit({...payload,messageModelSourceRefs:[]})).status).toBe(409);
    }
    const attemptId=crypto.randomUUID();
    const claim=await claimSessionWorkForAttempt(client.db,grant.workspaceId,{sessionId:session.id,workflowId:`session-${session.id}`,workflowRunId:crypto.randomUUID(),attemptId,dispatchId:crypto.randomUUID(),trigger:{kind:"next"}});
    expect(claim.action).toBe("claimed");if(claim.action!=="claimed")throw Error("Attributed turn claim refused");
    const rows=await getActiveSessionHistoryItemsPaged(client.db,grant.workspaceId,session.id);
    const [attributed]=await shared.admin`select source_basis from session_history_items where account_id=${grant.accountId} and workspace_id=${grant.workspaceId} and session_id=${session.id} and turn_id=${claim.turn.id}`;
    expect(attributed?.source_basis?.retainedSources).toEqual(refs);
    const [event]=await shared.admin`select payload from session_events where id=${claim.turn.triggerEventId} and workspace_id=${grant.workspaceId}`;
    expect(event!.payload.messageModelSourceRefs).toEqual(refs);
    const identity={accountId:grant.accountId,workspaceId:grant.workspaceId,sessionId:session.id,turnId:claim.turn.id,attemptId,executionGeneration:claim.turn.executionGeneration,sourceKey:crypto.randomUUID(),requestIndex:1};
    const instructionSelections=await withSessionRlsActorContext({subjectId:"worker:message-source-test",initiatingHumanSubjectId:grant.subjectId},async()=>({
      companyProfileSnapshotId:(await getOrCreateCompanyProfileSnapshot(client.db,identity)).id,
      instructionPolicySnapshotId:(await getOrCreateWorkspaceInstructionPolicySnapshot(client.db,identity)).id,
      preferenceSnapshotId:(await getOrCreatePreferenceRegistrySnapshot(client.db,identity)).id,
    }));
    const receipt=await persistModelCallSourceReceipt(client.db,identity,{instructions:"Synthetic source verification",input:rows.map(row=>row.item),instructionSelections});
    expect(receipt.incompleteReasons).toEqual([]);
    expect(receipt.complete).toBe(true);
    expect(receipt.inputs.flatMap(node=>node.retainedSources)).toContainEqual(refs[0]!);
    const title=await persistModelCallSourceReceipt(client.db,{...identity,sourceKey:crypto.randomUUID(),requestIndex:2},{instructions:"Generate a short title",input:["Selected host passage"],purpose:"TITLE",instructionSelections});
    expect(title.incompleteReasons).toEqual([]);
    expect(title.inputs.flatMap(node=>node.retainedSources)).toContainEqual(refs[0]!);
  }
},120_000);
