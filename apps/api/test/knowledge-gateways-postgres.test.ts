import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessGrant } from "@opengeni/contracts";
import {
  knowledgeContextForGateway,
  requireAccessGrantAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createDb,
  createApiKey,
  createFileUpload,
  saveKnowledgeEntry,
  withSessionRlsActorContext,
  type KnowledgeContext,
} from "@opengeni/db";
import { acquireSharedTestDatabase, testSettings, type SharedTestDatabase } from "@opengeni/testing";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createTemporalWorkflowClient } from "../src/index";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createKnowledgeIndexingActivities } from "../../worker/src/activities/knowledge-indexing";
import type { ControlActivityServices } from "../../worker/src/activities/types";
import type { DocumentServices } from "@opengeni/documents";
import { buildFilesMcpServer } from "../src/mcp/files";
import { buildDocumentsMcpServer } from "../src/mcp/documents";

let shared: SharedTestDatabase;
let database: ReturnType<typeof createDb>;
const ownerSettings = testSettings({ productAccessMode: "managed",
  temporalHost: process.env.OPENGENI_TEST_TEMPORAL_ADDRESS,
  temporalNamespace: process.env.OPENGENI_TEST_TEMPORAL_NAMESPACE ?? "default",
  temporalTaskQueue: `knowledge-gateways-${crypto.randomUUID()}` });
let temporalOwner: Awaited<ReturnType<typeof createTemporalWorkflowClient>>;
let native: NativeConnection;
let worker: Worker;
let workerRun: Promise<void>;
beforeAll(async () => {
  if (!process.env.OPENGENI_TEST_TEMPORAL_ADDRESS) throw new Error("Knowledge gateway verification requires the coordinated Temporal fixture");
  const acquired = await acquireSharedTestDatabase("knowledge-gateways");
  if (!acquired) throw new Error("Knowledge gateway verification requires PostgreSQL");
  shared = acquired;
  database = createDb(shared.appUrl, { max: 6 });
  native = await NativeConnection.connect({ address: ownerSettings.temporalHost });
  worker = await Worker.create({ connection: native, namespace: ownerSettings.temporalNamespace,
    taskQueue: ownerSettings.temporalTaskQueue,
    workflowBundle: { codePath: new URL("../../worker/dist/workflow-bundle.js", import.meta.url).pathname },
    activities: createKnowledgeIndexingActivities(async () => ({ db: database.db, settings: ownerSettings,
      observability: { warn: () => {} } }) as ControlActivityServices, async () => ({}) as DocumentServices),
    maxConcurrentActivityTaskExecutions: 2, maxConcurrentWorkflowTaskExecutions: 2 });
  workerRun = worker.run(); void workerRun.catch(() => undefined);
  temporalOwner = await createTemporalWorkflowClient(ownerSettings, database.db);
}, 900_000);
afterAll(async () => {
  await temporalOwner?.close(); worker?.shutdown(); await workerRun; await native?.close();
  await database?.close();
  await shared?.release();
}, 180_000);

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>) {
  const client = new Client({ name: "knowledge-gateway-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("Files MCP distinguishes a verified owner from delegated subject labels", async () => {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID(),
    fileId = crypto.randomUUID();
  const subjectId = "user:private-files-owner";
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'MCP account')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'MCP workspace')`;
  await withSessionRlsActorContext({ subjectId, privateFileOwnerSubjectId: subjectId }, () =>
    createFileUpload(database.db, {
      accountId,
      workspaceId,
      fileId,
      privateOwnerSubjectId: subjectId,
      filename: "Private.pdf",
      safeFilename: "Private.pdf",
      contentType: "application/pdf",
      sizeBytes: 123,
      bucket: "test",
      objectKey: fileId,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );
  await shared.admin`UPDATE files SET status='ready' WHERE id=${fileId}`;
  let signed = 0;
  const deps = {
    db: database.db,
    objectStorage: {
      createGetUrl: async () => {
        signed++;
        return { url: "https://storage.invalid/private", expiresAt: new Date(Date.now() + 60_000) };
      },
    },
  } as ApiRouteDeps;
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: ["files:read"],
  };
  const verified: AccessGrantAuthorization = {
    grant,
    accountGrant: null,
    contextIntegrity: true,
    authenticatedSubjectId: subjectId,
    canonicalManagedHumanSession: true,
  };
  const call = (authority: AccessGrant | AccessGrantAuthorization) =>
    withClient(buildFilesMcpServer(deps, authority), (client) =>
      client.callTool({ name: "files_get_download_url", arguments: { fileId } }),
    );
  expect((await call(grant)).isError).toBe(true);
  expect((await call({ ...verified, contextIntegrity: false })).isError).toBe(true);
  expect((await call({ ...verified, authenticatedSubjectId: "user:someone-else" })).isError).toBe(
    true,
  );
  expect(signed).toBe(0);
  const result = await call(verified);
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result)).toContain("https://storage.invalid/private");
  expect(signed).toBe(1);
});

test("the delegated docs gateway exposes canonical Knowledge without private or review authority", async () => {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID(),
    subjectId = "user:gateway-owner";
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Knowledge gateway')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Knowledge gateway')`;
  const human: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["personal", "workspace"],
      review: true,
      settingsScopes: ["personal", "workspace"],
    },
  };
  const saved = [];
  for (const scope of ["workspace", "personal"] as const)
    saved.push(
      await saveKnowledgeEntry(database.db, human, {
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        expectedVersion: 0,
        scope,
        entry: {
          kind: "fact",
          title: `Acme ${scope}`,
          content: `Acme ${scope} terms. Renewal date: 1 December 2026.`,
        },
      }),
    );
  // A delegated shared-only gateway uses a real scoped credential and current
  // canonical request authorization, never a human subject label as authority.
  const key = `og_test_${crypto.randomUUID()}`;
  await createApiKey(database.db, { accountId, workspaceId, name: "Knowledge gateway",
    prefix: key.slice(0, 12), keyHash: createHash("sha256").update(key).digest("hex"), permissions: ["documents:search"] });
  let authorization: AccessGrantAuthorization | undefined;
  const accessApp = new Hono();
  accessApp.get("/", async c => {
    authorization = await requireAccessGrantAuthorization(c, { db: database.db, settings: ownerSettings }, workspaceId, "documents:search");
    return c.json({ authorized: true });
  });
  expect((await accessApp.request("http://test/", { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
  if (!authorization) throw new Error("Verified gateway authorization unavailable");
  const grant = authorization.grant;
  const context = await knowledgeContextForGateway({ db: database.db }, grant);
  const server = buildDocumentsMcpServer(database.db, accountId, workspaceId, {} as never, {
    knowledge: context,
    settings: ownerSettings,
    queryOwner: { grant, externalContinuation: null, nativeContinuation: null, query: temporalOwner.client.queryKnowledge! },
  });
  await withClient(server, async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "knowledge_browse",
      "knowledge_get",
      "knowledge_search",
    ]);
    const found = await client.callTool({
      name: "knowledge_search",
      arguments: { query: "Acme", mode: "keyword" },
    });
    expect(found.isError).not.toBe(true);
    const text = (found.content as Array<{ type: string; text?: string }>).find(
      (item) => item.type === "text",
    )!.text!;
    expect(JSON.parse(text).entries.map((entry: { id: string }) => entry.id)).toEqual([
      saved[0]!.entryId,
    ]);
    const fallback = await client.callTool({
      name: "knowledge_search",
      arguments: { query: "Acme renewal renew contract expiration renewal date", mode: "hybrid" },
    });
    expect(fallback.isError).not.toBe(true);
    const fallbackText = (fallback.content as Array<{ type: string; text?: string }>).find(
      (item) => item.type === "text",
    )!.text!;
    const results = JSON.parse(fallbackText);
    expect(results.searchMode).toBe("keyword");
    expect(results.fallbackReason).toBe("provider_unavailable");
    const usage = await shared.admin`SELECT count(*)::int AS count FROM usage_events
      WHERE account_id=${accountId} AND event_type='embedding.call'`;
    expect(usage[0]?.count).toBe(0);
    expect(results.entries.map((entry: { id: string }) => entry.id)).toEqual([saved[0]!.entryId]);
    const retained = await client.callTool({
      name: "knowledge_get",
      arguments: { entryId: saved[0]!.entryId },
    });
    expect(JSON.stringify(retained)).toContain("1 December 2026");
    const hidden = await client.callTool({
      name: "knowledge_get",
      arguments: { entryId: saved[1]!.entryId },
    });
    expect(JSON.stringify(hidden)).not.toContain("Acme personal terms");
  });
});
