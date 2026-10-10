import { afterEach, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import * as database from "@opengeni/db";
import * as temporal from "@temporalio/client";
import { createHash } from "node:crypto";
import { KnowledgeEntryRecord, KnowledgeEntrySummary, KnowledgeSavePreparationResponse,
  type KnowledgeEntryListResponse } from "@opengeni/contracts";
import type { KnowledgeQueryWorkflowRequest } from "@opengeni/core";
import { createTemporalWorkflowClient } from "../src/index";

test("the retired search path never invokes the old document retrieval lane", async () => {
  const settings = testSettings({ productAccessMode: "managed" });
  const workspaceId = crypto.randomUUID();
  const authorization = `Bearer ${await signDelegatedAccessToken(settings.delegationSecret!, {
    accountId: crypto.randomUUID(),
    workspaceId,
    subjectId: "user:knowledge-search",
    permissions: ["documents:search"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const app = createApp({
    settings,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const response = await app.request(`/v1/workspaces/${workspaceId}/knowledge/search`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ query: "retired path", limit: 50 }),
  });
  expect(response.status).toBe(410);
});


const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
function retainedKnowledge() {
  const id = crypto.randomUUID(), revisionId = crypto.randomUUID();
  const record = KnowledgeEntryRecord.parse({ id, scope: "workspace", version: 1,
    publishedRevisionId: revisionId, latestRevisionId: revisionId, archived: false,
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    revision: { id: revisionId, entryId: id, number: 1, change: "upsert", previousRevisionId: null,
      restoredFromRevisionId: null, createdAt: "2026-10-01T00:00:00Z", createdBySessionId: null,
      reviewBatchId: null, outcome: "published", entry: { kind: "group", title: "Retained source",
        content: "Retained description", groupIds: [], evidence: [], relationships: [] } } });
  const { entry, ...revision } = record.revision;
  const summary = KnowledgeEntrySummary.parse({ ...record, revision: { ...revision,
    title: entry.title, kind: entry.kind, preview: entry.content, groupIds: entry.groupIds, sourceKind: null },
    excerpts: [{ field: "content", start: 0, end: entry.content.length, text: entry.content }] });
  return { record, summary };
}
async function knowledgeClient<T>(input: KnowledgeQueryWorkflowRequest, retained: T, options: {
  duplicate?: boolean; beforeReturn?: () => void;
} = {}) {
  const scope = {} as database.Database;
  const start = spyOn(temporal, "Client").mockImplementation((() => ({ workflow: {
    start: async () => { if (options.duplicate !== false)
      throw new temporal.WorkflowExecutionAlreadyStartedError("duplicate", "workflow", "knowledgeQueryWorkflow"); },
    getHandle: () => ({ query: async () => createHash("sha256").update(JSON.stringify({ context: input.context, request: input.request })).digest("hex"),
      result: async () => { options.beforeReturn?.(); return retained; } }),
  } })) as never); spies.push(start);
  spies.push(spyOn(temporal.Connection, "connect").mockResolvedValue({ close: async () => {} } as never));
  spies.push(spyOn(database, "withRlsContext").mockImplementation(async (_db, _scope, read) => read(scope)));
  const key = spyOn(database, "findActiveWorkspaceApiKeyById").mockResolvedValue({ accountId: input.context.accountId,
    permissions: ["documents:search"], permissionMode: "explicit" } as never); spies.push(key);
  spies.push(spyOn(database, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(undefined));
  spies.push(spyOn(database, "withWorkspaceSubjectRls").mockImplementation(async (_db, _workspace, _subject, read) => read(scope)));
  spies.push(spyOn(database, "getWorkspaceGrant").mockResolvedValue(input.grant as never));
  const read = spyOn(database, "getKnowledgeEntry"); spies.push(read);
  const owner = await createTemporalWorkflowClient(testSettings(), {} as database.Database);
  return { owner, read, key, scope };
}
function retainedInput(): KnowledgeQueryWorkflowRequest {
  const accountId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), subjectId = `api_key:${crypto.randomUUID()}`;
  return { context: { accountId, workspaceId, actor: { kind: "service", principalKind: "api_key", subjectId,
    writeScopes: [], settingsScopes: [], review: false } },
    grant: { accountId, workspaceId, subjectId, principalKind: "api_key", permissions: ["documents:search"] },
    externalContinuation: null, operationId: "retained", request: { query: "retained", mode: "keyword" } };
}

test("completed Knowledge replay rereads the exact required revision and refuses withdrawn visibility", async () => {
  const input = retainedInput(), { record, summary } = retainedKnowledge();
  const retained: KnowledgeEntryListResponse = { entries: [summary], nextCursor: null, searchMode: "keyword" };
  const { owner, read, key, scope } = await knowledgeClient(input, retained);
  read.mockResolvedValue(record);
  expect(await owner.client.queryKnowledge!(input)).toEqual(retained);
  expect(read.mock.calls.at(-1)).toEqual([scope, input.context, record.id,
    { revisionId: record.revision.id, view: "published" }]);
  read.mockResolvedValue(null);
  await expect(owner.client.queryKnowledge!(input)).rejects.toThrow("KNOWLEDGE_QUERY_RESULT_UNAVAILABLE");
  const priorReads = read.mock.calls.length;
  key.mockResolvedValue(null);
  await expect(owner.client.queryKnowledge!(input)).rejects.toThrow("KNOWLEDGE_QUERY_AUTHORITY_UNAVAILABLE");
  expect(read.mock.calls.length).toBe(priorReads);
  await owner.close();
});

test("fresh delayed Knowledge result checks visibility after workflow return", async () => {
  const input = retainedInput(), { record, summary } = retainedKnowledge();
  let withdrawn = false;
  const { owner, read } = await knowledgeClient(input, { entries: [summary], nextCursor: null }, {
    duplicate: false, beforeReturn: () => { withdrawn = true; } });
  read.mockImplementation(async () => withdrawn ? null : record);
  await expect(owner.client.queryKnowledge!(input)).rejects.toThrow("KNOWLEDGE_QUERY_RESULT_UNAVAILABLE");
  expect(read).toHaveBeenCalledTimes(1);
  await owner.close();
});

test("retained preparation authenticates all matches and collection descriptors before disclosure", async () => {
  const input = retainedInput(), published = retainedKnowledge(), pending = retainedKnowledge(), collection = retainedKnowledge();
  pending.record.revision.outcome = "pending";
  pending.summary.revision.outcome = "pending";
  const retained = KnowledgeSavePreparationResponse.parse({ matches: {
    published: { entries: [published.summary], nextCursor: null }, needs_review: { entries: [pending.summary], nextCursor: null } },
    collections: { entries: [{ id: collection.record.id, revisionId: collection.record.revision.id, version: 1,
      scope: "workspace", view: "published", title: collection.record.revision.entry.title,
      description: collection.record.revision.entry.content, descriptionTruncated: false, parentIds: [] }],
      complete: true, nextCursors: { published: null, needs_review: null } } });
  const subjectId = "user:retained-reviewer";
  input.context.actor = { kind: "human", principalKind: "human_session", subjectId,
    writeScopes: ["workspace"], settingsScopes: [], review: true };
  input.grant = { ...input.grant, principalKind: "human_session", subjectId, permissions: ["documents:search", "documents:manage"] };
  input.request = { query: "retained" };
  const { owner, read } = await knowledgeClient(input, retained);
  const prepare = () => owner.client.prepareKnowledge!({ ...input, request: { query: "retained" } });
  read.mockImplementation(async (_db, _context, id) => [published, pending, collection].find(value => value.record.id === id)!.record);
  expect(await prepare()).toEqual(retained);
  expect(read.mock.calls.map(call => [call[2], call[3]])).toEqual([
    [published.record.id, { revisionId: published.record.revision.id, view: "published" }],
    [pending.record.id, { revisionId: pending.record.revision.id, view: "needs_review" }],
    [collection.record.id, { revisionId: collection.record.revision.id, view: "published" }],
  ]);
  for (const hidden of [published, pending, collection]) {
    read.mockImplementation(async (_db, _context, id) => id === hidden.record.id ? null
      : [published, pending, collection].find(value => value.record.id === id)!.record);
    await expect(prepare()).rejects.toThrow("KNOWLEDGE_QUERY_RESULT_UNAVAILABLE");
  }
  await owner.close();
});
