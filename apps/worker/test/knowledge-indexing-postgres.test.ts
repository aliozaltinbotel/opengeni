import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Settings } from "@opengeni/config";
import { EMBEDDING_CALL_USAGE_ATTRIBUTES_SCHEMA } from "@opengeni/contracts";
import { knowledgeQueryOperationId, searchKnowledgeEntries, type KnowledgeQueryWorkflowRequest, type KnowledgePreparationWorkflowRequest } from "@opengeni/core";
import {
  createDb,
  bootstrapWorkspace,
  pendingKnowledgeQueryPressure,
  setWorkspaceAllowance,
  setMemberAllowance,
  getBillingBalance,
  saveKnowledgeEntry,
  getKnowledgeEntry,
  recordUsageEvent,
  type KnowledgeContext,
} from "@opengeni/db";
import { knowledgeIndexChunks, type DocumentServices } from "@opengeni/documents";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createKnowledgeIndexingActivities } from "../src/activities/knowledge-indexing";
import type { ControlActivityServices } from "../src/activities/types";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const fixtureAccounts: string[] = [];
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-index-worker");
  if (!acquired) throw new Error("Knowledge indexing verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 6 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);
afterEach(async () => {
  // A later worker may re-claim a ready job when its embedding model changes.
  // Keep the disposable accounts isolated even if a test assertion fails.
  for (const accountId of fixtureAccounts.splice(0)) {
    await shared.admin`DELETE FROM managed_accounts WHERE id=${accountId}`;
  }
});

test("worker resumes batches, meters committed chunks once, and serves scoped semantic excerpts", async () => {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Index account')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Index workspace')`;
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:knowledge-owner",
      writeScopes: ["personal", "workspace"],
      settingsScopes: ["personal"],
      review: true,
    },
  };
  const content = "A private supply agreement.  🚀\u0000 Original wording is retained.\n".repeat(
    850,
  );
  let saved = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "personal",
    entry: {
      kind: "source",
      title: "Acme contract",
      content,
      source: { kind: "manual", externalId: "acme-contract", retention: "full_text" },
    },
  });
  const chunks = [...knowledgeIndexChunks({ title: "Acme contract", content })];
  expect(chunks.length).toBeGreaterThan(32);
  let failProvider = true;
  let embedded = 0;
  const providerSecret = "private provider response body";
  const embedder: DocumentServices["embedder"] = {
    model: "knowledge-index-test",
    dimensions: 3,
    embedQuery: async () => [1, 0, 0],
    embedMany: async (texts) => {
      if (failProvider)
        throw Object.assign(new Error(`provider unavailable: ${providerSecret}`), { status: 503 });
      embedded += texts.length;
      return texts.map(() => [1, 0, 0]);
    },
  };
  const warnings: Array<{ message: string; fields: unknown }> = [];
  const makeWorker = () =>
    createKnowledgeIndexingActivities(
      async () =>
        ({
          db: client.db,
          settings: { billingMode: "none", usageLimitsMode: "none" } as Settings,
          observability: {
            warn: (message: string, fields: unknown) => warnings.push({ message, fields }),
          },
        }) as unknown as ControlActivityServices,
      async () => ({ embedder }) as DocumentServices,
    );
  expect((await makeWorker().indexKnowledge()).deferred).toBe(1);
  const [failed] =
    await shared.admin`SELECT next_index, state, last_failure FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(failed).toMatchObject({
    next_index: 0,
    state: "pending",
    last_failure: "embedding_unavailable",
  });
  // The deferral names the actual cause without provider content.
  expect(warnings).toEqual([
    {
      message: "Knowledge indexing batch deferred",
      fields: {
        errorClass: "KnowledgeIndexOperationError",
        errorCode: "knowledge_index_embedding_failed",
        origin: "worker",
        status: 503,
      },
    },
  ]);
  expect(JSON.stringify(warnings)).not.toContain(providerSecret);
  expect(
    (await searchKnowledgeEntries(client.db, context, { query: "supply" }, () => embedder)).entries,
  ).toHaveLength(1);
  expect(
    (
      await searchKnowledgeEntries(
        client.db,
        context,
        { query: "purchasing", mode: "vector" },
        () => embedder,
      )
    ).entries,
  ).toHaveLength(0);
  const lostRevision=saved.revisionId;
  failProvider = false;
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second' WHERE revision_id=${lostRevision}`;
  expect((await makeWorker().indexKnowledge()).deferred).toBe(1);
  // An unknown physical dispatch is not retried after a worker restart.
  expect(embedded).toBe(0);
  const unknown=await shared.admin`SELECT attributes FROM usage_events WHERE source_resource_id=${lostRevision} AND event_type='knowledge.index.indeterminate'`;
  expect(unknown).toHaveLength(1);expect(unknown[0]!.attributes.providerReceipt.estimatedProviderCostMicros).toBeNull();
  // An actual new source revision is distinct work, not a retry or an expiry release.
  saved=await saveKnowledgeEntry(client.db,context,{operationId:crypto.randomUUID(),entryId:saved.entryId,expectedVersion:saved.version,
    scope:'personal',entry:{kind:'source',title:'Acme contract revised',content,source:{kind:'manual',externalId:'acme-contract',retention:'full_text'}}});
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second' WHERE revision_id=${saved.revisionId}`;
  expect((await makeWorker().indexKnowledge()).advanced).toBe(1);
  const [partial] =
    await shared.admin`SELECT next_index, completed_generation FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(partial).toMatchObject({ next_index: 32, completed_generation: null });
  // A new activity factory represents a worker restart; the database owns progress.
  expect((await makeWorker().indexKnowledge()).completed).toBe(1);
  expect(embedded).toBe(chunks.length);
  expect((await makeWorker().indexKnowledge()).completed).toBe(0);
  const [usage] =
    await shared.admin`SELECT sum(quantity)::int AS chunks FROM usage_events WHERE source_resource_id=${saved.revisionId} AND event_type='document.indexed'`;
  expect(usage?.chunks).toBe(chunks.length);
  // MAINT-P09-430: one durable embedding.call per committed provider batch (32, then the rest),
  // unpriced here (no byte rate is configured), so its cost is unknown, never 0.
  const calls = await shared.admin<Array<{ attributes: Record<string, unknown> }>>`
    SELECT attributes FROM usage_events WHERE source_resource_id=${saved.revisionId} AND event_type='embedding.call' ORDER BY idempotency_key`;
  expect(
    calls.map((call) => call.attributes.inputItems).sort((a, b) => Number(b) - Number(a)),
  ).toEqual([32, chunks.length - 32]);
  for (const call of calls) {
    expect(call.attributes).toMatchObject({
      schema: EMBEDDING_CALL_USAGE_ATTRIBUTES_SCHEMA,
      callKind: "index",
      model: "knowledge-index-test",
      estimatedProviderCostMicros: null,
      pricingSource: null,
    });
  }
  const found = await searchKnowledgeEntries(
    client.db,
    context,
    { query: "purchasing", mode: "vector" },
    () => embedder,
  );
  expect(found.searchMode).toBe("vector");
  expect(found.entries.map((entry) => entry.id)).toEqual([saved.entryId]);
  const excerpt = found.entries[0]!.excerpts[0]!;
  expect(excerpt.text).toBe(content.slice(excerpt.start, excerpt.end));
  expect(excerpt.text).toContain("\u0000");
  const other: KnowledgeContext = {
    ...context,
    actor: { ...context.actor, subjectId: "user:other" } as KnowledgeContext["actor"],
  };
  expect(
    (await searchKnowledgeEntries(client.db, other, { query: "purchasing" }, () => embedder))
      .entries,
  ).toHaveLength(0);
  expect((await getKnowledgeEntry(client.db, context, saved.entryId))?.revision.entry.content).toBe(
    content,
  );
  const unavailable = {
    ...embedder,
    embedQuery: async () => {
      throw new Error("unavailable");
    },
  };
  const fallback = await searchKnowledgeEntries(
    client.db,
    context,
    { query: "supply" },
    () => unavailable,
  );
  expect(fallback.searchMode).toBe("keyword");
  expect(fallback.entries).toHaveLength(1);
  await expect(
    searchKnowledgeEntries(
      client.db,
      context,
      { query: "purchasing", mode: "vector" },
      () => unavailable,
    ),
  ).rejects.toThrow("unavailable");
});

test("paid indexing waits for funding, settles accepted batches and finishes a funded generation in debt", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Funded index account')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Funded index workspace')`;
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:funded-index-owner",
      writeScopes: ["workspace"],
      settingsScopes: ["workspace"],
      review: true,
    },
  };
  let calls = 0;
  const embedder: DocumentServices["embedder"] = {
    model: "paid-knowledge-index",
    dimensions: 3,
    embedMany: async (inputs) => {
      calls++;
      return inputs.map(() => [1, 0, 0]);
    },
    embedQuery: async () => {
      calls++;
      return [1, 0, 0];
    },
  };
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  const makeWorker = () =>
    createKnowledgeIndexingActivities(
      async () =>
        ({
          db: client.db,
          settings,
          observability: { warn: () => undefined },
        }) as ControlActivityServices,
      async () => ({ embedder }) as DocumentServices,
    );
  const worker = makeWorker();
  // Prime the worker's database-clock paid cutoff before this source is queued.
  expect((await worker.indexKnowledge()).completed).toBe(0);
  const saved = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "workspace",
    entry: { kind: "fact", title: "Funded contract", content: "Funded terms ".repeat(4500) },
  });
  // Source retention and keyword retrieval remain available at zero.
  expect(
    (
      await searchKnowledgeEntries(
        client.db,
        context,
        { query: "Funded", mode: "keyword" },
        () => embedder,
        settings,
      )
    ).entries,
  ).toHaveLength(1);
  expect((await worker.indexKnowledge()).deferred).toBe(1);
  expect(calls).toBe(0);
  const [waiting] =
    await shared.admin`SELECT next_index,last_failure FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(waiting).toMatchObject({ next_index: 0, last_failure: "waiting_for_funding" });
  const keyword = await searchKnowledgeEntries(
    client.db,
    context,
    { query: "Funded" },
    () => embedder,
    settings,
  );
  expect(keyword.searchMode).toBe("keyword");
  await expect(
    searchKnowledgeEntries(
      client.db,
      context,
      { query: "Funded", mode: "vector" },
      () => embedder,
      settings,
    ),
  ).rejects.toThrow("Knowledge vector search needs Opengeni credits");
  expect(calls).toBe(0);
  await shared.admin`INSERT INTO credit_ledger_entries(account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key) VALUES (${accountId},NULL,'grant',1,'test',${saved.revisionId},${`funded-index:${saved.revisionId}`})`;
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second' WHERE revision_id=${saved.revisionId}`;
  expect((await worker.indexKnowledge()).advanced).toBe(1);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBeLessThan(0);
  const [frozen] = await shared.admin`
    SELECT billing_mode,billing_rate_micros_per_million_bytes AS rate
    FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(frozen?.billing_mode).toBe("credits");
  expect(Number(frozen?.rate)).toBe(1_000_000);
  // Retrying the next batch after a tariff change must use the generation's
  // originally disclosed price, not the new process configuration.
  settings.documentEmbeddingRateMicrosPerMillionBytes = 2_000_000;
  // A restarted worker must honor the first batch's frozen paid policy even
  // though the source predates this process and the balance is now negative.
  expect((await makeWorker().indexKnowledge()).completed).toBe(1);
  const after = await getBillingBalance(client.db, accountId);
  expect((await worker.indexKnowledge()).completed).toBe(0);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(after.balanceMicros);
  const [ledgers] =
    await shared.admin`SELECT count(*)::int AS n FROM credit_ledger_entries WHERE source_type='knowledge_revision' AND source_id=${saved.revisionId}`;
  expect(ledgers?.n).toBe(2);
  const [settled] = await shared.admin<Array<{ bytes: number; charged: number }>>`
    SELECT (SELECT coalesce(sum(quantity),0)::bigint FROM usage_events
       WHERE event_type='document.embedding_bytes' AND source_resource_id=${saved.revisionId}) AS bytes,
      (SELECT coalesce(-sum(amount_micros),0)::bigint FROM credit_ledger_entries
       WHERE source_type='knowledge_revision' AND source_id=${saved.revisionId}) AS charged`;
  expect(Number(settled?.charged)).toBe(Number(settled?.bytes));
  expect(calls).toBe(2);
  expect(
    (
      await searchKnowledgeEntries(
        client.db,
        context,
        { query: "Funded" },
        () => embedder,
        settings,
      )
    ).searchMode,
  ).toBe("keyword");
  expect(calls).toBe(2);
});

test("a frozen paid generation pauses across a billing-mode rollback and resumes at its original tariff", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Rollback index account')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Rollback index workspace')`;
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:rollback-index-owner",
      writeScopes: ["workspace"],
      settingsScopes: ["workspace"],
      review: true,
    },
  };
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  let calls = 0;
  const embedder: DocumentServices["embedder"] = {
    model: "paid-rollback-index-test",
    dimensions: 3,
    embedMany: async (inputs) => {
      calls++;
      return inputs.map(() => [1, 0, 0]);
    },
    embedQuery: async () => [1, 0, 0],
  };
  const makeWorker = () =>
    createKnowledgeIndexingActivities(
      async () =>
        ({
          db: client.db,
          settings,
          observability: { warn: () => undefined },
        }) as ControlActivityServices,
      async () => ({ embedder }) as DocumentServices,
    );
  const worker = makeWorker();
  const content = "A paid revision that spans multiple indexing batches. ".repeat(800);
  const saved = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "workspace",
    entry: { kind: "fact", title: "Rollback contract", content },
  });
  const chunks = [...knowledgeIndexChunks({ title: "Rollback contract", content })];
  expect(chunks.length).toBeGreaterThan(32);
  expect(chunks.length).toBeLessThanOrEqual(64);
  await shared.admin`INSERT INTO credit_ledger_entries(account_id,type,amount_micros,idempotency_key)
    VALUES(${accountId},'grant',1000000,${`rollback-index:${saved.revisionId}`})`;
  expect((await worker.indexKnowledge()).advanced).toBe(1);
  expect(calls).toBe(1);
  const [firstBatch] = await shared.admin<
    Array<{
      next_index: number;
      billing_mode: string;
      rate: number;
      vectors: number;
      debits: number;
    }>
  >`
    SELECT j.next_index,j.billing_mode,j.billing_rate_micros_per_million_bytes AS rate,
      (SELECT count(*)::int FROM knowledge_entry_vectors WHERE revision_id=${saved.revisionId}) AS vectors,
      (SELECT count(*)::int FROM credit_ledger_entries WHERE source_id=${saved.revisionId}
        AND type='document_embedding_debit') AS debits
    FROM knowledge_index_jobs j WHERE j.revision_id=${saved.revisionId}`;
  expect(firstBatch?.next_index).toBe(32);
  expect(firstBatch?.billing_mode).toBe("credits");
  expect(Number(firstBatch?.rate)).toBe(1_000_000);
  expect(firstBatch?.vectors).toBe(32);
  expect(firstBatch?.debits).toBe(1);
  const [attribution] = await shared.admin`
    SELECT j.billing_attribution,
      (SELECT metadata FROM credit_ledger_entries WHERE source_id=${saved.revisionId}
        AND type='document_embedding_debit' LIMIT 1) AS debit_metadata
    FROM knowledge_index_jobs j WHERE j.revision_id=${saved.revisionId}`;
  expect(attribution?.billing_attribution).toEqual({
    kind: "human",
    initiatingHumanSubjectId: "user:rollback-index-owner",
  });
  expect(attribution?.debit_metadata).toMatchObject({
    initiatingHumanSubjectId: "user:rollback-index-owner",
  });
  const [memberUsage] = await shared.admin`
    SELECT coalesce(sum(used),0)::bigint AS used FROM opengeni_private.workspace_allowance_counters
    WHERE workspace_id=${workspaceId} AND subject_id='user:rollback-index-owner'`;
  expect(Number(memberUsage?.used)).toBe(
    1_000_000 - (await getBillingBalance(client.db, accountId)).balanceMicros,
  );
  await expect(
    shared.admin`UPDATE knowledge_index_jobs SET
      billing_attribution='{"kind":"service"}'::jsonb
      WHERE revision_id=${saved.revisionId}`.then((rows) => rows),
  ).rejects.toMatchObject({ code: "23514" });
  const balanceAfterFirstBatch = (await getBillingBalance(client.db, accountId)).balanceMicros;

  settings.documentEmbeddingBillingMode = "usage_only";
  settings.documentEmbeddingRateMicrosPerMillionBytes = 2_000_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await makeWorker().indexKnowledge()).deferred).toBe(1);
    const [paused] = await shared.admin<
      Array<{ state: string; next_index: number; vectors: number; debits: number; indexed: number }>
    >`
      SELECT j.state,j.next_index,
        (SELECT count(*)::int FROM knowledge_entry_vectors WHERE revision_id=${saved.revisionId}) AS vectors,
        (SELECT count(*)::int FROM credit_ledger_entries WHERE source_id=${saved.revisionId}
          AND type='document_embedding_debit') AS debits,
        (SELECT coalesce(sum(quantity),0)::int FROM usage_events WHERE source_resource_id=${saved.revisionId}
          AND event_type='document.indexed') AS indexed
      FROM knowledge_index_jobs j WHERE j.revision_id=${saved.revisionId}`;
    expect(paused).toMatchObject({
      state: "pending",
      next_index: 32,
      vectors: 32,
      debits: 1,
      indexed: 32,
    });
    expect(calls).toBe(1);
    expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(
      balanceAfterFirstBatch,
    );
    await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second'
      WHERE revision_id=${saved.revisionId}`;
  }
  expect(
    (
      await searchKnowledgeEntries(
        client.db,
        context,
        { query: "Rollback", mode: "keyword" },
        () => embedder,
        settings,
      )
    ).entries,
  ).toHaveLength(1);

  settings.documentEmbeddingBillingMode = "credits";
  expect((await makeWorker().indexKnowledge()).completed).toBe(1);
  expect(calls).toBe(2);
  const [settled] = await shared.admin<
    Array<{
      state: string;
      next_index: number;
      rate: number;
      bytes: number;
      charged: number;
      debits: number;
    }>
  >`
    SELECT j.state,j.next_index,j.billing_rate_micros_per_million_bytes AS rate,
      (SELECT coalesce(sum(quantity),0)::bigint FROM usage_events
        WHERE event_type='document.embedding_bytes' AND source_resource_id=${saved.revisionId}) AS bytes,
      (SELECT coalesce(-sum(amount_micros),0)::bigint FROM credit_ledger_entries
        WHERE source_id=${saved.revisionId} AND type='document_embedding_debit') AS charged,
      (SELECT count(*)::int FROM credit_ledger_entries
        WHERE source_id=${saved.revisionId} AND type='document_embedding_debit') AS debits
    FROM knowledge_index_jobs j WHERE j.revision_id=${saved.revisionId}`;
  expect(settled?.state).toBe("ready");
  expect(settled?.next_index).toBe(chunks.length);
  expect(Number(settled?.rate)).toBe(1_000_000);
  expect(settled?.debits).toBe(2);
  const secondAttribution = await shared.admin`
    SELECT metadata->>'initiatingHumanSubjectId' AS human FROM credit_ledger_entries
    WHERE source_id=${saved.revisionId} AND type='document_embedding_debit'`;
  expect(secondAttribution.map((row) => row.human)).toEqual([
    "user:rollback-index-owner",
    "user:rollback-index-owner",
  ]);
  expect(Number(settled?.charged)).toBe(Number(settled?.bytes));
  expect((await worker.indexKnowledge()).completed).toBe(0);
  expect(calls).toBe(2);
});

test("paid indexing waits for publication without charging a review-first draft", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Review-gated index')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Review workspace')`;
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  let calls = 0;
  let onEmbed: (() => Promise<void>) | undefined;
  const embedder: DocumentServices["embedder"] = {
    model: "review-gated-index-test",
    dimensions: 3,
    embedMany: async (inputs) => {
      calls++;
      await onEmbed?.();
      return inputs.map(() => [1, 0, 0]);
    },
    embedQuery: async () => [1, 0, 0],
  };
  const worker = createKnowledgeIndexingActivities(
    async () =>
      ({
        db: client.db,
        settings,
        observability: { warn: () => undefined },
      }) as ControlActivityServices,
    async () => ({ embedder }) as DocumentServices,
  );
  const saved = await saveKnowledgeEntry(
    client.db,
    {
      accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: "user:review-owner",
        writeScopes: ["workspace"],
        settingsScopes: ["workspace"],
        review: true,
      },
    },
    {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      scope: "workspace",
      entry: { kind: "fact", title: "Review-first draft", content: "Pending review" },
    },
  );
  // Model a review-first revision's exact publication pointer without changing
  // its immutable body or bypassing the worker's leased indexing capability.
  await shared.admin`UPDATE knowledge_entries SET published_revision_id=NULL WHERE id=${saved.entryId}`;
  await shared.admin`INSERT INTO credit_ledger_entries(account_id,type,amount_micros,idempotency_key)
    VALUES(${accountId},'grant',1,${`review-index:${saved.revisionId}`})`;
  expect((await worker.indexKnowledge()).deferred).toBe(1);
  expect(calls).toBe(0);
  const [waiting] = await shared.admin`
    SELECT state,last_failure FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(waiting).toMatchObject({ state: "pending", last_failure: "waiting_for_review" });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(1);
  await shared.admin`UPDATE knowledge_entries SET published_revision_id=${saved.revisionId} WHERE id=${saved.entryId}`;
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second'
    WHERE revision_id=${saved.revisionId}`;
  // Simulate a concurrent reviewer withdrawing publication after the provider
  // started but before the batch can append and charge. No paid projection may
  // commit using a stale pre-provider publication check.
  onEmbed = async () => {
    await shared.admin`UPDATE knowledge_entries SET published_revision_id=NULL WHERE id=${saved.entryId}`;
    onEmbed = undefined;
  };
  expect((await worker.indexKnowledge()).deferred).toBe(1);
  expect(calls).toBe(1);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(1);
  const [withdrawn] = await shared.admin`
    SELECT state,next_index,last_failure FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(withdrawn).toMatchObject({
    state: "pending",
    next_index: 0,
    last_failure: "waiting_for_review",
  });
  await shared.admin`UPDATE knowledge_entries SET published_revision_id=${saved.revisionId} WHERE id=${saved.entryId}`;
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second'
    WHERE revision_id=${saved.revisionId}`;
  expect((await worker.indexKnowledge()).completed).toBe(1);
  expect(calls).toBe(2);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBeLessThan(1);
});

test("deterministic embeddings still index without funds under the credits-mode switch", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Deterministic index')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Deterministic workspace')`;
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "deterministic",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingRateMicrosPerMillionBytes: 0,
  } as Settings;
  const embedder: DocumentServices["embedder"] = {
    model: "deterministic-index-test",
    dimensions: 3,
    embedMany: async (inputs) => inputs.map(() => [1, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  };
  const worker = createKnowledgeIndexingActivities(
    async () =>
      ({
        db: client.db,
        settings,
        observability: { warn: () => undefined },
      }) as ControlActivityServices,
    async () => ({ embedder }) as DocumentServices,
  );
  await worker.indexKnowledge();
  const saved = await saveKnowledgeEntry(
    client.db,
    {
      accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: "user:deterministic-owner",
        writeScopes: ["workspace"],
        settingsScopes: ["workspace"],
        review: true,
      },
    },
    {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      scope: "workspace",
      entry: { kind: "fact", title: "No provider charge", content: "Local embeddings" },
    },
  );
  expect((await worker.indexKnowledge()).completed).toBe(1);
  const [job] = await shared.admin`
    SELECT billing_mode, state FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(job).toMatchObject({ billing_mode: "usage_only", state: "ready" });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(0);
});

test("shadow indexing records its frozen cost estimate without a credit debit", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Shadow index')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Shadow workspace')`;
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "shadow",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  const embedder: DocumentServices["embedder"] = {
    model: "shadow-index-test",
    dimensions: 3,
    embedMany: async (inputs) => inputs.map(() => [1, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  };
  const worker = createKnowledgeIndexingActivities(
    async () =>
      ({
        db: client.db,
        settings,
        observability: { warn: () => undefined },
      }) as ControlActivityServices,
    async () => ({ embedder }) as DocumentServices,
  );
  await worker.indexKnowledge();
  const saved = await saveKnowledgeEntry(
    client.db,
    {
      accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: "user:shadow-owner",
        writeScopes: ["workspace"],
        settingsScopes: ["workspace"],
        review: true,
      },
    },
    {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      scope: "workspace",
      entry: { kind: "fact", title: "Shadow estimate", content: "Count these bytes only" },
    },
  );
  expect((await worker.indexKnowledge()).completed).toBe(1);
  const [meter] = await shared.admin<
    Array<{ mode: string; estimate: number | string; ledger: number }>
  >`
    SELECT (SELECT billing_mode FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}) AS mode,
      (SELECT sum(quantity)::bigint FROM usage_events WHERE event_type='document.embedding_shadow_estimate'
       AND source_resource_id=${saved.revisionId}) AS estimate,
      (SELECT count(*)::int FROM credit_ledger_entries WHERE account_id=${accountId}) AS ledger`;
  expect(meter?.mode).toBe("shadow");
  expect(Number(meter?.estimate)).toBeGreaterThan(0);
  expect(meter?.ledger).toBe(0);
});

test("a queued Knowledge generation remains unpriced when paid mode starts later", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Legacy queued index')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Legacy index workspace')`;
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:legacy-index-owner",
      writeScopes: ["workspace"],
      settingsScopes: ["workspace"],
      review: true,
    },
  };
  const saved = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "workspace",
    entry: { kind: "fact", title: "Queued earlier", content: "Indexed without retroactive charge" },
  });
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingCreditsActivatedAt: new Date(Date.now() + 60_000).toISOString(),
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  const embedder: DocumentServices["embedder"] = {
    model: "legacy-index-test",
    dimensions: 3,
    embedMany: async (inputs) => inputs.map(() => [1, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  };
  // The worker starts only after the source has been queued. Its current
  // credit setting cannot be projected backward onto that queued source.
  const worker = createKnowledgeIndexingActivities(
    async () =>
      ({
        db: client.db,
        settings,
        observability: { warn: () => undefined },
      }) as ControlActivityServices,
    async () => ({ embedder }) as DocumentServices,
  );
  expect((await worker.indexKnowledge()).completed).toBe(1);
  const [job] =
    await shared.admin`SELECT billing_mode,billed_generation FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(job).toMatchObject({ billing_mode: "usage_only", billed_generation: 1 });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(0);
});

test("completed embedding facts survive rollback and concurrent settlement on a single-connection restricted pool", async () => {
  const single = createDb(shared.appUrl, { max: 1 });
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  try {
    await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Call fact rollback')`;
    await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Call fact workspace')`;
    const context: KnowledgeContext = {
      accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: "user:call-fact-owner",
        writeScopes: ["workspace"],
        settingsScopes: ["workspace"],
        review: true,
      },
    };
    const settings = {
      billingMode: "stripe",
      usageLimitsMode: "managed",
      staticUsageLimitsJson: "{}",
      documentEmbeddingProvider: "openai",
      documentEmbeddingBillingMode: "credits",
      documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z",
      documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
    } as Settings;
    const saved = await saveKnowledgeEntry(single.db, context, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      scope: "workspace",
      entry: { kind: "fact", title: "Call fact", content: "Retained terms" },
    });
    await shared.admin`INSERT INTO credit_ledger_entries(account_id,type,amount_micros,idempotency_key)
      VALUES(${accountId},'grant',10000,${`call-fact:${saved.revisionId}`})`;
    let physicalCalls = 0,
      incomplete = true;
    const embedder: DocumentServices["embedder"] = {
      model: "call-fact-rollback-test",
      dimensions: 3,
      embedQuery: async () => {
        const rows = await single.db.execute<{ transaction_id: string | null }>(sql`SELECT txid_current_if_assigned()::text AS transaction_id`);
        expect(rows[0]?.transaction_id).toBeNull();
        return [1, 0, 0];
      },
      embedMany: async (inputs) => {
        physicalCalls++;
        const rows = await single.db.execute<{ transaction_id: string | null }>(sql`SELECT txid_current_if_assigned()::text AS transaction_id`);
        expect(rows[0]?.transaction_id).toBeNull();
        // The provider returned a complete batch, but the released append
        // validator refuses each vector's dimensions after the provider call.
        return inputs.map(() => (incomplete ? [1, 0] : [1, 0, 0]));
      },
    };
    const worker = createKnowledgeIndexingActivities(
      async () =>
        ({
          db: single.db,
          settings,
          observability: { warn: () => undefined },
        }) as unknown as ControlActivityServices,
      async () => ({ embedder }) as DocumentServices,
    );
    expect((await worker.indexKnowledge()).deferred).toBe(1);
    const [failed] =
      await shared.admin`SELECT state,next_index FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
    expect(failed).toMatchObject({ state: "pending", next_index: 0 });
    expect((await getBillingBalance(single.db, accountId)).balanceMicros).toBe(10000);
    const first = await shared.admin<
      Array<{ id: string; idempotencyKey: string; attributes: Record<string, unknown> }>
    >`
      SELECT id,idempotency_key AS "idempotencyKey",attributes FROM usage_events
      WHERE event_type='embedding.call' AND source_resource_id=${saved.revisionId}`;
    expect(first).toHaveLength(1);
    expect(first[0]!.attributes).toMatchObject({ outcome: "completed", inputTokens: null });
    // Replay the exact authoritative event through the restricted writer.
    const replay = await recordUsageEvent(single.db, {
      accountId,
      workspaceId,
      eventType: "embedding.call",
      quantity: 1,
      unit: "call",
      sourceResourceType: "knowledge_revision",
      sourceResourceId: saved.revisionId,
      idempotencyKey: first[0]!.idempotencyKey,
      attributes: first[0]!.attributes,
    });
    expect(replay.id).toBe(first[0]!.id);
    incomplete = false;
    await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second' WHERE revision_id=${saved.revisionId}`;
    expect((await worker.indexKnowledge()).completed).toBe(1);
    const calls = await shared.admin`SELECT id,attributes FROM usage_events
      WHERE event_type='embedding.call' AND source_resource_id=${saved.revisionId}`;
    expect(calls).toHaveLength(physicalCalls);
    expect(new Set(calls.map((call) => call.id)).size).toBe(physicalCalls);
    // All requests must release the single connection before their root fact
    // writer runs; a writer waiting inside either lock would never complete.
    const queries = await Promise.all(
      ["retained", "terms"].map((query) =>
        searchKnowledgeEntries(
          single.db,
          context,
          { query, mode: "vector" },
          () => embedder,
          settings,
        ),
      ),
    );
    expect(queries.every((query) => query.searchMode === "vector")).toBe(true);
    const [queryFacts] = await shared.admin`SELECT count(*)::int AS calls FROM usage_events
      WHERE account_id=${accountId} AND event_type='embedding.call' AND source_resource_type='knowledge_query'`;
    expect(queryFacts?.calls).toBe(queries.length);
  } finally {
    await single.close();
  }
}, 30_000);

// This proof needs the coordinated native Temporal allocation as well as the
// restricted PostgreSQL fixture. Ordinary PG runs explicitly report it skipped.
for (const scenario of ["settled-and-lost-response", "process-loss-and-authority"] as const) {
test.skipIf(!process.env.OPENGENI_TEST_TEMPORAL_ADDRESS)(`released knowledge workflows replay and restart without repeating an unknown provider call: ${scenario}`, async () => {
  const { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowFailedError } = await import("@temporalio/client");
  const { NativeConnection, Worker } = await import("@temporalio/worker");
  const { createHash } = await import("node:crypto");
  const address = process.env.OPENGENI_TEST_TEMPORAL_ADDRESS!;
  const namespace = process.env.OPENGENI_TEST_TEMPORAL_NAMESPACE ?? "default";
  const code = await Bun.file(new URL("../dist/workflow-bundle.js", import.meta.url)).text();
  const connection = await Connection.connect({ address });
  const native = await NativeConnection.connect({ address });
  const temporal = new Client({ connection, namespace });
  const taskQueue = `knowledge-receipts-${crypto.randomUUID()}`;
  const handles: Array<{ cancel(): Promise<void>; result(): Promise<unknown>; describe(): Promise<{ status: { name: string } }> }> = [];
  const suffix = crypto.randomUUID();
  // Fixed stage names and local array indices only; no business/provider data.
  const stage = (name: string, index?: number) => console.error("KNOWLEDGE_HOSTED_AWAIT_STAGE", name, index ?? "");
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "knowledge-receipts", accountExternalId: suffix, accountName: "Receipt owner",
    workspaceExternalSource: "knowledge-receipts", workspaceExternalId: suffix, workspaceName: "Receipt owner",
    subjectId: `receipt-owner:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  fixtureAccounts.push(grant.accountId);
  const context: KnowledgeContext = { accountId: grant.accountId, workspaceId: grant.workspaceId!, actor: {
    kind: "human", principalKind: "human_session", subjectId: grant.subjectId,
    writeScopes: ["workspace"], settingsScopes: ["workspace"], review: true,
  } };
  const settings = { billingMode: "stripe", usageLimitsMode: "managed", staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai", documentEmbeddingBillingMode: "credits",
    documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000 } as Settings;
  await shared.admin`INSERT INTO credit_ledger_entries(account_id,type,amount_micros,idempotency_key)
    VALUES(${grant.accountId},'grant',${scenario === "settled-and-lost-response" ? 1 : 100},${`temporal-receipts:${suffix}`})`;
  let physicalCalls = 0, loseResponse = false, revokeOnReturn = false;
  const activities = () => createKnowledgeIndexingActivities(
    async () => ({ db: client.db, settings, observability: { warn: () => undefined } }) as ControlActivityServices,
    async () => ({ embedder: { model: "temporal-receipts", dimensions: 3,
      embedMany: async texts => texts.map(() => [1, 0, 0]), embedQuery: async () => {
        physicalCalls++;
        const rows = await client.db.execute<{ transaction_id: string | null }>(sql`SELECT txid_current_if_assigned()::text AS transaction_id`);
        expect(rows[0]?.transaction_id).toBeNull();
        if (loseResponse) throw new Error("synthetic lost provider response");
        if (revokeOnReturn) await shared.admin`UPDATE workspace_memberships SET permissions='[]'::jsonb
          WHERE account_id=${grant.accountId} AND workspace_id=${grant.workspaceId!} AND subject_id=${grant.subjectId}`;
        return [1, 0, 0];
      },
    } }) as DocumentServices,
  );
  let running: Promise<void> | undefined, worker: InstanceType<typeof Worker> | undefined;
  let runningFailure: Promise<never> | undefined;
  // Exact installed SDK 1.22.0 custody: native polling precedes the public
  // activation counter and workflow-thread requests. Record counts only.
  type WorkerCustody = {
    nativeWorker: { pollWorkflowActivation(): Promise<Buffer> };
    workflowCreator: { workerThreadClients: Array<{ workerExited: boolean; activeWorkflowCount: number;
      requestIdToCompletion: Map<unknown, unknown> }> };
  };
  let nativePolls = { started: 0, returned: 0, rejected: 0 };
  let workerGeneration = 0, workerIdentity = "";
  const startWorker = async () => {
    workerIdentity = `maint430-hosted-parent:${process.pid}:${++workerGeneration}`;
    worker = await Worker.create({ connection: native, namespace, taskQueue, workflowBundle: { code },
      identity: workerIdentity, activities: activities(), maxConcurrentActivityTaskExecutions: 2, maxConcurrentWorkflowTaskExecutions: 2 });
    nativePolls = { started: 0, returned: 0, rejected: 0 };
    const custody = worker as unknown as WorkerCustody;
    const poll = custody.nativeWorker.pollWorkflowActivation.bind(custody.nativeWorker);
    const counts = nativePolls;
    custody.nativeWorker.pollWorkflowActivation = async () => {
      counts.started++;
      try { const activation = await poll(); counts.returned++; return activation; }
      catch (error) { counts.rejected++; throw error; }
    };
    running = worker.run();
    console.error("KNOWLEDGE_HOSTED_WORKER_INSTANCE_RUNNING", workerIdentity);
    runningFailure = new Promise<never>((_resolve, reject) => {
      void running!.catch(error => {
        const category = error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 80) : "UnknownError";
        console.error("KNOWLEDGE_HOSTED_WORKER_RUN_FAILED", category);
        reject(new Error(`KNOWLEDGE_HOSTED_WORKER_RUN_FAILED:${category}`));
      });
    });
    void runningFailure.catch(() => undefined);
  };
  const stopWorker = async () => {
    worker?.shutdown(); await running;
    console.error("KNOWLEDGE_HOSTED_WORKER_INSTANCE_STOPPED", workerIdentity);
    worker = undefined; running = undefined;
  };
  let recoveryChild: { process: ReturnType<typeof Bun.spawn>; diagnostics: Promise<Buffer> } | undefined;
  let stoppingRecovery = false;
  let hostedProvider: ReturnType<typeof Bun.serve> | undefined;
  const start = async (input: KnowledgeQueryWorkflowRequest | KnowledgePreparationWorkflowRequest, preparation = false) => {
    const callId = knowledgeQueryOperationId(context, input.operationId, preparation ? "preparation" : "query");
    const bindingDigest = createHash("sha256").update(JSON.stringify({ context, request: input.request })).digest("hex");
    const handle = await temporal.workflow.start(preparation ? "knowledgePreparationWorkflow" : "knowledgeQueryWorkflow", {
      taskQueue, workflowId: `knowledge-query:${callId}`, workflowIdReusePolicy: "REJECT_DUPLICATE",
      args: [{ ...input, callId, bindingDigest, baseTaskQueue: taskQueue }],
    });
    handles.push(handle); return handle;
  };
  const paidInput: KnowledgeQueryWorkflowRequest = { context, grant, externalContinuation: null,
    operationId: `paid:${suffix}`, request: { query: "abcd", mode: "vector", limit: 20 } as KnowledgeQueryWorkflowRequest["request"] };
  try {
    if (scenario === "settled-and-lost-response") {
    await startWorker();
    const paid = await start(paidInput);
    expect((await paid.result() as { searchMode: string }).searchMode).toBe("vector");
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(-3);
    await Worker.runReplayHistory({ workflowBundle: { code } }, await paid.fetchHistory(), paid.workflowId);
    await shared.admin`INSERT INTO credit_ledger_entries(account_id,type,amount_micros,idempotency_key)
      VALUES(${grant.accountId},'grant',100,${`temporal-recovery-funding:${suffix}`})`;
    // Actual preparation is unpaid by its existing contract and shares one
    // provider occurrence across both discovery views.
    settings.documentEmbeddingBillingMode = "shadow";
    const preparationInput: KnowledgePreparationWorkflowRequest = { context, grant, externalContinuation: null,
      operationId: `prepare:${suffix}`, request: { query: "terms" } as KnowledgePreparationWorkflowRequest["request"] };
    const beforePreparation = physicalCalls;
    const prepared = await start(preparationInput, true);
    await prepared.result();
    expect(physicalCalls - beforePreparation).toBe(1);
    await Worker.runReplayHistory({ workflowBundle: { code } }, await prepared.fetchHistory(), prepared.workflowId);
    settings.documentEmbeddingBillingMode = "credits";
    loseResponse = true;
    const lostInput = { ...paidInput, operationId: `lost:${suffix}`, request: { ...paidInput.request, query: "lost" } };
    const lost = await start(lostInput);
    await expect(lost.result()).rejects.toThrow();
    const callId = knowledgeQueryOperationId(context, lostInput.operationId);
    const rows = await shared.admin`SELECT event_type,attributes FROM usage_events
      WHERE account_id=${grant.accountId} AND source_resource_id=${callId}`;
    expect(rows.some(row => row.event_type === "knowledge.query.indeterminate" && row.attributes.providerReceipt.estimatedProviderCostMicros === null)).toBeTrue();
    expect(rows.some(row => row.event_type === "embedding.call" || row.event_type === "knowledge.query.closed")).toBeFalse();
    const beforeRestart = physicalCalls;
    await stopWorker(); await startWorker();
    await expect(start(lostInput)).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
    await expect(temporal.workflow.getHandle(lost.workflowId).result()).rejects.toThrow();
    expect(physicalCalls).toBe(beforeRestart);
    const pressure = await pendingKnowledgeQueryPressure(client.db, { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId: grant.subjectId });
    expect(pressure.bytes).toBe(4); expect(pressure.micros).toBe(4);
    await Worker.runReplayHistory({ workflowBundle: { code } }, await lost.fetchHistory(), lost.workflowId);
    return;
    }
    // This independent account has no dependency on the normal scenario's
    // UNKNOWN rows. The same physical child provider creates its own prefill.
    // Kill only after the held crash request is independently observed.
    let crashProviderEntered!: () => void, releaseCrashProvider!: (response: Response) => void;
    const observedCrashDispatch = new Promise<void>(resolve => { crashProviderEntered = resolve; });
    const heldCrashResponse = new Promise<Response>(resolve => { releaseCrashProvider = resolve; });
    let crashProviderCalls = 0, prefillProviderCalls = 0;
    let crashDispatchObserved = false;
    let providerRevocationCommitted!: () => void;
    const observedProviderRevocation = new Promise<void>(resolve => { providerRevocationCommitted = resolve; });
    let providerPhase: "prefill" | "crash" | "recovery" = "prefill";
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
      if (providerPhase === "prefill") {
        prefillProviderCalls++;
        // A real physical request loses its usable response. The actual child
        // response reader fails; no provider completion/usage is fabricated.
        return new Response("synthetic lost provider response", { headers: { "content-type": "application/json" } });
      }
      if (providerPhase === "crash") {
        crashProviderCalls++; crashDispatchObserved = true; crashProviderEntered(); return heldCrashResponse;
      }
      // Later legitimate calls exercise the same live membership revocation
      // after provider return; recovery itself must never reach this provider.
      physicalCalls++;
      if (revokeOnReturn) {
        await shared.admin`UPDATE workspace_memberships SET permissions='[]'::jsonb
          WHERE account_id=${grant.accountId} AND workspace_id=${grant.workspaceId!} AND subject_id=${grant.subjectId}`;
        // Only the committed live membership change releases the next call.
        providerRevocationCommitted();
      }
      return Response.json({ vector: [1, 0, 0] });
    } });
    hostedProvider = provider;
    const childCode = `
      import { NativeConnection, Worker } from '@temporalio/worker';
      import { createDb } from '@opengeni/db';
      import { sql } from 'drizzle-orm';
      import { createKnowledgeIndexingActivities } from './apps/worker/src/activities/knowledge-indexing';
      const db=createDb(process.env.OPENGENI_RECEIPT_TEST_DB_URL,{max:1});
      const native=await NativeConnection.connect({address:process.env.OPENGENI_TEST_TEMPORAL_ADDRESS});
      const settings=JSON.parse(process.env.OPENGENI_RECEIPT_TEST_SETTINGS);
      const activities=createKnowledgeIndexingActivities(async()=>({db:db.db,settings,observability:{warn:()=>{}}}),
        async()=>({embedder:{model:'process-loss-receipts',dimensions:3,embedMany:async texts=>texts.map(()=>[1,0,0]),
          embedQuery:async()=>{const rows=await db.db.execute(sql\`SELECT txid_current_if_assigned()::text AS transaction_id\`);
            if(rows[0]?.transaction_id!==null)throw new Error('PROVIDER_INSIDE_TRANSACTION');
            const response=await fetch(process.env.OPENGENI_RECEIPT_TEST_PROVIDER_URL);await response.json();return [1,0,0];}}}));
      const worker=await Worker.create({connection:native,namespace:process.env.OPENGENI_TEST_TEMPORAL_NAMESPACE,
        taskQueue:process.env.OPENGENI_RECEIPT_TEST_TASK_QUEUE,workflowBundle:{codePath:'./apps/worker/dist/workflow-bundle.js'},activities,
        identity:'maint430-hosted-child:'+process.pid+':'+process.env.OPENGENI_RECEIPT_TEST_WORKER_ROLE,
        maxConcurrentActivityTaskExecutions:1,maxConcurrentWorkflowTaskExecutions:2});
      process.once('SIGTERM',()=>worker.shutdown());
      console.log('KNOWLEDGE_HOSTED_CHILD_CREATED',process.env.OPENGENI_RECEIPT_TEST_WORKER_ROLE,process.pid);
      try { await worker.run(); }
      finally { await native.close(); await db.close(); }
    `;
    const launchChild = (role: "crash" | "recovery") => {
      const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "-e", childCode], {
        cwd: new URL("../../../", import.meta.url).pathname,
        env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "", OPENGENI_TEST_TEMPORAL_ADDRESS: address,
          OPENGENI_TEST_TEMPORAL_NAMESPACE: namespace, OPENGENI_RECEIPT_TEST_DB_URL: shared.appUrl,
          OPENGENI_RECEIPT_TEST_SETTINGS: JSON.stringify(settings), OPENGENI_RECEIPT_TEST_TASK_QUEUE: taskQueue,
          OPENGENI_RECEIPT_TEST_PROVIDER_URL: provider.url.toString(), OPENGENI_RECEIPT_TEST_WORKER_ROLE: role },
        stdout: "inherit", stderr: "pipe",
      });

      // Drain immediately so startup cannot block on a full pipe. Retain at most
      // 16 KiB privately; raw SDK/DB errors never become assertion/log contents.
      const childDiagnostics = (async () => {
        const reader = child.stderr.getReader();
        const chunks: Uint8Array[] = []; let retained = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            const take = Math.min(value.length, 16 * 1024 - retained);
            if (take > 0) { chunks.push(value.slice(0, take)); retained += take; }
          }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks);
      })();
      return { process: child, diagnostics: childDiagnostics };
    };
    const crashOwner = launchChild("crash");
    const child = crashOwner.process, childDiagnostics = crashOwner.diagnostics;
    recoveryChild = crashOwner;
    const prefillInput = { ...paidInput, operationId: `prefill:${suffix}`, request: { ...paidInput.request, query: "lost" } };
    stage("prefill-start:start");
    const prefill = await start(prefillInput);
    stage("prefill-start:complete");
    stage("prefill-result:start");
    await expect(prefill.result()).rejects.toThrow();
    stage("prefill-result:complete");
    expect((await prefill.describe()).status.name).toBe("FAILED");
    expect(prefillProviderCalls).toBe(1);
    const prefillCallId = knowledgeQueryOperationId(context, prefillInput.operationId);
    const prefillFacts = await shared.admin`SELECT event_type,attributes FROM usage_events
      WHERE account_id=${grant.accountId} AND source_resource_id=${prefillCallId}`;
    expect(prefillFacts.some(row => row.event_type === "knowledge.query.indeterminate" && row.attributes.providerReceipt.estimatedProviderCostMicros === null)).toBeTrue();
    expect(prefillFacts.some(row => row.event_type === "embedding.call" || row.event_type === "knowledge.query.closed")).toBeFalse();
    const prefillPressure = await pendingKnowledgeQueryPressure(client.db, { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId: grant.subjectId });
    expect(prefillPressure.bytes).toBe(Buffer.byteLength(prefillInput.request.query!, "utf8"));
    expect(prefillPressure.micros).toBe(prefillPressure.bytes);
    providerPhase = "crash";
    const callsBeforeRecovery = physicalCalls;
    const crashedInput = { ...paidInput, operationId: `crashed:${suffix}`, request: { ...paidInput.request, query: "crash" } };
    const crashed = await start(crashedInput);
    try {
      await Promise.race([observedCrashDispatch, child.exited.then(async exitCode => {
        if (crashDispatchObserved) return;
        const diagnostic = await childDiagnostics;
        const path = process.env.OPENGENI_TEST_NATIVE_CHILD_DIAGNOSTIC_FILE
          ?? new URL(`../../../.local/knowledge-query-child-${suffix}.stderr.private`, import.meta.url).pathname;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, diagnostic, { mode: 0o600 }); await chmod(path, 0o600);
        throw new Error(`Activity process exited before physical dispatch (exit ${exitCode}; private diagnostic ${path}; ${diagnostic.length} bytes)`);
      })]);
      child.kill("SIGKILL"); await child.exited;
    } finally {
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      await childDiagnostics;
      releaseCrashProvider(Response.json({ vector: [1, 0, 0] }));
      providerPhase = "recovery";
      // Production restarts in a new process. Reuse the actual crash worker
      // entry, SDK, queue and activities instead of a third Worker in this
      // test process after prior Worker/replay lifecycles.
      recoveryChild = launchChild("recovery");
    }
    // The production start-to-close timeout is unchanged. Its timer schedules
    // only recovery; it never proves provider completion or releases pressure.
    const recoveryExited = recoveryChild!.process.exited.then(async exitCode => {
      if (stoppingRecovery) return new Promise<never>(() => undefined);
      const diagnostic = await recoveryChild!.diagnostics;
      const path = new URL(`../../../.local/knowledge-query-recovery-${suffix}.stderr.private`, import.meta.url).pathname;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, diagnostic, { mode: 0o600 }); await chmod(path, 0o600);
      throw new Error(`Recovery process exited while hosted owner active (exit ${exitCode}; private diagnostic ${path}; ${diagnostic.length} bytes)`);
    });
    void recoveryExited.catch(() => undefined);
    stage("crash-result:start");
    const crashFailure = await Promise.race([crashed.result().then(() => {
      throw new Error("Unknown provider call unexpectedly completed");
    }, error => error), recoveryExited]);
    stage("crash-result:complete");
    expect(crashFailure).toBeInstanceOf(WorkflowFailedError);
    expect(crashFailure.cause).toMatchObject({ type: "KNOWLEDGE_QUERY_OUTCOME_UNKNOWN", nonRetryable: true });
    stage("crash-describe:start");
    expect((await crashed.describe()).status.name).toBe("FAILED");
    stage("crash-describe:complete");
    expect(physicalCalls).toBe(callsBeforeRecovery);
    const crashedCallId = knowledgeQueryOperationId(context, crashedInput.operationId);
    stage("crash-facts:start");
    const crashFacts = await shared.admin`SELECT event_type,attributes FROM usage_events
      WHERE account_id=${grant.accountId} AND source_resource_id=${crashedCallId}`;
    stage("crash-facts:complete");
    expect(crashFacts.some(row => row.event_type === "knowledge.query.indeterminate" && row.attributes.providerReceipt.estimatedProviderCostMicros === null)).toBeTrue();
    expect(crashFacts.some(row => row.event_type === "embedding.call" || row.event_type === "knowledge.query.closed")).toBeFalse();
    expect(crashProviderCalls).toBe(1);
    stage("crash-duplicate:start");
    await expect(start(crashedInput)).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
    stage("crash-duplicate:complete");
    stage("crash-pressure:start");
    const crashPressure = await pendingKnowledgeQueryPressure(client.db, { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId: grant.subjectId });
    stage("crash-pressure:complete");
    expect(crashPressure.bytes).toBe(4 + Buffer.byteLength(crashedInput.request.query!, "utf8"));
    expect(crashPressure.micros).toBe(crashPressure.bytes);
    stage("crash-history:start");
    const crashHistory = await crashed.fetchHistory();
    stage("crash-history:complete");
    stage("crash-replay:start");
    await Worker.runReplayHistory({ workflowBundle: { code } }, crashHistory, crashed.workflowId);
    stage("crash-replay:complete");
    loseResponse = false; revokeOnReturn = true;
    stage("revoked-balance:start");
    const beforeRevocation = (await getBillingBalance(client.db, grant.accountId)).balanceMicros;
    stage("revoked-balance:complete");
    const revokedInput = { ...paidInput, operationId: `revoked:${suffix}` };
    stage("revoked-start:start");
    const revoked = await start(revokedInput);
    stage("revoked-start:complete");
    stage("revoked-provider-commit:start");
    await observedProviderRevocation;
    stage("revoked-provider-commit:complete");
    const beforeRefusal = physicalCalls;
    stage("refused-start:start");
    const refused = await start({ ...paidInput, operationId: `refused:${suffix}` });
    stage("refused-start:complete");
    // The current-authority refusal can run while the first workflow's client
    // observes its terminal result; it still starts after actual revocation.
    stage("revoked-result:start");
    await expect(Promise.race([revoked.result(), recoveryExited])).rejects.toThrow();
    stage("revoked-result:complete");
    stage("revoked-describe:start");
    expect((await revoked.describe()).status.name).toBe("FAILED");
    stage("revoked-describe:complete");
    const revokedCallId = knowledgeQueryOperationId(context, revokedInput.operationId);
    stage("revoked-facts:start");
    const revokedFacts = await shared.admin`SELECT event_type,attributes FROM usage_events
      WHERE account_id=${grant.accountId} AND source_resource_id=${revokedCallId}`;
    stage("revoked-facts:complete");
    expect(revokedFacts.some(row => row.event_type === "embedding.call" && row.attributes.outcome === "completed")).toBeTrue();
    expect(revokedFacts.some(row => row.event_type === "knowledge.query.closed" && row.attributes.settlement === "provider_completed_unsettled")).toBeTrue();
    stage("revoked-balance-readback:start");
    expect((await getBillingBalance(client.db, grant.accountId)).balanceMicros).toBe(beforeRevocation);
    stage("revoked-balance-readback:complete");
    stage("refused-result:start");
    await expect(Promise.race([refused.result(), recoveryExited])).rejects.toThrow();
    stage("refused-result:complete");
    stage("refused-describe:start");
    expect((await refused.describe()).status.name).toBe("FAILED");
    stage("refused-describe:complete");
    expect(physicalCalls).toBe(beforeRefusal);
    stage("business-assertions:complete");
  } finally {
    stage("cleanup:start");
    for (const [index, handle] of handles.entries()) {
      stage("cleanup-describe:start", index);
      const status = (await handle.describe()).status.name;
      stage("cleanup-describe:complete", index);
      if (status === "RUNNING") {
        stage("cleanup-cancel:start", index);
        await handle.cancel();
        stage("cleanup-cancel:complete", index);
        stage("cleanup-result:start", index);
        await handle.result().catch(() => undefined);
        stage("cleanup-result:complete", index);
      }
    }
    if (recoveryChild) {
      stoppingRecovery = true;
      stage("cleanup-child-signal:start");
      if (recoveryChild.process.exitCode === null) recoveryChild.process.kill("SIGTERM");
      stage("cleanup-child-signal:complete");
      stage("cleanup-child-exit:start");
      expect(await recoveryChild.process.exited).toBe(0);
      stage("cleanup-child-exit:complete");
      stage("cleanup-child-diagnostics:start");
      await recoveryChild.diagnostics;
      stage("cleanup-child-diagnostics:complete");
    }
    stage("cleanup-provider:start");
    hostedProvider?.stop(true);
    stage("cleanup-provider:complete");
    stage("cleanup-parent-worker:start");
    await stopWorker();
    stage("cleanup-parent-worker:complete");
    stage("cleanup-native:start");
    await native.close();
    stage("cleanup-native:complete");
    stage("cleanup-client:start");
    await connection.close();
    stage("cleanup-client:complete");
    stage("test-callback:complete");
  }
}, 240_000);
}

test("paid concurrent query admission includes account ceilings and workspace/member pending pressure", async () => {
  const source = await Bun.file(new URL("../../../packages/core/src/domain/knowledge-search.ts", import.meta.url)).text();
  const ceiling = /const MAX_PAID_QUERY_BYTES_PER_MINUTE = (\d+) \* (\d+);/.exec(source);
  if (!ceiling) throw new Error("The released paid query ceiling could not be derived");
  const minuteBytes = Number(ceiling[1]) * Number(ceiling[2]);
  for (const boundary of ["account_bytes", "account_credit", "workspace", "member"] as const) {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "query-pressure", accountExternalId: suffix, accountName: "Query pressure",
      workspaceExternalSource: "query-pressure", workspaceExternalId: suffix, workspaceName: "Query pressure",
      subjectId: `user:query-pressure:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const accountId = grant.accountId, workspaceId = grant.workspaceId!;
    fixtureAccounts.push(accountId);
    const context: KnowledgeContext = { accountId, workspaceId, actor: { kind: "human", principalKind: "human_session",
      subjectId: grant.subjectId, writeScopes: ["workspace"], settingsScopes: ["workspace"], review: true } };
    const settings = { billingMode: "stripe", usageLimitsMode: "managed", staticUsageLimitsJson: "{}",
      documentEmbeddingProvider: "openai", documentEmbeddingBillingMode: "credits",
      documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z", documentEmbeddingRateMicrosPerMillionBytes: 1_000_000 } as Settings;
    const available = boundary === "account_credit" ? 1 : 100_000;
    await shared.admin`INSERT INTO credit_ledger_entries(account_id,type,amount_micros,idempotency_key)
      VALUES(${accountId},'grant',${available},${`query-pressure:${suffix}`})`;
    const query = "abcd", bytes = Buffer.byteLength(query, "utf8");
    if (boundary === "account_bytes") await recordUsageEvent(client.db, { accountId, workspaceId,
      eventType: "document.query_embedding_bytes", quantity: minuteBytes - bytes, unit: "byte",
      idempotencyKey: `query-pressure:prior-bytes:${suffix}` });
    if (boundary === "workspace" || boundary === "member") {
      // Same upstream organization-owner fixture as the installed allowance
      // PG gate; workspace bootstrap alone does not grant organization admin.
      const personalWorkspaceId = crypto.randomUUID();
      await shared.admin`INSERT INTO workspaces(id,account_id,name)
        VALUES(${personalWorkspaceId},${accountId},'Allowance owner personal')`;
      await shared.admin`INSERT INTO organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
        VALUES(${accountId},${grant.subjectId},'owner','active',${personalWorkspaceId})`;
      await setWorkspaceAllowance(client.db, { accountId, workspaceId, actorSubjectId: grant.subjectId,
        includedCredits: boundary === "workspace" ? 1 : available, period: "none", expectedVersion: 0 });
      if (boundary === "member") await setMemberAllowance(client.db, { accountId, workspaceId,
        actorSubjectId: grant.subjectId, subjectId: grant.subjectId, rule: { credits: 1 }, expectedVersion: 0 });
    }
    let entered!: () => void, release!: () => void, physicalCalls = 0;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const embedder: DocumentServices["embedder"] = { model: "query-pressure", dimensions: 3,
      embedMany: async texts => texts.map(() => [1, 0, 0]), embedQuery: async () => {
        physicalCalls++; entered(); await held; return [1, 0, 0];
      } };
    const first = searchKnowledgeEntries(client.db, context, { query, mode: "vector" }, () => embedder, settings);
    try {
      await Promise.race([providerEntered, first.then(() => { throw new Error("Provider admission was not observed"); })]);
      const pressure = await pendingKnowledgeQueryPressure(client.db, { accountId, workspaceId, subjectId: grant.subjectId });
      expect(pressure.bytes).toBe(bytes); expect(pressure.micros).toBe(bytes);
      let nextContext = context;
      if (boundary === "account_credit" || boundary === "account_bytes") {
        // The same funding/safety account covers its other workspace too.
        const otherWorkspaceId = crypto.randomUUID();
        await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${otherWorkspaceId},${accountId},'Other pressure workspace')`;
        nextContext = { ...context, workspaceId: otherWorkspaceId };
      }
      const second = searchKnowledgeEntries(client.db, nextContext, { query, mode: "vector" }, () => embedder, settings);
      if (boundary === "account_credit") await expect(second).rejects.toMatchObject({ code: "knowledge_vector_funding_required" });
      else if (boundary === "account_bytes") await expect(second).rejects.toMatchObject({ code: "quota" });
      else await expect(second).rejects.toMatchObject({ code: "allowance_exhausted", scope: boundary });
      expect(physicalCalls).toBe(1);
    } finally { release(); await first.catch(() => undefined); }
    expect((await first).searchMode).toBe("vector");
    const pressure = await pendingKnowledgeQueryPressure(client.db, { accountId, workspaceId, subjectId: grant.subjectId });
    expect(pressure.bytes).toBe(0); expect(pressure.micros).toBe(0);
    expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(available - bytes);
  }
}, 30_000);
