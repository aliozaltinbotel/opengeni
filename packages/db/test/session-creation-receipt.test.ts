import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  createSessionWithIdempotencyKeyResult,
  getSessionCreationReceipt,
  type DbClient,
  type SessionCreateInput,
} from "../src";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const database = await acquireSharedTestDatabase("session-creation-receipt");
  if (!database) throw new Error("Session creation receipt requires PostgreSQL");
  shared = database;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(): Promise<SessionCreateInput & { createIdempotencyKey: string }> {
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('receipt fixture') returning id`;
  const [workspace] =
    await shared.admin`insert into workspaces (account_id, name) values (${account!.id}, 'receipt fixture') returning id`;
  await shared.admin`insert into workspace_inference_controls (account_id, workspace_id) values (${account!.id}, ${workspace!.id})`;
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    requestedSessionId: crypto.randomUUID(),
    initialMessage: "Synthetic receipt fixture",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createIdempotencyKey: crypto.randomUUID(),
    subjectId: "service:receipt-fixture",
    createdBy: { kind: "service", subjectId: "service:receipt-fixture" },
    creationReceiptRequest: {
      requestSha256: "a".repeat(64),
      creatorSubjectId: "service:receipt-fixture",
      authenticatedSubjectId: "service:receipt-fixture",
      authenticatedPrincipalKind: "api_key",
    },
  };
}

test("creation receipt commits with a keyed shell before startup and remains exact on replay", async () => {
  const input = await fixture();
  const first = await createSessionWithIdempotencyKeyResult(client.db, input);
  if (first.denied) throw new Error("Unexpected fixture denial");
  const proof = await getSessionCreationReceipt(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: first.session.id,
  });
  expect(proof).toEqual({
    version: 1,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.requestedSessionId,
    idempotencyKey: input.createIdempotencyKey,
    ...input.creationReceiptRequest,
  });
  const replay = await createSessionWithIdempotencyKeyResult(client.db, input);
  if (replay.denied) throw new Error("Unexpected replay denial");
  expect(replay.created).toBe(false);
  expect(
    await getSessionCreationReceipt(client.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: replay.session.id,
    }),
  ).toEqual(proof);
  const partial = await createSessionWithIdempotencyKeyResult(client.db, {
    ...input,
    creationReceiptRequest: { ...input.creationReceiptRequest!, requestSha256: "b".repeat(64) },
  });
  if (partial.denied) throw new Error("Unexpected partial replay denial");
  expect(
    await getSessionCreationReceipt(client.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: partial.session.id,
    }),
  ).toEqual(proof);
});

test("a replay cannot mint proof for a legacy shell or trust a payload metadata claim", async () => {
  const { creationReceiptRequest: _omitted, ...input } = await fixture();
  input.metadata = {
    _opengeni_session_creation_receipt_v1: { version: 1, requestSha256: "a".repeat(64) },
  };
  const first = await createSessionWithIdempotencyKeyResult(client.db, input);
  if (first.denied) throw new Error("Unexpected fixture denial");
  expect(
    await getSessionCreationReceipt(client.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: first.session.id,
    }),
  ).toBeNull();
  const replay = await createSessionWithIdempotencyKeyResult(client.db, {
    ...input,
    creationReceiptRequest: {
      requestSha256: "a".repeat(64),
      creatorSubjectId: "service:receipt-fixture",
      authenticatedSubjectId: "service:receipt-fixture",
      authenticatedPrincipalKind: "api_key",
    },
  });
  if (replay.denied) throw new Error("Unexpected replay denial");
  expect(
    await getSessionCreationReceipt(client.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: replay.session.id,
    }),
  ).toBeNull();
});

test("receipt column rejects overwrite, erasure and legacy upgrade while ordinary metadata remains mutable", async () => {
  const input = await fixture();
  const created = await createSessionWithIdempotencyKeyResult(client.db, input);
  if (created.denied) throw new Error("Unexpected fixture denial");
  const proof = await getSessionCreationReceipt(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: created.session.id,
  });
  await shared.admin`set statement_timeout='10s'`;
  await shared.admin`update sessions set metadata = '{"synthetic":"updated"}'::jsonb where id=${created.session.id}`;
  await expect(
    (async () =>
      await shared.admin`update sessions set creation_receipt=null where id=${created.session.id}`)(),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    (async () =>
      await shared.admin`update sessions set creation_receipt=jsonb_set(creation_receipt,'{requestSha256}','"forged"') where id=${created.session.id}`)(),
  ).rejects.toMatchObject({ code: "42501" });
  const { creationReceiptRequest: _omitted, ...legacyInput } = await fixture();
  const legacy = await createSessionWithIdempotencyKeyResult(client.db, legacyInput);
  if (legacy.denied) throw new Error("Unexpected legacy denial");
  await expect(
    (async () =>
      await shared.admin`update sessions set creation_receipt=${shared.admin.json(proof!)} where id=${legacy.session.id}`)(),
  ).rejects.toMatchObject({ code: "42501" });
  expect(
    await getSessionCreationReceipt(client.db, {
      accountId: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      sessionId: created.session.id,
    }),
  ).toBeNull();
  expect(
    await getSessionCreationReceipt(client.db, {
      accountId: input.accountId,
      workspaceId: legacyInput.workspaceId,
      sessionId: created.session.id,
    }),
  ).toBeNull();
}, 30_000);
