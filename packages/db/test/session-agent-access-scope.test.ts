import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import type { SessionAgentAccessViewer, SessionScopeSubjectId } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSessionAccessProjection,
  listSessionsForSubject,
  listSessionEntriesForSubject,
  listSessionDiscoverySummaries,
  searchSessionMessagesForSubject,
  decodeSessionListCursor,
  getSessionAuthorityProjection,
  resolveSessionMemoryAgentScope,
  type Database,
  type DbClient,
  type SessionCreateInput,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const u1: SessionScopeSubjectId = "user:u_1";
const u2: SessionScopeSubjectId = "external_user:u_2";

type Fixture = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
};

async function fixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "session-agent-access-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Session agent access",
    workspaceExternalSource: "session-agent-access-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session agent access",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId, subjectId: grant.subjectId };
}

async function session(
  f: Fixture,
  message: string,
  overrides: Partial<SessionCreateInput> = {},
): Promise<{ id: string; rootSessionId: string }> {
  const created = await createSession(db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    initialMessage: message,
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: f.subjectId, label: "Owner" },
    createdByContext: {},
    ...overrides,
  });
  return { id: created.id, rootSessionId: created.rootSessionId };
}

async function listIds(
  f: Fixture,
  options: Partial<Parameters<typeof listSessionsForSubject>[2]> = {},
): Promise<Set<string>> {
  const page = await listSessionsForSubject(db, f.workspaceId, {
    subjectId: f.subjectId,
    limit: 100,
    materializeSnapshot: false,
    ...options,
  });
  return new Set([...page.pinned, ...page.sessions].map((row) => row.id));
}

function viewer(
  root: string,
  agentAccess: SessionAgentAccessViewer["agentAccess"],
  scopeSubjectId: SessionScopeSubjectId | null,
): SessionAgentAccessViewer {
  return { callerRootSessionId: root, agentAccess, scopeSubjectId };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-agent-access-scope");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    console.warn("[session-agent-access-scope] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("session agent access scope (real PostgreSQL)", () => {
  test("the create insert stores the frozen scope and the projections read it back", async () => {
    if (!available) return;
    const f = await fixture();
    const scoped = await session(f, "scoped", {
      agentAccess: "session",
      scopeSubjectId: u1,
      memoryScope: "user",
    });
    const plain = await session(f, "plain");
    expect(await getSessionAccessProjection(db, f.workspaceId, scoped.id)).toEqual({
      sessionId: scoped.id,
      rootSessionId: scoped.id,
      agentAccess: "session",
      scopeSubjectId: u1,
      memoryScope: "user",
    });
    expect(await getSessionAccessProjection(db, f.workspaceId, plain.id)).toEqual({
      sessionId: plain.id,
      rootSessionId: plain.id,
      agentAccess: "workspace",
      scopeSubjectId: f.subjectId,
      memoryScope: "workspace",
    });
    expect(await getSessionAccessProjection(db, f.workspaceId, crypto.randomUUID())).toBeNull();
    const listed = await listSessionsForSubject(db, f.workspaceId, {
      subjectId: f.subjectId,
      limit: 10,
      materializeSnapshot: false,
    });
    const row = [...listed.pinned, ...listed.sessions].find((entry) => entry.id === scoped.id);
    expect(row).toMatchObject({ agentAccess: "session", scopeSubjectId: u1, memoryScope: "user" });
    expect(await resolveSessionMemoryAgentScope(db, f.workspaceId, scoped.id)).toEqual({
      mode: "off",
      userSubjectId: null,
      rootSessionId: scoped.id,
    });
    expect(u1).toBe("user:u_1");
  });

  test("the end-user filter and the viewer predicate select exactly the reachable rows", async () => {
    if (!available) return;
    const f = await fixture();
    const a = await session(f, "A session-scoped u1", {
      agentAccess: "session",
      scopeSubjectId: u1,
    });
    const a1 = await session(f, "A1 child of A", {
      parentSessionId: a.id,
      agentAccess: "session",
      scopeSubjectId: u1,
    });
    const b = await session(f, "B session-scoped u1", {
      agentAccess: "session",
      scopeSubjectId: u1,
    });
    const c = await session(f, "C workspace u1", { agentAccess: "workspace", scopeSubjectId: u1 });
    const d = await session(f, "D workspace unlabelled");
    const e = await session(f, "E user u1", { agentAccess: "user", scopeSubjectId: u1 });
    const g = await session(f, "G workspace u2", { agentAccess: "workspace", scopeSubjectId: u2 });
    const h = await session(f, "H user u2", { agentAccess: "user", scopeSubjectId: u2 });

    expect(a1.rootSessionId).toBe(a.id);
    expect(await listIds(f)).toEqual(new Set([a.id, a1.id, b.id, c.id, d.id, e.id, g.id, h.id]));
    expect(await listIds(f, { scopeSubjectId: u1 })).toEqual(
      new Set([a.id, a1.id, b.id, c.id, e.id]),
    );
    expect(await listIds(f, { scopeSubjectId: "user:other" })).toEqual(new Set());

    const scoped = (agentAccessViewer: SessionAgentAccessViewer) =>
      listIds(f, { authorizationScope: { kind: "all", agentAccessViewer } });
    // A session-scoped caller sees only its own tree.
    expect(await scoped(viewer(a.id, "session", u1))).toEqual(new Set([a.id, a1.id]));
    // A user-scoped caller sees its tree plus every same-user peer, regardless of target scope.
    expect(await scoped(viewer(e.id, "user", u1))).toEqual(
      new Set([a.id, a1.id, b.id, c.id, e.id]),
    );
    expect(await scoped(viewer(h.id, "user", u2))).toEqual(new Set([h.id, g.id]));
    // A workspace caller without a label sees every authorized peer regardless of target task scope.
    expect(await scoped(viewer(d.id, "workspace", null))).toEqual(
      new Set([a.id, a1.id, b.id, c.id, d.id, e.id, g.id, h.id]),
    );
    // A workspace caller with a label has the same reach regardless of its own user label.
    expect(await scoped(viewer(c.id, "workspace", u1))).toEqual(
      new Set([a.id, a1.id, b.id, c.id, d.id, e.id, g.id, h.id]),
    );
    // The viewer intersects a host root scope rather than replacing it.
    expect(
      await listIds(f, {
        authorizationScope: {
          kind: "scoped",
          rootSessionIds: [a.id, c.id],
          sessionIds: [],
          agentAccessViewer: viewer(a.id, "session", u1),
        },
      }),
    ).toEqual(new Set([a.id, a1.id]));
    expect(
      await listIds(f, {
        authorizationScope: {
          kind: "scoped",
          rootSessionIds: [a.id, c.id],
          sessionIds: [],
          agentAccessViewer: viewer(d.id, "workspace", null),
        },
      }),
    ).toEqual(new Set([a.id, a1.id, c.id]));
    // Human/API callers without a viewer keep the complete list.
    expect(await listIds(f, { authorizationScope: { kind: "all" } })).toEqual(
      new Set([a.id, a1.id, b.id, c.id, d.id, e.id, g.id, h.id]),
    );
  });
});

async function ownershipFixture() {
  const f = await fixture();
  const member = `user:member-${crypto.randomUUID()}`;
  for (const subject of [f.subjectId, member]) {
    const personalId = crypto.randomUUID();
    await shared!
      .admin`insert into workspaces (id, account_id, name) values (${personalId}, ${f.accountId}, 'Ownership test personal')`;
    await shared!
      .admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${f.accountId}, ${subject}, 'active', ${personalId})`;
    await shared!
      .admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${f.accountId}, ${f.workspaceId}, ${subject}, 'member', '["sessions:read","sessions:write"]'::jsonb) on conflict do nothing`;
  }
  const own = await session(f, "ownership token", { subjectId: f.subjectId });
  const child = await session(f, "ownership token child", {
    parentSessionId: own.id,
    subjectId: f.subjectId,
  });
  const ownPrivate = await session(f, "ownership token private", {
    visibility: "user_private",
    subjectId: f.subjectId,
  });
  const theirs = await session(f, "ownership token shared", {
    subjectId: member,
    createdBy: { kind: "subject", subjectId: member },
    createdByContext: {},
  });
  const theirPrivate = await session(f, "ownership token hidden", {
    subjectId: member,
    visibility: "user_private",
    createdBy: { kind: "subject", subjectId: member },
    createdByContext: {},
  });
  for (const item of [own, child, ownPrivate, theirs, theirPrivate]) {
    await shared!
      .admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
      values (${f.accountId}, ${f.workspaceId}, ${item.id}, 1, 'user.message', '{"text":"ownership-search-token"}'::jsonb)`;
  }
  return { ...f, member, own, child, ownPrivate, theirs, theirPrivate };
}

test("a host can allow only owned sessions in a listing", async () => {
  if (!available) return;
  const f = await ownershipFixture();
  expect(await getSessionAuthorityProjection(db, f.workspaceId, f.own.id)).toMatchObject({
    ownerSubjectId: f.subjectId,
  });
  const authorizationScope = { kind: "owned" as const, subjectId: f.subjectId };
  expect(await listIds(f, { authorizationScope })).toEqual(
    new Set([f.own.id, f.child.id, f.ownPrivate.id]),
  );
  const roots = await listSessionEntriesForSubject(db, f.workspaceId, {
    subjectId: f.subjectId,
    authorizationScope,
    parentSessionId: null,
    includePinned: false,
    includeTotals: true,
  });
  expect(new Set(roots.sessions.map((row) => row.id))).toEqual(
    new Set([f.own.id, f.ownPrivate.id]),
  );
  expect(roots.totals?.groups.reduce((count, group) => count + group.total, 0)).toBe(3);
  expect(await listIds(f, { authorizationScope, parentSessionId: f.own.id })).toEqual(
    new Set([f.child.id]),
  );
  expect(await listIds(f, { authorizationScope: { kind: "owned", subjectId: f.member } })).toEqual(
    new Set([f.theirs.id]),
  );
  expect(
    await listIds(f, {
      authorizationScope: { kind: "owned", subjectId: "user:missing' OR true --" },
    }),
  ).toEqual(new Set());
}, 30_000);

test("owned_or_shared adds workspace-shared sessions but never another member’s private one", async () => {
  if (!available) return;
  const f = await ownershipFixture();
  const authorizationScope = { kind: "owned_or_shared" as const, subjectId: f.subjectId };
  const expected = new Set([f.own.id, f.child.id, f.ownPrivate.id, f.theirs.id]);
  expect(await listIds(f, { authorizationScope })).toEqual(expected);
  const searched = await searchSessionMessagesForSubject(
    db,
    f.workspaceId,
    { query: "ownership-search-token" },
    { subjectId: f.subjectId, authorizationScope },
  );
  expect(new Set(searched.matches.map((row) => row.sessionId))).toEqual(expected);
  expect(searched.matchedMessageCount).toBe(4);
  const intersected = {
    ...authorizationScope,
    agentAccessViewer: viewer(f.own.id, "session", f.subjectId),
  };
  expect(await listIds(f, { authorizationScope: intersected })).toEqual(
    new Set([f.own.id, f.child.id]),
  );
  const discovered = await listSessionDiscoverySummaries(db, f.workspaceId, {
    limit: 100,
    subjectId: f.subjectId,
    authorizationScope: intersected,
  });
  expect(new Set(discovered.sessions.map((row) => row.id))).toEqual(
    new Set([f.own.id, f.child.id]),
  );
  expect(discovered.total).toBe(2);
}, 30_000);

test("ownership scope kind and subject bind list, search and discovery continuations", async () => {
  if (!available) return;
  const f = await ownershipFixture();
  const authorizationScope = { kind: "owned" as const, subjectId: f.subjectId };
  const listOptions = {
    subjectId: f.subjectId,
    authorizationScope,
    limit: 1,
    includePinned: false,
    materializeSnapshot: true,
  };
  const page = await listSessionEntriesForSubject(db, f.workspaceId, listOptions);
  expect(page.nextCursor).not.toBeNull();
  const cursor = decodeSessionListCursor(page.nextCursor!)!;
  expect(
    (await listSessionEntriesForSubject(db, f.workspaceId, { ...listOptions, cursor })).sessions,
  ).toHaveLength(1);
  const searchOptions = { query: "ownership-search-token", limit: 1 };
  const search = await searchSessionMessagesForSubject(db, f.workspaceId, searchOptions, {
    subjectId: f.subjectId,
    authorizationScope,
  });
  expect(search.nextCursor).not.toBeNull();
  const discovery = await listSessionDiscoverySummaries(db, f.workspaceId, {
    limit: 1,
    subjectId: f.subjectId,
    authorizationScope,
  });
  expect(discovery.nextCursor).not.toBeNull();
  for (const changedScope of [
    { kind: "owned" as const, subjectId: f.member },
    { kind: "owned_or_shared" as const, subjectId: f.subjectId },
    { kind: "all" as const },
  ]) {
    await expect(
      listSessionEntriesForSubject(db, f.workspaceId, {
        ...listOptions,
        cursor,
        authorizationScope: changedScope,
      }),
    ).rejects.toThrow("cursor");
    await expect(
      searchSessionMessagesForSubject(
        db,
        f.workspaceId,
        { ...searchOptions, cursor: search.nextCursor! },
        { subjectId: f.subjectId, authorizationScope: changedScope },
      ),
    ).rejects.toThrow("cursor");
    await expect(
      listSessionDiscoverySummaries(db, f.workspaceId, {
        limit: 1,
        subjectId: f.subjectId,
        authorizationScope: changedScope,
        cursor: discovery.nextCursor!,
      }),
    ).rejects.toThrow("cursor");
  }
}, 30_000);
