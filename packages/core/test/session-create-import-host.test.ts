import { Hono } from "hono";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { requireAccessGrantAuthorization, type AccessGrantAuthorization } from "../src/access";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createDb,
  getSession,
  SessionArchivedError,
  ensureManagedAccessForUser,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  appendArchivedSessionEventsForRequest,
  importArchivedSessionForRequest,
} from "../src/application/archived-session-imports";
import {
  SessionCreateAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
} from "../src/session-authorization";
import type { ApiRouteDeps } from "../src/dependencies";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const lease = await acquireSharedTestDatabase("session-create-import-host");
  if (!lease) throw new Error("PostgreSQL unavailable");
  shared = lease;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
const unexpected = async (): Promise<never> => {
  throw new Error("Unrelated service invoked during import");
};
function dependencies(): ApiRouteDeps {
  return {
    db: client.db,
    bus: new MemoryEventBus(),
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: "host-import-fixture",
    }),
    objectStorage: null,
    workflowClient: {
      signalUserMessage: unexpected,
      wakeSessionWorkflow: unexpected,
      requestSessionWorkflowWakeDispatch: unexpected,
      signalApprovalDecision: unexpected,
      syncScheduledTask: unexpected,
      deleteScheduledTaskSchedule: unexpected,
      triggerScheduledTask: unexpected,
      startRigVerification: unexpected,
    },
    resolveCatalogSettings: unexpected,
    managedEmailTransport: {
      sender: "test@example.test",
      idempotency: { scope: "test", retentionSeconds: 60 },
      send: unexpected,
    },
    githubStateSecret: "test",
    documentIndexer: { indexDocument: unexpected },
    getDocumentServices: () => {
      throw new Error("Unexpected document service");
    },
    resumeBoxById: unexpected,
  };
}
test("the actual import owner asks before writing and calls a bound hook after commit", async () => {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Host import",
  });
  const grant = access.workspaceGrants[0]!;
  const deps = dependencies();
  let resolved: AccessGrantAuthorization | undefined;
  const app = new Hono();
  app.get("/authorization", async (c) => {
    resolved = await requireAccessGrantAuthorization(c, deps, grant.workspaceId, "sessions:create");
    return c.json({ resolved: true });
  });
  const token = await signDelegatedAccessToken("host-import-fixture", {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:create", "sessions:read", "sessions:control"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  expect(
    (await app.request("/authorization", { headers: { authorization: `Bearer ${token}` } })).status,
  ).toBe(200);
  if (!resolved) throw new Error("Request authorization was not resolved");
  const authorization = resolved;
  const payload = {
    importId: crypto.randomUUID(),
    title: "Retained history",
    createdAt: "2020-01-01T00:00:00Z",
    events: [
      {
        type: "user.message" as const,
        createdAt: "2020-01-01T00:00:01Z",
        payload: { text: "Original history" },
      },
    ],
  };
  deps.sessionAuthorization = {
    authorizeSession: async () => ({ allowed: true }),
    resolveListScope: async () => ({ kind: "all" }),
    authorizeSessionCreate: async () => ({ allowed: false, reason: "revoked" }),
  };
  await expect(
    importArchivedSessionForRequest(deps, authorization, grant.workspaceId, payload),
  ).rejects.toBeInstanceOf(SessionCreateAuthorizationDeniedError);
  const [empty] = await shared.admin<
    { count: number }[]
  >`select count(*)::int as count from sessions where workspace_id=${grant.workspaceId}`;
  expect(empty?.count).toBe(0);
  let hooked = false;
  const port = {
    marker: "bound-import",
    authorizeSession: async () => ({ allowed: true as const }),
    resolveListScope: async () => ({ kind: "all" as const }),
    async authorizeSessionCreate() {
      expect(this.marker).toBe("bound-import");
      return { allowed: true as const, requiredToolServers: [{ id: "host" }] };
    },
    async sessionCreated(input: { sessionId: string }) {
      expect(this.marker).toBe("bound-import");
      const [row] = await shared.admin<
        { state: string; imported: string; turns: number }[]
      >`select s.host_session_create_state as state,s.imported_archive_import_id as imported,(select count(*)::int from session_turns t where t.session_id=s.id) as turns from sessions s where s.id=${input.sessionId}`;
      expect(row).toEqual({ state: "pending", imported: payload.importId, turns: 0 });
      await expect(
        appendArchivedSessionEventsForRequest(
          deps,
          authorization,
          grant.workspaceId,
          payload.importId,
          { batchId: crypto.randomUUID(), offset: 1, events: payload.events },
        ),
      ).rejects.toBeInstanceOf(SessionArchivedError);
      hooked = true;
    },
  };
  deps.sessionAuthorization = port;
  deps.settings = testSettings({
    mcpServers: [
      {
        id: "host",
        url: "https://host.example/mcp",
        cacheToolsList: false,
        visibility: "internal",
      },
    ],
  });
  const imported = await importArchivedSessionForRequest(
    deps,
    authorization,
    grant.workspaceId,
    payload,
  );
  expect(hooked).toBe(true);
  expect(imported.created).toBe(true);
  expect(imported.session.importedArchive?.readOnly).toBe(true);
  expect(imported.session.toolPolicy.hostRequiredMcpServerIds).toEqual(["host"]);
  const [historic] = await shared.admin<
    { text: string; occurred: string }[]
  >`select payload->>'text' as text,occurred_at::text as occurred from session_events where session_id=${imported.session.id} and type='user.message'`;
  expect(historic?.text).toBe("Original history");
  expect(historic?.occurred.startsWith("2020-01-01 00:00:01")).toBe(true);
  for (const mode of ["throw", "deadline"] as const) {
    const failedPayload = { ...payload, importId: crypto.randomUUID() };
    let failedId = "";
    let before = "";
    deps.sessionAuthorization = {
      ...port,
      async sessionCreated(input: { sessionId: string }) {
        failedId = input.sessionId;
        before = JSON.stringify(
          await shared.admin`select type,payload::text,occurred_at::text from session_events where session_id=${input.sessionId} order by sequence`,
        );
        if (mode === "deadline") await new Promise((resolve) => setTimeout(resolve, 5200));
        else throw new Error("Host binding unavailable");
      },
    };
    await expect(
      importArchivedSessionForRequest(deps, authorization, grant.workspaceId, failedPayload),
    ).rejects.toBeInstanceOf(SessionAuthorizationUnavailableError);
    if (mode === "deadline") await new Promise((resolve) => setTimeout(resolve, 300));
    const [closed] = await shared.admin<
      { state: string; status: string; turns: number }[]
    >`select s.host_session_create_state as state,s.status,(select count(*)::int from session_turns t where t.session_id=s.id) as turns from sessions s where s.id=${failedId}`;
    expect(closed).toEqual({ state: "failed", status: "idle", turns: 0 });
    expect((await getSession(client.db, grant.workspaceId, failedId))?.archived).toBe(true);
    const after = JSON.stringify(
      await shared.admin`select type,payload::text,occurred_at::text from session_events where session_id=${failedId} order by sequence`,
    );
    expect(after).toBe(before);
    await expect(
      appendArchivedSessionEventsForRequest(
        deps,
        authorization,
        grant.workspaceId,
        failedPayload.importId,
        { batchId: crypto.randomUUID(), offset: 1, events: payload.events },
      ),
    ).rejects.toBeInstanceOf(SessionArchivedError);
  }
}, 30_000);
