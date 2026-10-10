import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Context } from "@temporalio/activity";
import { AsyncLocalStorage } from "node:async_hooks";
import * as database from "@opengeni/db";
import { KnowledgeEntryListRequest, KnowledgeSavePreparationRequest, signDelegatedAccessToken, EmbeddingCallUsageAttributes, EmbeddingCallUsageAttributesV1, EmbeddingCallUsageSource } from "@opengeni/contracts";
import { knowledgeQueryOperationId, nativeAccessContinuationForAuthorization, requireAccessGrantAuthorization, type KnowledgeQueryWorkflowRequest } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { createKnowledgeIndexingActivities } from "../src/activities/knowledge-indexing";
import type { ControlActivityServices } from "../src/activities/types";
import type { DocumentServices } from "@opengeni/documents";

const accountId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), keyId = crypto.randomUUID();
const context: database.KnowledgeContext = { accountId, workspaceId, actor: { kind: "service", principalKind: "api_key",
  subjectId: `api_key:${keyId}`, writeScopes: [], settingsScopes: [], review: false } };
const grant: KnowledgeQueryWorkflowRequest["grant"] = { accountId, workspaceId, subjectId: context.actor.kind === "service" ? context.actor.subjectId : "",
  principalKind: "api_key", permissions: ["documents:search"] };
const settings = testSettings({ documentEmbeddingProvider: "openai", documentEmbeddingBillingMode: "credits",
  documentEmbeddingRateMicrosPerMillionBytes: 1_000_000 });
const root = {} as database.Database, transaction = {} as database.Database;
let locked = false, balance = 10, tail: Promise<void> = Promise.resolve();
const transactionContext = new AsyncLocalStorage<boolean>();
const activityContext = new AsyncLocalStorage<string>();
type Fact = Parameters<typeof database.recordUsageEvent>[1];
const facts = new Map<string, Fact>();
const producedQueryFacts: Array<{ scenario: string; events: Fact[] }> = [];
function retainProducedQueryFacts(scenario: string) {
  producedQueryFacts.push({ scenario, events: structuredClone([...facts.values()].filter(row =>
    row.eventType === "knowledge.query.dispatched" || row.eventType === "knowledge.query.indeterminate" || row.eventType === "embedding.call")) });
}
afterAll(async () => {
  const file = process.env.OPENGENI_TEST_NATIVE_EMBEDDING_FIXTURE_FILE;
  if (file) await Bun.write(file, JSON.stringify({ producer: "actual native query Temporal activities and core writer", cases: producedQueryFacts }, null, 2) + "\n");
});
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  locked = false; balance = 10; tail = Promise.resolve(); facts.clear();
  spies.push(spyOn(Context, "current").mockImplementation(() => ({ info: { workflowExecution: { workflowId: `knowledge-query:${activityContext.getStore()}`, runId: "run" }, activityId: "dispatch" } }) as never));
  spies.push(spyOn(database, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(undefined));
  spies.push(spyOn(database, "withRlsContext").mockImplementation(async (_db, _scope, fn) => fn(transaction)));
  spies.push(spyOn(database, "withKnowledgeQueryAccountLock").mockImplementation(async (_db, _account, _workspace, fn) => {
    const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; });
    await previous; locked = true;
    try { return await transactionContext.run(true, () => fn(transaction)); } finally { locked = false; release(); }
  }));
  spies.push(spyOn(database, "readKnowledgeQueryUsageFact").mockImplementation(async (_db, input) => {
    const row = facts.get(`usage:${input.eventType}:query:${input.callId}`);
    return row ? { attributes: row.attributes!, occurredAt: row.occurredAt ?? new Date(0) } : null;
  }));
  spies.push(spyOn(database, "pendingKnowledgeQueryPressure").mockImplementation(async (_db,input) => {
    const pending = [...facts.values()].filter(row => row.sourceResourceId !== input.excludeQueryCallId && row.eventType === "knowledge.query.admitted" && !facts.has(`usage:knowledge.query.closed:query:${row.sourceResourceId}`));
    return { bytes: pending.reduce((sum, row) => sum + Number(row.attributes!.inputBytes), 0),
      micros: pending.reduce((sum, row) => sum + Number(row.attributes!.costBoundMicros), 0), workspaceMicros: 0, memberMicros: 0, indexedChunks: 0, queryMicros: pending.reduce((sum, row) => sum + Number(row.attributes!.costBoundMicros), 0) };
  }));
  spies.push(spyOn(database, "recordUsageEvent").mockImplementation(async (db, input) => {
    if (input.eventType === "embedding.call") { expect(db).toBe(root); expect(transactionContext.getStore() ?? false).toBeFalse(); }
    const existing = facts.get(input.idempotencyKey);
    if (existing && JSON.stringify(existing.attributes) !== JSON.stringify(input.attributes)) throw new Error("immutable source conflict");
    facts.set(input.idempotencyKey, existing ?? input); return {} as never;
  }));
  spies.push(spyOn(database, "findActiveWorkspaceApiKeyById").mockResolvedValue({ accountId, permissions: ["documents:search"], permissionMode: "explicit" } as never));
  spies.push(spyOn(database, "withWorkspaceSubjectRls").mockImplementation(async (_db, _workspace, _subject, callback) => callback(transaction)));
  spies.push(spyOn(database, "getWorkspaceGrant").mockResolvedValue({ accountId, workspaceId, permissions: ["documents:search", "documents:manage"] } as never));
  spies.push(spyOn(database, "getSpendableCreditBalance").mockImplementation(async () => ({ balanceMicros: balance }) as never));
  spies.push(spyOn(database, "checkWorkspaceAllowance").mockResolvedValue(null));
  spies.push(spyOn(database, "sumUsageQuantity").mockResolvedValue(0));
  spies.push(spyOn(database, "listKnowledgeEntries").mockResolvedValue({ entries: [], nextCursor: null }));
  spies.push(spyOn(database, "applyCreditDebitAfterUse").mockImplementation(async (_db, input) => { balance -= input.amountMicros; return {} as never; }));
});
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
function input(operationId: string, query = "abc") {
  const value: KnowledgeQueryWorkflowRequest = { context, grant, externalContinuation: null, operationId,
    request: KnowledgeEntryListRequest.parse({ query, mode: "vector" }) };
  return { ...value, callId: knowledgeQueryOperationId(context, operationId) };
}
function worker(embedding: DocumentServices["embedder"]) {
  const activities = createKnowledgeIndexingActivities(async () => ({ db: root, settings }) as ControlActivityServices,
    async () => ({ embedder: embedding }) as DocumentServices);
  return { ...activities, executeKnowledgeQuery: (value: ReturnType<typeof input>) =>
    activityContext.run(value.callId, () => activities.executeKnowledgeQuery(value)),
    executeKnowledgePreparation: (value: Parameters<typeof activities.executeKnowledgePreparation>[0]) =>
      activityContext.run(value.callId, () => activities.executeKnowledgePreparation(value)),
    settleKnowledgeQueryUnknown: (value: ReturnType<typeof input>) =>
      activityContext.run(value.callId, () => activities.settleKnowledgeQueryUnknown(value)) };
}

test("actual query activity commits admission, releases lock before provider and preserves pre-dispatch identity", async () => {
  const operation = input("positive-credit", "abcd"); balance = 1;
  const activity = worker({ model: "fixture", dimensions: 3, embedMany: async () => [],
    embedQuery: async (_query, completed, dispatch) => {
      expect(locked).toBeFalse(); expect(dispatch!.callId).toBe(operation.callId);
      expect(facts.has(`usage:knowledge.query.admitted:query:${operation.callId}`)).toBeTrue();
      await dispatch!.beforeDispatch?.({ callId: operation.callId, provider: "openai", model: "fixture", inputBytes: 4, inputItems: 1, dispatchedAt: new Date().toISOString() });
      expect(locked).toBeFalse();
      await completed?.({ callId: operation.callId, provider: "openai", model: "fixture", inputBytes: 4, inputItems: 1, completedAt: new Date().toISOString() });
      expect(facts.has(`usage:embedding.call:query:${operation.callId}`)).toBeTrue();
      expect(facts.has(`usage:knowledge.query.closed:query:${operation.callId}`)).toBeFalse();
      return [1, 0, 0];
    } });
  expect((await activity.executeKnowledgeQuery(operation)).searchMode).toBe("vector");
  expect(balance).toBe(-3);
  expect(facts.get(`usage:knowledge.query.closed:query:${operation.callId}`)?.attributes?.settlement).toBe("settled");
});

test("actual preparation owner reuses one physical embedding and one receipt across both views", async () => {
  const preparationContext: database.KnowledgeContext = { accountId, workspaceId, actor: {
    kind: "human", principalKind: "human_session", subjectId: "fixture-human", review: true, writeScopes: ["workspace"], settingsScopes: [],
  } };
  const operationId = "prepare-one-provider";
  const callId = knowledgeQueryOperationId(preparationContext, operationId, "preparation");
  let calls = 0;
  const activity = worker({ model: "fixture", dimensions: 3, embedMany: async () => [], embedQuery: async (_query, completed, dispatch) => {
    expect(transactionContext.getStore() ?? false).toBeFalse(); calls += 1;
    await dispatch?.beforeDispatch?.({ callId, provider: "openai", model: "fixture", inputBytes: 3, inputItems: 1, dispatchedAt: new Date().toISOString() });
    await completed?.({ callId, provider: "openai", model: "fixture", inputBytes: 3, inputItems: 1, completedAt: new Date().toISOString() });
    return [1, 0, 0];
  } });
  // Unpaid preparation retains semantic discovery in both views. The paid
  // preparation contract remains keyword-only until one-result settlement.
  settings.documentEmbeddingBillingMode = "shadow";
  try {
    const found = await activity.executeKnowledgePreparation({ context: preparationContext, request: KnowledgeSavePreparationRequest.parse({ query: "abc" }),
      operationId, callId, externalContinuation: null, grant: { ...grant, subjectId: "fixture-human", principalKind: "human_session" } });
    expect(found.matches.published.searchMode).toBe("hybrid"); expect(found.matches.needs_review.searchMode).toBe("hybrid");
    expect(calls).toBe(1); expect([...facts.values()].filter(row => row.eventType === "embedding.call")).toHaveLength(1);
  } finally { settings.documentEmbeddingBillingMode = "credits"; }
});

test("completed provider fact survives failed retrieval and owner closure fences any later debit", async () => {
  const operation = input("retrieval-rollback");
  const read = spyOn(database, "listKnowledgeEntries").mockRejectedValueOnce(new Error("retrieval unavailable")); spies.push(read);
  const activity = worker({ model: "fixture", dimensions: 3, embedMany: async () => [], embedQuery: async () => [1, 0, 0] });
  await expect(activity.executeKnowledgeQuery(operation)).rejects.toThrow("retrieval unavailable");
  expect(facts.get(`usage:embedding.call:query:${operation.callId}`)?.attributes?.outcome).toBe("completed");
  expect(balance).toBe(10);
  await activity.settleKnowledgeQueryUnknown(operation);
  expect(facts.get(`usage:knowledge.query.closed:query:${operation.callId}`)?.attributes?.settlement).toBe("provider_completed_unsettled");
  await expect(activity.executeKnowledgeQuery(operation)).rejects.toThrow("KNOWLEDGE_QUERY_EXECUTION_CLOSED");
  expect(balance).toBe(10);
});

test("two admitted paid queries overlap outside short locks and both return vectors", async () => {
  let active = 0, peak = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const activity = worker({ model: "fixture", dimensions: 3, embedMany: async () => [], embedQuery: async (_text, _completed, _dispatch) => {
    expect(transactionContext.getStore() ?? false).toBeFalse(); active += 1; peak = Math.max(peak, active); if (active === 2) release();
    await gate; active -= 1; return [1, 0, 0];
  } });
  const result = await Promise.all([activity.executeKnowledgeQuery(input("first")), activity.executeKnowledgeQuery(input("second"))]);
  expect(result.every(row => row.searchMode === "vector")).toBeTrue(); expect(peak).toBe(2); expect(balance).toBe(4);
});

test("lost provider response has authoritative null accounting and retains pressure without retry", async () => {
  let calls = 0; balance = 3;
  const operation = input("lost-response");
  const activity = worker({ model: "fixture", dimensions: 3, embedMany: async () => [], embedQuery: async () => { calls += 1; throw new Error("transport unavailable"); } });
  await expect(activity.executeKnowledgeQuery(operation)).rejects.toThrow("transport unavailable");
  await activity.settleKnowledgeQueryUnknown(operation);
  expect(facts.has(`usage:embedding.call:query:${operation.callId}`)).toBeFalse();
  const attributes = EmbeddingCallUsageSource.parse(facts.get(`usage:knowledge.query.indeterminate:query:${operation.callId}`)!.attributes!.providerReceipt);
  expect(attributes).toMatchObject({ outcome: "indeterminate", inputTokens: null, estimatedProviderCostMicros: null, pricingSource: null, rateMicrosPerMillionBytes: null });
  expect(facts.has(`usage:knowledge.query.closed:query:${operation.callId}`)).toBeFalse();
  await expect(activity.executeKnowledgeQuery(input("next"))).rejects.toMatchObject({ code: "knowledge_vector_funding_required" });
  expect(calls).toBe(1); expect(balance).toBe(3);
  retainProducedQueryFacts("query_lost_response");
});

test("unknown owner observation preserves pending pressure and cannot clobber a late known completion", async () => {
  const operation = input("late-known-completion");
  let entered!: () => void, release!: () => void;
  const providerEntered = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const activity = worker({ model: "fixture", dimensions: 3, embedMany: async () => [], embedQuery: async (_query, completed) => {
    entered(); await held;
    await completed?.({ callId: operation.callId, provider: "openai", model: "fixture", inputBytes: 3, inputItems: 1, completedAt: new Date().toISOString() });
    return [1, 0, 0];
  } });
  const result = activity.executeKnowledgeQuery(operation);
  try {
    await providerEntered; await activity.settleKnowledgeQueryUnknown(operation);
    expect(facts.get(`usage:knowledge.query.indeterminate:query:${operation.callId}`)?.attributes?.estimatedProviderCostMicros).toBeNull();
    expect(facts.has(`usage:embedding.call:query:${operation.callId}`)).toBeFalse();
    expect(facts.has(`usage:knowledge.query.closed:query:${operation.callId}`)).toBeFalse();
  } finally { release(); }
  expect((await result).searchMode).toBe("vector");
  expect(facts.get(`usage:embedding.call:query:${operation.callId}`)?.attributes?.outcome).toBe("completed");
  expect(balance).toBe(7);
  retainProducedQueryFacts("query_late_known_completion");
});

test("owner failure before admission fences late dispatch; reused identity refuses changed query", async () => {
  const operation = input("closed-before-admission");
  const activity = worker({ model: "fixture", dimensions: 3, embedMany: async () => [], embedQuery: async () => { throw new Error("provider must not run"); } });
  await activity.settleKnowledgeQueryUnknown(operation);
  await expect(activity.executeKnowledgeQuery(operation)).rejects.toThrow("KNOWLEDGE_QUERY_EXECUTION_CLOSED");
  const other = input("input-conflict");
  facts.set(`usage:knowledge.query.admitted:query:${other.callId}`, { accountId, workspaceId,
    eventType: "knowledge.query.admitted", quantity: 1, unit: "call", idempotencyKey: `usage:knowledge.query.admitted:query:${other.callId}`,
    attributes: { requestDigest: "different", actorDigest: "different" } });
  await expect(activity.executeKnowledgeQuery(other)).rejects.toThrow("KNOWLEDGE_QUERY_OPERATION_INPUT_CONFLICT");
});

test("v1 reader remains completed-only while latest producer refuses priced unknown outcome", () => {
  const latest = EmbeddingCallUsageAttributes.parse({ schema: "opengeni.embedding-call-usage/v2", callKind: "query", provider: null, model: null,
    outcome: "indeterminate", inputBytes: 3, inputItems: 1, inputTokens: null, estimatedProviderCostMicros: null,
    pricingSource: null, rateMicrosPerMillionBytes: null, billingPath: "external" });
  expect(EmbeddingCallUsageAttributesV1.safeParse({ ...latest, schema: "opengeni.embedding-call-usage/v1" }).success).toBeFalse();
  expect(EmbeddingCallUsageAttributes.safeParse({ ...latest, estimatedProviderCostMicros: 0, pricingSource: "configured_byte_rate", rateMicrosPerMillionBytes: 1 }).success).toBeFalse();
});


test("actual worker entry rechecks its current deployment issuer at settlement without inventing DB service membership", async () => {
  const issuer = "query-owner-existing-delegation-issuer";
  let currentSettings = testSettings({ ...settings, productAccessMode: "configured", authRequired: true, accessKey: "perimeter-key", delegationSecret: issuer });
  const bearer = await signDelegatedAccessToken(issuer, { accountId, workspaceId, subjectId: "service:verified-issuer", principalKind: "service", permissions: ["documents:search"], exp: Math.floor(Date.now() / 1000) + 60 });
  const request = new Request("http://localhost/v1/protected", { headers: { authorization: `Bearer ${bearer}` } });
  const canonicalRequest = { req: { raw: request, header: (name: string) => request.headers.get(name) ?? undefined } } as Parameters<typeof requireAccessGrantAuthorization>[0];
  const authorization = await requireAccessGrantAuthorization(canonicalRequest, { db: root, settings: currentSettings }, workspaceId, "documents:search");
  const captured = { grant: authorization.grant, nativeContinuation: nativeAccessContinuationForAuthorization(authorization) };
  const serviceContext: database.KnowledgeContext = { accountId, workspaceId, actor: { kind: "service", principalKind: "mcp_gateway", subjectId: captured.grant.subjectId, writeScopes: [], settingsScopes: [], review: false } };
  const operation: KnowledgeQueryWorkflowRequest & { callId: string } = { ...captured, context: serviceContext, externalContinuation: null, operationId: "issuer-rotation", request: KnowledgeEntryListRequest.parse({ query: "abc", mode: "vector" }), callId: knowledgeQueryOperationId(serviceContext, "issuer-rotation") };
  const activity = createKnowledgeIndexingActivities(async () => ({ db: root, settings: currentSettings, catalogSourceSettings: currentSettings }) as ControlActivityServices,
    async () => ({ embedder: { model: "fixture", dimensions: 3, embedMany: async () => [], embedQuery: async (_text, completed, dispatch) => {
      await dispatch!.beforeDispatch?.({ callId: operation.callId, provider: "openai", model: "fixture", inputBytes: 3, inputItems: 1, dispatchedAt: new Date().toISOString() });
      await completed?.({ callId: operation.callId, provider: "openai", model: "fixture", inputBytes: 3, inputItems: 1, completedAt: new Date().toISOString() });
      currentSettings = { ...currentSettings, delegationSecret: "rotated-current-worker-issuer" };
      return [1, 0, 0];
    } } }) as DocumentServices);
  await expect(activityContext.run(operation.callId, () => activity.executeKnowledgeQuery(operation))).rejects.toThrow("UNAVAILABLE");
  expect(balance).toBe(10); expect(facts.has(`usage:embedding.call:query:${operation.callId}`)).toBeTrue();
  expect(facts.has(`usage:knowledge.query.closed:query:${operation.callId}`)).toBeFalse();
  expect(database.findActiveWorkspaceApiKeyById).not.toHaveBeenCalled();
  expect(database.getWorkspaceGrant).not.toHaveBeenCalled();
});
