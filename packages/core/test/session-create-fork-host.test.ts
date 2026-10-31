import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDb,
  getSession,
  listSessionsForSubject,
  settleHostSessionCreate,
  setSessionArchive,
  SessionArchiveVersionConflictError,
  createSession,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createAndStartSessionWithOutcome } from "../src/domain/sessions";
import { SessionAuthorizationUnavailableError } from "../src/session-authorization";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import { forkManagedHumanSession } from "../src/application/session-tenancy";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const lease = await acquireSharedTestDatabase("session-create-fork-host");
  if (!lease) throw new Error("PostgreSQL unavailable");
  shared = lease;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
test("a fork commits pending admission with its inherited tools and gates the first append", async () => {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Host fork",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${grant.accountId},1,${"0".repeat(64)},${"1".repeat(64)},'host-test')`;
  const source = await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
    createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "hello",
      resources: [],
      tools: [{ kind: "mcp", id: "inherited", eager: true }],
      toolPolicy: {
        mode: "explicit",
        inheritedFromSessionId: null,
        hostRequiredMcpServerIds: ["inherited"],
      },
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: grant.subjectId },
    }),
  );
  await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
    initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: source.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    }),
  );
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    (tx) =>
      mutateSessionControlInTransaction(tx, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: source.id,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        action: "cancel",
      }),
  );
  const [sourceTurn] = await shared.admin<
    { id: string }[]
  >`select id from session_turns where session_id=${source.id} limit 1`;
  await shared.admin`insert into session_history_items(account_id,workspace_id,session_id,turn_id,position,item) values(${grant.accountId},${grant.workspaceId},${source.id},${sourceTurn!.id},1,${shared.admin.json({ type: "message", role: "user", content: "retained source history" })})`;
  let hooked = false;
  const result = await forkManagedHumanSession(
    {
      db: client.db,
      bus: new MemoryEventBus(),
      settings: testSettings({
        mcpServers: [
          {
            id: "added",
            url: "https://added.example/mcp",
            cacheToolsList: false,
            visibility: "internal",
          },
        ],
      }),
      sessionAuthorization: {
        authorizeSession: async () => ({ allowed: true }),
        resolveListScope: async () => ({ kind: "all" }),
        authorizeSessionCreate: async () => ({
          allowed: true,
          requiredToolServers: [{ id: "added" }],
        }),
        sessionCreated: async (input) => {
          hooked = true;
          const [row] = await shared.admin<
            { state: string; ids: string[]; turns: number }[]
          >`select host_session_create_state as state,tool_policy->'hostRequiredMcpServerIds' as ids,(select count(*)::int from session_turns t where t.session_id=s.id) as turns from sessions s where id=${input.sessionId}`;
          expect(row).toEqual({ state: "pending", ids: ["inherited", "added"], turns: 0 });
          expect(input.rootSessionId).toBe(input.sessionId);
        },
      },
    },
    {
      grant,
      accountGrant: access.accountGrants[0] ?? null,
      authenticatedSubjectId: grant.subjectId,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    },
    grant.workspaceId,
    source.id,
    {
      idempotencyKey: crypto.randomUUID(),
      visibility: "workspace",
      workspaceSharedAcknowledged: true,
    },
  );
  expect(hooked).toBe(true);
  expect(result.copiedHistoryItemCount).toBeGreaterThan(0);
  const [row] = await shared.admin<
    { state: string }[]
  >`select host_session_create_state as state from sessions where id=${result.sessionId}`;
  expect(row?.state).toBe("ready");
});

test("a failed child callback stays globally closed and reports the real task root", async () => {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Host child",
  });
  const grant = access.workspaceGrants[0]!;
  const parent = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "parent",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
  });
  let childId = "";
  await expect(
    createAndStartSessionWithOutcome({
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: { wakeSessionWorkflow: async () => undefined },
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      parentSessionId: parent.id,
      initialMessage: "child",
      resources: [],
      tools: [],
      toolPolicy: { mode: "inherited", inheritedFromSessionId: parent.id },
      model: "scripted-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      turnExecutionPolicy: resolveTurnExecutionPolicyV1(testSettings(), {
        modelId: "scripted-model",
        requestedModelId: "scripted-model",
        modelSource: "explicit",
        reasoningEffort: "medium",
        reasoningSource: "explicit",
        latencyMode: "standard",
        latencyModeSource: "deployment",
      }),
      metadata: {},
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      sessionCreateHost: {
        actor: { kind: "subject", subjectId: grant.subjectId },
        configuredServers: [],
        port: {
          authorizeSession: async () => ({ allowed: true }),
          resolveListScope: async () => ({ kind: "all" }),
          authorizeSessionCreate: async () => ({ allowed: true }),
          sessionCreated: async (input) => {
            childId = input.sessionId;
            expect(input.rootSessionId).toBe(parent.id);
            throw new Error("host refused child binding");
          },
        },
      },
    }),
  ).rejects.toBeInstanceOf(SessionAuthorizationUnavailableError);
  const [row] = await shared.admin<
    { state: string; turns: number; archives: number }[]
  >`select s.host_session_create_state as state,(select count(*)::int from session_turns t where t.session_id=s.id) as turns,(select count(*)::int from session_pins p where p.session_id=s.id and p.archived) as archives from sessions s where s.id=${childId}`;
  expect(row).toEqual({ state: "failed", turns: 0, archives: 0 });
  expect((await getSession(client.db, grant.workspaceId, childId))?.archived).toBe(true);
  expect((await getSession(client.db, grant.workspaceId, parent.id))?.archived).toBe(false);
  const active = await listSessionsForSubject(client.db, grant.workspaceId, {
    subjectId: grant.subjectId,
    parentSessionId: parent.id,
    limit: 10,
  });
  expect(active.sessions.some((session) => session.id === childId)).toBe(false);
  const archived = await listSessionsForSubject(client.db, grant.workspaceId, {
    subjectId: grant.subjectId,
    parentSessionId: parent.id,
    archiveStatus: "archived",
    limit: 10,
  });
  expect(archived.sessions.some((session) => session.id === childId && session.archived)).toBe(
    true,
  );
  const service = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "service",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "service", subjectId: "automation:host-archive-test" },
    hostSessionCreatePending: true,
  });
  await settleHostSessionCreate(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: service.id,
    ready: false,
  });
  expect((await getSession(client.db, grant.workspaceId, service.id))?.archived).toBe(true);
  const roots = await listSessionsForSubject(client.db, grant.workspaceId, {
    subjectId: grant.subjectId,
    parentSessionId: null,
    includeTotals: true,
    limit: 10,
  });
  expect(roots.sessions.some((session) => session.id === service.id)).toBe(false);
  const archivedRoots = await listSessionsForSubject(client.db, grant.workspaceId, {
    subjectId: grant.subjectId,
    parentSessionId: null,
    archiveStatus: "archived",
    sortBy: "archivedAt",
    includeTotals: true,
    limit: 10,
  });
  expect(
    archivedRoots.sessions.some((session) => session.id === service.id && session.archived),
  ).toBe(true);

  await expect(
    setSessionArchive(client.db, {
      workspaceId: grant.workspaceId,
      sessionId: service.id,
      subjectId: grant.subjectId,
      archived: false,
    }),
  ).rejects.toBeInstanceOf(SessionArchiveVersionConflictError);
});
