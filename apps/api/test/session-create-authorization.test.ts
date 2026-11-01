import { beginSessionRealtimeInTransaction, withWorkspaceSubjectSessionActivityRls } from "@opengeni/db";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  signDelegatedAccessToken,
  type AuthorizeSessionCreateInput,
  type SessionCreateCreator,
  type SessionAuthorizationPort,
} from "@opengeni/contracts";
import type { SessionWorkflowClient } from "@opengeni/core";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * The host's target-free check on session create: a request that admits a
 * first turn (`initialMessage`) asks `SessionAuthorizationPort
 * .authorizeSessionCreate` before anything is created. A port without the
 * optional method, and a create without a first message, are unchanged.
 */

const SECRET = "session-create-authorization-test-secret";
setDefaultTimeout(60_000);

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-create-authorization");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const noop = async () => undefined;

function appWith(
  port: SessionAuthorizationPort,
  servers: ReturnType<typeof testSettings>["mcpServers"] = [],
) {
  return createApp({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      mcpServers: servers,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      startSessionWorkflow: noop,
    } as unknown as SessionWorkflowClient,
    sessionAuthorization: port,
  });
}

const allowEveryTarget: Pick<SessionAuthorizationPort, "authorizeSession" | "resolveListScope"> = {
  authorizeSession: async () => ({ allowed: true }),
  resolveListScope: async () => ({ kind: "all" }),
};

async function person() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-create-authorization-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Session create authorization",
    workspaceExternalSource: "session-create-authorization-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session create authorization",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:create", "sessions:read", "sessions:control"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  return { grant, authorization };
}

async function create(
  app: ReturnType<typeof appWith>,
  who: Awaited<ReturnType<typeof person>>,
  body: Record<string, unknown>,
) {
  const response = await app.request(`/v1/workspaces/${who.grant.workspaceId}/sessions`, {
    method: "POST",
    headers: { authorization: who.authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as {
    error?: { details?: { code?: string } };
  } | null;
  return { status: response.status, code: json?.error?.details?.code };
}

async function sessionCount(workspaceId: string): Promise<number> {
  const [row] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from sessions where workspace_id = ${workspaceId}`;
  return row!.count;
}

describe("session create with a first message asks the host", () => {
  test("a refusal answers 403 SESSION_CREATE_NOT_AUTHORIZED and creates nothing", async () => {
    const asked: AuthorizeSessionCreateInput[] = [];
    const app = appWith({
      ...allowEveryTarget,
      authorizeSessionCreate: async (input) => {
        asked.push(input);
        return { allowed: false, reason: "revoked" };
      },
    });
    const who = await person();
    expect(await create(app, who, { initialMessage: "hello" })).toEqual({
      status: 403,
      code: "SESSION_CREATE_NOT_AUTHORIZED",
    });
    expect(await sessionCount(who.grant.workspaceId)).toBe(0);
    expect(asked).toEqual([
      {
        accountId: who.grant.accountId,
        workspaceId: who.grant.workspaceId,
        actor: expect.objectContaining({ subjectId: who.grant.subjectId }),
        surface: "http",
        creator: { principalKind: "human_session" },
      },
    ]);
  });

  test("an allowed create goes on", async () => {
    const app = appWith({
      ...allowEveryTarget,
      authorizeSessionCreate: async () => ({ allowed: true }),
    });
    const who = await person();
    expect((await create(app, who, { initialMessage: "hello" })).status).toBe(202);
    expect(await sessionCount(who.grant.workspaceId)).toBe(1);
  });

  test("a port that throws answers 503 SESSION_AUTHORIZATION_UNAVAILABLE", async () => {
    const app = appWith({
      ...allowEveryTarget,
      authorizeSessionCreate: async () => {
        throw new Error("host down");
      },
    });
    const who = await person();
    expect(await create(app, who, { initialMessage: "hello" })).toEqual({
      status: 503,
      code: "SESSION_AUTHORIZATION_UNAVAILABLE",
    });
    expect(await sessionCount(who.grant.workspaceId)).toBe(0);
  });

  test("a create without a first message asks the host; a port without the method is unchanged", async () => {
    let asked = 0;
    const refusing = appWith({
      ...allowEveryTarget,
      authorizeSessionCreate: async () => {
        asked += 1;
        return { allowed: false, reason: "forbidden" };
      },
    });
    const who = await person();
    // Empty shells are authorized before they can admit a later turn.
    expect((await create(refusing, who, { startMode: "realtime" })).code).toBe(
      "SESSION_CREATE_NOT_AUTHORIZED",
    );
    expect(asked).toBe(1);
    expect((await create(appWith(allowEveryTarget), who, { initialMessage: "hi" })).status).toBe(
      202,
    );
  });
});

test("an unknown required server refuses before any shell is created", async () => {
  const app = appWith({
    ...allowEveryTarget,
    authorizeSessionCreate: async () => ({
      allowed: true,
      requiredToolServers: [{ id: "missing" }],
    }),
  });
  const who = await person();
  expect(await create(app, who, { initialMessage: "hello" })).toEqual({
    status: 503,
    code: "SESSION_AUTHORIZATION_UNAVAILABLE",
  });
  expect(await sessionCount(who.grant.workspaceId)).toBe(0);
});

test("the created hook sees a committed shell with no turn and failure cancels it", async () => {
  let createdId = "";
  const app = appWith({
    ...allowEveryTarget,
    sessionCreated: async (input) => {
      createdId = input.sessionId;
      expect(input.actor).toMatchObject({ kind: "subject" });
      expect(input.rootSessionId).toBe(input.sessionId);
      const [row] = await shared.admin<
        { state: string; turns: number }[]
      >`select s.host_session_create_state as state, (select count(*)::int from session_turns t where t.session_id=s.id) as turns from sessions s where s.id=${input.sessionId}`;
      expect(row).toEqual({ state: "pending", turns: 0 });
      throw new Error("host unavailable");
    },
  });
  const who = await person();
  expect(await create(app, who, { initialMessage: "hello" })).toEqual({
    status: 503,
    code: "SESSION_AUTHORIZATION_UNAVAILABLE",
  });
  expect(createdId).not.toBe("");
  const [row] = await shared.admin<
    { state: string; turns: number }[]
  >`select s.host_session_create_state as state, (select count(*)::int from session_turns t where t.session_id=s.id) as turns from sessions s where s.id=${createdId}`;
  expect(row).toEqual({ state: "failed", turns: 0 });
  const [archive]=await shared.admin<{archived:boolean}[]>`select archived from session_pins where session_id=${createdId} and subject_id=${who.grant.subjectId}`;
  expect(archive?.archived).toBe(true);

});

test("a successful created hook opens the shell before admitting its initial turn", async () => {
  let sessionId = "";
  let creator: SessionCreateCreator | undefined;
  const app = appWith({
    ...allowEveryTarget,
    authorizeSessionCreate: async (input) => {
      creator = input.creator;
      expect(creator).toEqual({ principalKind: "human_session" });
      return { allowed: true };
    },
    sessionCreated: async (input) => {
      sessionId = input.sessionId;
      expect(input.creator).toBe(creator);
      expect(input.creator?.readCredential).toBeUndefined();
    },
  });
  const who = await person();
  expect((await create(app, who, { initialMessage: "hello" })).status).toBe(202);
  const [row] = await shared.admin<
    { state: string; turns: number }[]
  >`select s.host_session_create_state as state, (select count(*)::int from session_turns t where t.session_id=s.id) as turns from sessions s where s.id=${sessionId}`;
  expect(row).toEqual({ state: "ready", turns: 1 });
});

test("a concurrent append to a pending shell cannot admit a turn", async () => {
  const who = await person();
  let appendStatus = 0;
  let createdId = "";
  const app = appWith({
    ...allowEveryTarget,
    sessionCreated: async (input) => {
      createdId = input.sessionId;
      await expect(withWorkspaceSubjectSessionActivityRls(client.db,who.grant.workspaceId,who.grant.subjectId,tx=>beginSessionRealtimeInTransaction(tx,{accountId:who.grant.accountId,workspaceId:who.grant.workspaceId,sessionId:input.sessionId,operationId:crypto.randomUUID(),ownerSubjectId:who.grant.subjectId,browserInstanceId:crypto.randomUUID(),ownerKey:crypto.randomUUID(),model:"gpt-live-1-boulder-alpha"}))).rejects.toMatchObject({code:"HOST_SESSION_CREATE_NOT_READY"});

      const response = await app.request(
        `/v1/workspaces/${who.grant.workspaceId}/sessions/${input.sessionId}/events`,
        {
          method: "POST",
          headers: { authorization: who.authorization, "content-type": "application/json" },
          body: JSON.stringify({
            type: "user.message",
            clientEventId: crypto.randomUUID(),
            payload: { text: "concurrent" },
          }),
        },
      );
      appendStatus = response.status;
      expect(response.status).toBeGreaterThanOrEqual(400);
      const [row] = await shared.admin<
        { count: number }[]
      >`select count(*)::int as count from session_turns where session_id=${input.sessionId}`;
      expect(row?.count).toBe(0);
    },
  });
  expect((await create(app, who, { initialMessage: "hello" })).status).toBe(202);
  expect(appendStatus).toBeGreaterThanOrEqual(400);
  const after = await app.request(
    `/v1/workspaces/${who.grant.workspaceId}/sessions/${createdId}/events`,
    {
      method: "POST",
      headers: { authorization: who.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        type: "user.message",
        clientEventId: crypto.randomUUID(),
        payload: { text: "after hook" },
      }),
    },
  );
  expect(after.status).toBe(202);
});

test("a deadline failure cannot be reopened by a late callback", async () => {
  let sessionId = "";
  const app = appWith({
    ...allowEveryTarget,
    sessionCreated: async (input) => {
      sessionId = input.sessionId;
      await new Promise((resolve) => setTimeout(resolve, 5_200));
    },
  });
  const who = await person();
  expect(await create(app, who, { initialMessage: "hello" })).toEqual({
    status: 503,
    code: "SESSION_AUTHORIZATION_UNAVAILABLE",
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [row] = await shared.admin<
    { state: string; turns: number }[]
  >`select s.host_session_create_state as state,(select count(*)::int from session_turns t where t.session_id=s.id) as turns from sessions s where s.id=${sessionId}`;
  expect(row).toEqual({ state: "failed", turns: 0 });
});

test("host-required internal servers are eagerly persisted, while public input cannot mint requirements", async () => {
  const servers = [
    {
      id: "host",
      url: "https://host.example/mcp",
      cacheToolsList: false,
      visibility: "internal" as const,
    },
  ];
  let sessionId = "";
  const app = appWith(
    {
      ...allowEveryTarget,
      authorizeSessionCreate: async () => ({
        allowed: true,
        requiredToolServers: [{ id: "host" }],
      }),
      sessionCreated: async (input) => {
        sessionId = input.sessionId;
      },
    },
    servers,
  );
  const who = await person();
  expect(
    (await create(app, who, { initialMessage: "hello", excludedMcpServerIds: ["host"] })).status,
  ).toBe(202);
  const [row] = await shared.admin<
    { policy: { hostRequiredMcpServerIds: string[] }; tools: unknown[] }[]
  >`select tool_policy as policy,tools from sessions where id=${sessionId}`;
  expect(row?.policy.hostRequiredMcpServerIds).toEqual(["host"]);
  expect(row?.tools).toContainEqual({ kind: "mcp", id: "host", eager: true });
  const untrusted = await create(appWith(allowEveryTarget, servers), who, {
    initialMessage: "hello",
    hostRequiredMcpServerIds: ["host"],
  });
  expect(untrusted.status).toBe(202);
  const [untrustedRow] = await shared.admin<
    { policy: { hostRequiredMcpServerIds?: string[] }; tools: { id: string }[] }[]
  >`select tool_policy as policy,tools from sessions where workspace_id=${who.grant.workspaceId} and id<>${sessionId}`;
  expect(untrustedRow?.policy.hostRequiredMcpServerIds).toBeUndefined();
  expect(untrustedRow?.tools.some((tool) => tool.id === "host")).toBe(false);
});

test("create and created callbacks retain the configured port receiver",async()=>{
  const port={...allowEveryTarget,marker:"bound-port",async authorizeSessionCreate(){expect(this.marker).toBe("bound-port");return {allowed:true as const};},async sessionCreated(){expect(this.marker).toBe("bound-port");}};
  const who=await person();
  expect((await create(appWith(port),who,{initialMessage:"hello"})).status).toBe(202);
});
