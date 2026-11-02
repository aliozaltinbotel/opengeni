import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import {createHash} from "node:crypto";
import {ExternalIdentity} from "@opengeni/contracts/external-identities";
import {addExternalWorkspaceMemberForRequest, updateExternalWorkspaceMemberPermissionsForRequest, cancelExternalWorkspaceMemberGrantForRequest} from "@opengeni/core";
import { signDelegatedAccessToken, KnowledgeEntryWriteReceipt, KnowledgeEntryRecord, type KnowledgeEntryListResponse } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  ensureManagedAccessForUser,
  listSelfOrganizationMemberships,
  createOrganizationSharedWorkspace,
  createOrganizationApiKey,
  createDb,
  saveKnowledgeEntry,
  type KnowledgeContext,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerKnowledgeRoutes } from "../src/routes/knowledge";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-created-since-api");
  if (!acquired) throw new Error("Knowledge creation-date API verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("list query strings and search JSON apply the same creation cutoff, pagination and date validation", async () => {
  const secret = "knowledge-created-since-api-test";
  const subjectId = `user:${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Knowledge cutoff",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const context: KnowledgeContext = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace"],
      review: true,
      settingsScopes: ["workspace"],
    },
  };
  const saved = [];
  for (let index = 0; index < 3; index++)
    saved.push(
      await saveKnowledgeEntry(client.db, context, {
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        entry: { kind: "fact", title: "Creation cutoff", content: "Creation cutoff regression" },
      }),
    );
  await shared.admin`UPDATE knowledge_entries SET created_at='2026-09-01T00:00:00Z',updated_at='2026-10-06T08:00:00Z'
    WHERE id=${saved[0]!.entryId}`;
  await shared.admin`UPDATE knowledge_entries SET created_at='2026-10-01T00:00:00Z'
    WHERE id IN (${saved[1]!.entryId},${saved[2]!.entryId})`;
  const expected = saved
    .slice(1)
    .map((entry) => entry.entryId)
    .sort();
  const settings = testSettings({ productAccessMode: "managed", delegationSecret: secret });
  const app = new Hono();
  registerKnowledgeRoutes(app, {
    settings,
    db: client.db,
    managedAuth: null,
    getDocumentServices: () => ({ embedder: null }),
  } as unknown as ApiRouteDeps);
  const authorization = `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: ["documents:search"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const base = `http://test/v1/workspaces/${grant.workspaceId}/knowledge/entries`;
  for (const method of ["GET", "POST"] as const) {
    const request = async (input: Record<string, string | number>) => {
      return method === "GET"
        ? app.request(
            `${base}?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}`,
            { headers: { authorization } },
          )
        : app.request(`${base}/search`, {
            method,
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify(input),
          });
    };
    const input = {
      query: "Creation",
      mode: "keyword",
      createdSince: "2026-10-01T00:00:00Z",
      limit: 1,
    };
    const response = await request(input);
    expect(response.status).toBe(200);
    const page = (await response.json()) as KnowledgeEntryListResponse;
    expect(page.entries.map((entry) => entry.id)).toEqual(expected.slice(0, 1));
    expect(page.nextCursor).not.toBeNull();
    const second = await request({ ...input, cursor: page.nextCursor! });
    expect(second.status).toBe(200);
    const next = (await second.json()) as KnowledgeEntryListResponse;
    expect(next.entries.map((entry) => entry.id)).toEqual(expected.slice(1));
    expect(next.nextCursor).toBeNull();
    expect(
      (await request({ ...input, createdSince: "2026-10-02T00:00:00Z", cursor: page.nextCursor! }))
        .status,
    ).toBe(422);
    for (const createdSince of ["invalid", "2026-10-01", "2026-10-01T00:00:00"])
      expect((await request({ ...input, createdSince })).status).toBe(422);
  }
}, 180_000);


test("human save refuses current external document revocation after body admission without native writes", async () => {
  const secret = "knowledge-human-proposal-revocation-test";
  const ownerId = crypto.randomUUID(), ownerSubject = `user:${ownerId}`, subjectId = `user:${crypto.randomUUID()}`;
  await ensureManagedAccessForUser(client.db, {userId: ownerId, email: `${ownerId}@example.test`, name: "Synthetic proposal owner"});
  const [organization] = await listSelfOrganizationMemberships(client.db, ownerSubject);
  expect(organization).toBeDefined();
  const organizationId = organization!.organizationId;
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {accountId: organizationId, name: "Synthetic proposal service", prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"), permissions: ["workspace:read", "documents:search", "documents:manage", "members:manage"]});
  const deps = {settings: testSettings({productAccessMode: "configured"}), db: client.db, managedAuth: null,
    getDocumentServices: () => ({embedder: null})} as unknown as ApiRouteDeps;
  const app = new Hono();
  registerKnowledgeRoutes(app, deps);
  // Mount the installed host member owners unchanged; the subject is prepared before the save, never by it.
  app.post("/fixture-members/:workspaceId", async c => c.json(await addExternalWorkspaceMemberForRequest(c, deps, c.req.param("workspaceId"), await c.req.json())));
  app.patch("/fixture-members/:workspaceId/:subjectId", async c => c.json(await updateExternalWorkspaceMemberPermissionsForRequest(c, deps, c.req.param("workspaceId"), c.req.param("subjectId"), await c.req.json())));
  app.post("/fixture-revoke/:workspaceId/:membershipId", async c => c.json(await cancelExternalWorkspaceMemberGrantForRequest(c, deps, organizationId, c.req.param("workspaceId"), c.req.param("membershipId"), await c.req.json())));
  const service = {authorization: `Bearer ${token}`, "content-type": "application/json"};
  const writes = async () => (await shared.admin<Array<{entries: number; revisions: number; operations: number; reviews: number}>>`
    SELECT (SELECT count(*)::int FROM knowledge_entries WHERE account_id=${organizationId}) entries,
      (SELECT count(*)::int FROM knowledge_entry_revisions WHERE account_id=${organizationId}) revisions,
      (SELECT count(*)::int FROM knowledge_entry_operations WHERE account_id=${organizationId}) operations,
      (SELECT count(*)::int FROM knowledge_review_batches WHERE account_id=${organizationId}) reviews`)[0];
  for (const reviewMode of [undefined, "review_first"] as const)
    for (const scope of ["personal", "workspace"] as const) for (const revoke of ["permission", "membership", "cancel"] as const) {
    const workspace = await createOrganizationSharedWorkspace(client.db, {organizationId, actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(), name: "Synthetic pending proposal"});
    const identity = {source: "cendra", externalId: `${subjectId}:${reviewMode ?? "automatic"}:${scope}:${revoke}`}, grantOperationId = crypto.randomUUID();
    const onboarded = await app.request(`/fixture-members/${workspace.id}`, {method: "POST", headers: service,
      body: JSON.stringify({identity, permissions: ["documents:search", "documents:manage"], operationId: grantOperationId})});
    expect(onboarded.status).toBe(200);const member = ExternalIdentity.parse(await onboarded.json());
    const headers = {...service, "x-opengeni-external-actor": encodeURIComponent(JSON.stringify({mode: "external", identity, existingOnly: true}))};
    const body = {operationId: crypto.randomUUID(), expectedVersion: 0, scope, ...(reviewMode === undefined ? {} : {reviewMode}),
      entry: {kind: "fact", title: "Synthetic pending proposal", content: "Synthetic retained observation."}};
    const post = (payload: unknown, callerHeaders = headers) => app.request(`http://test/v1/workspaces/${workspace.id}/knowledge/entries`, {
      method: "POST", headers: callerHeaders, body: JSON.stringify(payload),
    });
    const readonlyIdentity = {...identity, externalId: identity.externalId + ":readonly"};
    expect((await app.request(`/fixture-members/${workspace.id}`, {method: "POST", headers: service,
      body: JSON.stringify({identity: readonlyIdentity, permissions: ["documents:search"], operationId: crypto.randomUUID()})})).status).toBe(200);
    const readonlyHeaders = {...service, "x-opengeni-external-actor": encodeURIComponent(JSON.stringify({mode: "external", identity: readonlyIdentity, existingOnly: true}))};
    expect((await post(body, readonlyHeaders)).status).toBe(403);
    const control = await post({...body, operationId: crypto.randomUUID()});expect(control.status).toBe(201);
    const controlReceipt = KnowledgeEntryWriteReceipt.parse(await control.json());
    expect(controlReceipt.outcome).toBe(reviewMode === undefined ? "published" : "pending");
    const before = await writes();
    let releaseBody: () => void = () => {}, bodyRequested: () => void = () => {};
    const held = new Promise<void>(resolve => {releaseBody = resolve;}), entered = new Promise<void>(resolve => {bodyRequested = resolve;});
    const stream = new ReadableStream<Uint8Array>({async pull(controller) {
      bodyRequested(); await held; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close();
    }}, {highWaterMark: 0});
    const controller = new AbortController();
    const pending = app.request(`http://test/v1/workspaces/${workspace.id}/knowledge/entries`, {
      method: "POST", headers, body: stream, signal: controller.signal,
    });
    try {
      await Promise.race([entered, pending.then(() => {throw new Error("REQUEST_ENDED_BEFORE_BODY_ADMISSION");})]);
      if (revoke === "cancel") controller.abort();
      else {
        const revoked = revoke === "permission"
          ? await app.request(`/fixture-members/${workspace.id}/${member.subjectId}`, {method: "PATCH", headers: service,
            body: JSON.stringify({identity, expectedPermissions: ["documents:search", "documents:manage"], permissions: ["documents:search"]})})
          : await app.request(`/fixture-revoke/${workspace.id}/${member.organizationMembershipId}`, {method: "POST", headers: service,
            body: JSON.stringify({operationId: crypto.randomUUID(), cancelGrantOperationId: grantOperationId})});
        expect(revoked.status).toBe(200);
      }
      releaseBody();
      const response = await pending;
      if (revoke === "cancel") expect(response.status).not.toBe(201);
      else expect(response.status).toBe(403);
      expect(await writes()).toEqual(before);
      if (revoke === "cancel") {
        const retry = await post(body);expect(retry.status).toBe(201);
        const saved = KnowledgeEntryWriteReceipt.parse(await retry.json());
        const replay = await post(body);expect(replay.status).toBe(200);
        expect(KnowledgeEntryWriteReceipt.parse(await replay.json())).toEqual({...saved, replayed: true});
      }
    } finally {releaseBody(); await pending.catch(() => undefined);}
  }
}, 180_000);

test("human public save can require pending review without new document authority", async () => {
  const secret = "knowledge-human-proposal-api-test";
  const subjectId = `user:${crypto.randomUUID()}`;
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test", accountExternalId: identity, accountName: "Synthetic proposal account",
    workspaceExternalSource: "test", workspaceExternalId: identity, workspaceName: "Synthetic proposal workspace", subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const settings = testSettings({ productAccessMode: "managed", delegationSecret: secret });
  const app = new Hono();
  registerKnowledgeRoutes(app, { settings, db: client.db, managedAuth: null, getDocumentServices: () => ({ embedder: null }) } as unknown as ApiRouteDeps);
  const token = async (permissions: typeof grant.permissions) => `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: grant.accountId, workspaceId: grant.workspaceId, subjectId, principalKind: "human_session", permissions,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const owner = await token(["workspace:admin"]);
  const reader = await token(["documents:search"]);
  const base = `http://test/v1/workspaces/${grant.workspaceId}/knowledge/entries`;
  const request = { operationId: crypto.randomUUID(), expectedVersion: 0, scope: "personal", reviewMode: "review_first",
    entry: { title: "Synthetic personal proposal", kind: "fact", content: "Synthetic retained observation." } };
  const post = (authorization: string, body: unknown) => app.request(base, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await post(reader, request)).status).toBe(403);
  const response = await post(owner, request);
  expect(response.status).toBe(201);
  const receipt = KnowledgeEntryWriteReceipt.parse(await response.json());
  expect(receipt.outcome).toBe("pending");
  expect(receipt.replayed).toBe(false);
  expect((await app.request(`${base}/${receipt.entryId}`, { headers: { authorization: owner } })).status).toBe(404);
  const pending = await app.request(`${base}/${receipt.entryId}?view=needs_review`, { headers: { authorization: owner } });
  expect(pending.status).toBe(200);
  expect(KnowledgeEntryRecord.parse(await pending.json()).revision.id).toBe(receipt.revisionId);
  const replay = await post(owner, request);
  expect(replay.status).toBe(200);
  expect(KnowledgeEntryWriteReceipt.parse(await replay.json()).replayed).toBe(true);
  const { reviewMode: _reviewMode, ...ordinary } = request;
  expect((await post(owner, ordinary)).status).toBe(409);
  const ordinarySave = await post(owner, { ...ordinary, operationId: crypto.randomUUID() });
  expect(ordinarySave.status).toBe(201);
  expect(KnowledgeEntryWriteReceipt.parse(await ordinarySave.json()).outcome).toBe("published");
  const rows = await shared.admin<{ count: number }[]>`SELECT count(*)::integer AS count FROM knowledge_entries WHERE account_id=${grant.accountId}`;
  expect(rows[0]?.count).toBe(2);
}, 180_000);
