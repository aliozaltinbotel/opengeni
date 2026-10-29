import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  signDelegatedAccessToken,
  type AuthorizeSessionCreateInput,
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

function appWith(port: SessionAuthorizationPort) {
  return createApp({
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
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
    permissions: ["sessions:create", "sessions:read"],
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

  test("a create without a first message, and a port without the method, are unchanged", async () => {
    let asked = 0;
    const refusing = appWith({
      ...allowEveryTarget,
      authorizeSessionCreate: async () => {
        asked += 1;
        return { allowed: false, reason: "forbidden" };
      },
    });
    const who = await person();
    // Without a first message the route gives its own answer; the host is not asked.
    expect((await create(refusing, who, {})).code).not.toBe("SESSION_CREATE_NOT_AUTHORIZED");
    expect(asked).toBe(0);
    expect((await create(appWith(allowEveryTarget), who, { initialMessage: "hi" })).status).toBe(
      202,
    );
  });
});
