import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  SESSION_PENDING_INPUT_EXPIRED,
  SESSION_PENDING_INPUT_LIMIT_REACHED,
  SESSION_PENDING_INPUT_LIMITS,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import { sessionPendingInputLimits, type AppDependencies } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  listSessionEvents,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * SESSION_PENDING_INPUT_LIMITS: a session's accepted-but-unclaimed human/API
 * messages are bounded by count and bytes, and stop counting after the TTL.
 * No worker runs here, so every accepted message stays pending.
 */
const delegationSecret = "session-pending-input-limits-delegation-32";
const PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
];

setDefaultTimeout(60_000);

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-pending-input-limits");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function settings(overrides: Partial<Settings> = {}) {
  return testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "configured",
    delegationSecret,
    openaiModel: "scripted-model",
    sandboxBackend: "none",
    ...overrides,
  });
}

type Fixture = {
  api: ReturnType<typeof createApp>;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  sessionId: string;
  bearer: string;
};

async function fixture(overrides: Partial<Settings> = {}): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test-host",
    accountExternalId: `pending-input-${suffix}`,
    accountName: "Pending input",
    workspaceExternalSource: "test-host:workspace",
    workspaceExternalId: `pending-input-${suffix}`,
    workspaceName: "Pending input",
    subjectId: `user:pending-input-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const api = createApp({
    settings: settings(overrides),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
  } as AppDependencies);
  const bearer = `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: PERMISSIONS,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`;
  const created = await api.request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
    method: "POST",
    headers: { authorization: bearer, "content-type": "application/json" },
    body: JSON.stringify({ initialMessage: "first" }),
  });
  const body = (await created.json()) as { id?: string; session?: { id: string } };
  if (created.status >= 300) throw new Error(`session create: ${JSON.stringify(body)}`);
  return {
    api,
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    sessionId: (body.session?.id ?? body.id)!,
    bearer,
  };
}

async function send(f: Fixture, text: string, clientEventId = crypto.randomUUID()) {
  return await f.api.request(`/v1/workspaces/${f.workspaceId}/sessions/${f.sessionId}/events`, {
    method: "POST",
    headers: { authorization: f.bearer, "content-type": "application/json" },
    body: JSON.stringify({ type: "user.message", clientEventId, payload: { text } }),
  });
}

/** Every row a Send could write. */
async function writtenState(f: Fixture) {
  const [turns] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_turns where session_id = ${f.sessionId}`;
  const [events] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_events where session_id = ${f.sessionId}`;
  const [receipts] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_command_receipts where target_session_id = ${f.sessionId}`;
  const [session] = await shared.admin<{ lastSequence: string; queueVersion: string }[]>`
    select last_sequence::text as "lastSequence", queue_version::text as "queueVersion"
    from sessions where id = ${f.sessionId}`;
  return { turns: turns!.count, events: events!.count, receipts: receipts!.count, ...session };
}

async function pendingTurns(f: Fixture) {
  return await shared.admin<
    { id: string; prompt: string; status: string; cancelReason: string | null }[]
  >`
    select id, prompt, status, cancel_reason as "cancelReason" from session_turns
    where session_id = ${f.sessionId} and source in ('user', 'api') order by created_at, id`;
}

async function expectRefusal(response: Response, limit: "count" | "bytes", retryable: boolean) {
  expect(response.status).toBe(429);
  const body = (await response.json()) as {
    error: { code: string; retryable: boolean; details: Record<string, unknown> };
  };
  expect(body.error).toMatchObject({
    code: "limit_exceeded",
    retryable,
    details: { code: SESSION_PENDING_INPUT_LIMIT_REACHED, limit },
  });
  if (retryable) {
    expect(response.headers.get("retry-after")).toBe(String(body.error.details.retryAfterSeconds));
  } else {
    expect(response.headers.get("retry-after")).toBeNull();
    expect(body.error.details.retryAfterSeconds).toBeNull();
  }
  return body.error.details;
}

describe("pending session input bounds", () => {
  test("the defaults are finite and the deployment settings override them", () => {
    expect(SESSION_PENDING_INPUT_LIMITS).toEqual({
      maxCount: 64,
      maxBytes: 4 * 1024 * 1024,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(Object.isFrozen(SESSION_PENDING_INPUT_LIMITS)).toBe(true);
    expect(sessionPendingInputLimits(testSettings())).toEqual(SESSION_PENDING_INPUT_LIMITS);
    expect(
      sessionPendingInputLimits(
        testSettings({
          sessionPendingInputMaxCount: 3,
          sessionPendingInputMaxBytes: 100,
          sessionPendingInputTtlMs: 1_000,
        }),
      ),
    ).toEqual({ maxCount: 3, maxBytes: 100, ttlMs: 1_000 });
  });

  test("the count bound refuses with 429 and writes nothing; the queue stays sendable after", async () => {
    const f = await fixture({ sessionPendingInputMaxCount: 3 });
    // The initial message is pending too: two more fit.
    expect((await send(f, "second")).status).toBe(202);
    expect((await send(f, "third")).status).toBe(202);
    const before = await writtenState(f);
    const refusedKey = crypto.randomUUID();
    const details = await expectRefusal(await send(f, "fourth", refusedKey), "count", true);
    expect(details).toMatchObject({ pendingCount: 3, maxCount: 3 });
    expect(await writtenState(f)).toEqual(before);
    // The refused key is not burned: once a pending message leaves, the same
    // key is admitted as a fresh Send.
    await shared.admin`
      update session_turns set status = 'cancelled', cancel_reason = 'test'
      where id = ${(await pendingTurns(f)).at(-1)!.id}`;
    expect((await send(f, "fourth", refusedKey)).status).toBe(202);
  });

  test("the byte bound counts the pending text and refuses a message that alone is too large", async () => {
    const f = await fixture({ sessionPendingInputMaxBytes: 64 });
    expect((await send(f, "x".repeat(40))).status).toBe(202);
    const before = await writtenState(f);
    const details = await expectRefusal(await send(f, "y".repeat(30)), "bytes", true);
    expect(details).toMatchObject({ messageBytes: 30, maxBytes: 64 });
    expect(Number(details.pendingBytes)).toBeGreaterThanOrEqual(45);
    await expectRefusal(await send(f, "é".repeat(40)), "bytes", false);
    expect(await writtenState(f)).toEqual(before);
  });

  test("expired pending input stops counting and leaves the queue through the delete lifecycle", async () => {
    const f = await fixture({ sessionPendingInputMaxCount: 2, sessionPendingInputTtlMs: 60_000 });
    expect((await send(f, "second")).status).toBe(202);
    await expectRefusal(await send(f, "third"), "count", true);
    const stale = await pendingTurns(f);
    expect(stale.map((turn) => turn.status)).toEqual(["queued", "queued"]);
    await shared.admin`
      update session_turns set created_at = now() - interval '2 minutes'
      where session_id = ${f.sessionId} and source in ('user', 'api')`;
    expect((await send(f, "third")).status).toBe(202);
    const after = await pendingTurns(f);
    expect(after.map((turn) => [turn.status, turn.cancelReason])).toEqual([
      ["cancelled", SESSION_PENDING_INPUT_EXPIRED],
      ["cancelled", SESSION_PENDING_INPUT_EXPIRED],
      ["queued", null],
    ]);
    const events = await listSessionEvents(client.db, f.workspaceId, f.sessionId, {
      after: 0,
      limit: 200,
    });
    // Each expired message keeps its user.message and leaves the queue with a
    // delete that names the reason, before the new message is accepted.
    const deletes = events.filter(
      (event) =>
        event.type === "session.queue.changed" &&
        (event.payload as { operation?: string }).operation === "delete",
    );
    const byTurn = (left: { turnId: string }, right: { turnId: string }) =>
      left.turnId.localeCompare(right.turnId);
    expect(
      deletes.map((event) => event.payload as { turnId: string; reason: string }).sort(byTurn),
    ).toEqual(
      stale
        .map((turn) => ({ turnId: turn.id }))
        .sort(byTurn)
        .map(({ turnId }) =>
          expect.objectContaining({ turnId, reason: SESSION_PENDING_INPUT_EXPIRED }),
        ),
    );
    expect(
      events
        .filter((event) => event.type === "user.message")
        .map((event) => (event.payload as { text: string }).text),
    ).toEqual(expect.arrayContaining(["second", "third"]));
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    const lastDelete = deletes.at(-1)!.sequence;
    const third = events.find(
      (event) =>
        event.type === "user.message" && (event.payload as { text: string }).text === "third",
    )!;
    expect(third.sequence).toBeGreaterThan(lastDelete);
  });

  test("normal sends under the default bounds and lifecycle callers without bounds are unchanged", async () => {
    const f = await fixture();
    for (let index = 0; index < 5; index += 1)
      expect((await send(f, `msg ${index}`)).status).toBe(202);
    // A caller that passes no bounds (lifecycle admission) is never refused.
    const limited = await fixture({ sessionPendingInputMaxCount: 1 });
    await expectRefusal(await send(limited, "over"), "count", true);
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      limited.workspaceId,
      limited.subjectId,
      async (tx) =>
        await submitHumanPromptInTransaction(tx, {
          accountId: limited.accountId,
          workspaceId: limited.workspaceId,
          sessionId: limited.sessionId,
          subjectId: limited.subjectId,
          actor: { type: "human", subjectId: limited.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "lifecycle",
          resources: [],
          reasoningEffortFallback: "medium",
          source: "user",
        }),
    );
    expect((await pendingTurns(limited)).map((turn) => turn.status)).toEqual(["queued", "queued"]);
  });
});
