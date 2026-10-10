import { namedSubjectPersonalWorkspaceId } from "./slack-routing-personal-workspace";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { StoredKnowledgeEntryContent } from "@opengeni/contracts";
import { rawRows, withRlsContext, withWorkspaceUsageLock, type Database } from "./database";
import { fromPostgresLosslessJson, toPostgresLosslessText } from "./lossless-json";
import { CreditDebitAttribution } from "./credit-debit-attribution";
export {
  CreditDebitAttribution,
  creditDebitAttributionMetadata,
  creditDebitAttributionForTurn,
  currentCreditDebitAttribution,
  withCreditDebitAttribution,
} from "./credit-debit-attribution";

const Claim = z.object({
  accountId: z.uuid(),
  entryId: z.uuid(),
  revisionId: z.uuid(),
  leaseId: z.uuid(),
  model: z.string().min(1).max(512),
  dimensions: z.number().int().min(1).max(4096),
  generation: z.number().int().positive(),
  nextIndex: z.number().int().nonnegative(),
  billingAttribution: CreditDebitAttribution,
});
export type KnowledgeIndexClaim = z.infer<typeof Claim>;

/** DB-clock cutoff for this worker's first indexing poll, not a host-clock guess. */
export async function knowledgeIndexBillingActivationTime(db: Database): Promise<Date> {
  const [row] = await rawRows<{ activatedAt: Date }>(
    db,
    sql`SELECT clock_timestamp() AS "activatedAt"`,
  );
  return z.coerce.date().parse(row?.activatedAt);
}

/** Persist the chosen mode for exactly this leased generation. Paid review-first
 * revisions release the lease without embedding until published. */
export async function freezeKnowledgeIndexBillingMode(
  db: Database,
  raw: KnowledgeIndexClaim,
  requested: "usage_only" | "shadow" | "credits",
  activatedAt: Date,
  rateMicrosPerMillionBytes: number,
) {
  const claim = Claim.parse(raw);
  return withRlsContext(db, { accountId: claim.accountId }, async (tx) => {
    const [row] = await rawRows<{ policy: unknown }>(
      tx,
      sql`SELECT knowledge_index_billing_policy(${claim.accountId}::uuid,
        ${claim.revisionId}::uuid,${claim.leaseId}::uuid,${requested},
        ${activatedAt.toISOString()}::timestamptz,
        ${rateMicrosPerMillionBytes}::bigint) AS policy`,
    );
    return z
      .object({
        mode: z.enum(["usage_only", "shadow", "credits", "awaiting_review", "obsolete"]),
        rateMicrosPerMillionBytes: z.number().int().nonnegative(),
      })
      .parse(row?.policy);
  });
}

/** Serialize paid query admission and settlement across an entire account. */
export async function withKnowledgeQueryAccountLock<T>(
  db: Database,
  accountId: string,
  workspaceId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return withWorkspaceUsageLock(db, workspaceId, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`knowledge-query-account:${accountId}`}))`,
    );
    return fn(tx);
  });
}

/** Non-billing admission/dispatch/closure facts share the installed immutable
 * usage source. Raw query text and actor context never enter these events. */
export async function readKnowledgeQueryUsageFact(db: Database, input: {
  accountId: string; workspaceId: string; callId: string;
  eventType: "knowledge.query.admitted" | "knowledge.query.dispatched" | "knowledge.query.indeterminate" | "knowledge.query.closed" | "embedding.call";
}): Promise<{ attributes: Record<string, unknown>; occurredAt: Date } | null> {
  return withRlsContext(db, input, async tx => {
    const [row] = await rawRows<{ attributes: Record<string, unknown>; occurredAt: Date }>(tx,
      sql`SELECT attributes, occurred_at AS "occurredAt" FROM usage_events
        WHERE account_id=${input.accountId}::uuid AND workspace_id=${input.workspaceId}::uuid
          AND source_resource_type='knowledge_query' AND source_resource_id=${input.callId}
          AND event_type=${input.eventType} AND idempotency_key=${`usage:${input.eventType}:query:${input.callId}`}`);
    return row ?? null;
  });
}

/** Unknown dispatch retains pressure irrespective of time/period or provider
 * completion. Only atomic customer settlement or proven no dispatch closes it. */
export async function pendingKnowledgeQueryPressure(db: Database, input: {
  accountId: string; workspaceId: string; subjectId: string | null; excludeIndexCallId?: string; excludeQueryCallId?: string;
}): Promise<{ bytes: number; micros: number; workspaceMicros: number; memberMicros: number; indexedChunks: number; queryMicros: number }> {
  // Funding and safety ceilings cover all workspaces of this exact account;
  // restore the caller's narrower scope when this savepoint returns.
  return withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async tx => {
    const [row] = await rawRows<{ bytes: string; micros: string; workspaceMicros: string; memberMicros: string; indexedChunks: string; queryMicros: string }>(tx,
      sql`SELECT coalesce(sum((admission.attributes->>'inputBytes')::bigint) FILTER (WHERE admission.source_resource_type='knowledge_query'),0)::text AS bytes,
        coalesce(sum((admission.attributes->>'inputItems')::bigint) FILTER (WHERE admission.source_resource_type='knowledge_revision' AND admission.workspace_id=${input.workspaceId}::uuid),0)::text AS "indexedChunks",
        coalesce(sum((admission.attributes->>'costBoundMicros')::bigint) FILTER (WHERE admission.attributes->>'billingPath'='opengeni_credits'),0)::text AS micros,
        coalesce(sum((admission.attributes->>'costBoundMicros')::bigint) FILTER (WHERE admission.source_resource_type='knowledge_query'),0)::text AS "queryMicros",
        coalesce(sum((admission.attributes->>'costBoundMicros')::bigint) FILTER (WHERE admission.workspace_id=${input.workspaceId}::uuid AND admission.attributes->>'billingPath'='opengeni_credits'),0)::text AS "workspaceMicros",
        coalesce(sum((admission.attributes->>'costBoundMicros')::bigint) FILTER (WHERE admission.workspace_id=${input.workspaceId}::uuid AND admission.subject_id=${input.subjectId} AND admission.attributes->>'billingPath'='opengeni_credits'),0)::text AS "memberMicros"
      FROM usage_events admission WHERE admission.account_id=${input.accountId}::uuid
        AND ((admission.event_type='knowledge.query.admitted' AND admission.source_resource_type='knowledge_query' AND admission.attributes->>'billingPath'='opengeni_credits'
          AND admission.source_resource_id IS DISTINCT FROM ${input.excludeQueryCallId ?? null}
          AND NOT EXISTS (SELECT 1 FROM usage_events closure WHERE closure.account_id=admission.account_id
            AND closure.workspace_id=admission.workspace_id AND closure.event_type='knowledge.query.closed'
            AND closure.source_resource_type='knowledge_query' AND closure.source_resource_id=admission.source_resource_id
            AND closure.idempotency_key='usage:knowledge.query.closed:query:' || admission.source_resource_id))
        OR (admission.event_type='knowledge.index.dispatched' AND admission.source_resource_type='knowledge_revision'
          AND admission.attributes->>'callId' IS DISTINCT FROM ${input.excludeIndexCallId ?? null}
          AND NOT EXISTS(SELECT 1 FROM usage_events settled WHERE settled.account_id=admission.account_id AND settled.workspace_id=admission.workspace_id
            AND settled.event_type='document.indexed' AND settled.source_resource_type='knowledge_revision' AND settled.source_resource_id=admission.source_resource_id
            AND settled.idempotency_key='knowledge.indexed:'||admission.source_resource_id||':'||(admission.attributes->>'generation')||':'||(admission.attributes->>'nextIndex'))
          AND CASE WHEN admission.event_type='knowledge.index.dispatched' AND admission.source_resource_type='knowledge_revision' THEN
            (knowledge_index_work(admission.account_id,admission.source_resource_id::uuid,(admission.attributes->>'leaseId')::uuid,
              jsonb_build_object('operation','receipt_owner','callId',admission.attributes->>'callId'))->>'pending')::boolean ELSE false END))`);
    const result = { bytes: Number(row?.bytes), micros: Number(row?.micros),
      workspaceMicros: Number(row?.workspaceMicros), memberMicros: Number(row?.memberMicros), indexedChunks: Number(row?.indexedChunks), queryMicros: Number(row?.queryMicros) };
    if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("KNOWLEDGE_QUERY_PRESSURE_UNKNOWN");
    return result;
  });
}

/** A reclaimed lease cannot retry an index provider effect whose completion
 * was never durably observed. Known completed, unpublished batches remain
 * eligible for a fresh physical call under the existing publication guards. */
export async function hasIndeterminateKnowledgeIndexDispatch(db: Database, input: {
  accountId: string; workspaceId: string; revisionId: string; generation: number; nextIndex: number; callId: string;
}): Promise<boolean> {
  return withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async tx => {
    const [row] = await rawRows<{ pending: boolean }>(tx, sql`SELECT EXISTS (
      SELECT 1 FROM usage_events dispatch
      WHERE dispatch.account_id=${input.accountId}::uuid
        AND dispatch.event_type='knowledge.index.dispatched' AND dispatch.source_resource_type='knowledge_revision'
        AND dispatch.source_resource_id=${input.revisionId} AND dispatch.attributes->>'generation'=${String(input.generation)}
        AND dispatch.attributes->>'nextIndex'=${String(input.nextIndex)} AND dispatch.attributes->>'callId'<>${input.callId}
        AND NOT EXISTS (SELECT 1 FROM usage_events completion
          WHERE completion.account_id=dispatch.account_id AND completion.workspace_id=dispatch.workspace_id
            AND completion.event_type='embedding.call' AND completion.source_resource_type=dispatch.source_resource_type
            AND completion.source_resource_id=dispatch.source_resource_id
            AND completion.idempotency_key=dispatch.attributes->>'completionKey')
    ) AS pending`);
    if (typeof row?.pending !== "boolean") throw new Error("KNOWLEDGE_INDEX_DISPATCH_STATE_UNKNOWN");
    return row.pending;
  });
}

/** Internal projection dispatcher. No HTTP, MCP or agent tool exposes this capability. */
export async function claimKnowledgeIndexJobs(
  db: Database,
  input: { model: string; dimensions: number; limit?: number },
) {
  const request = z
    .object({
      model: Claim.shape.model,
      dimensions: Claim.shape.dimensions,
      limit: z.number().int().min(1).max(20).default(5),
    })
    .parse(input);
  const [row] = await rawRows<{ claims: unknown }>(
    db,
    sql`SELECT knowledge_index_claim(${request.model},${request.dimensions},${request.limit}) AS claims`,
  );
  return z.array(Claim).parse(row?.claims);
}
async function work(db: Database, raw: KnowledgeIndexClaim, request: Record<string, unknown>) {
  const claim = Claim.parse(raw);
  return withRlsContext(db, { accountId: claim.accountId }, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`SELECT knowledge_index_work(${claim.accountId}::uuid,
      ${claim.revisionId}::uuid,${claim.leaseId}::uuid,${JSON.stringify(request)}::jsonb) AS result`,
    );
    return z
      .object({
        status: z.enum(["running", "pending", "obsolete", "ready"]),
        nextIndex: z.number().int().optional(),
      })
      .passthrough()
      .parse(row?.result);
  });
}
export async function readKnowledgeIndexSource(db: Database, claim: KnowledgeIndexClaim) {
  const result = await work(db, claim, { operation: "read" });
  if (result.status !== "running") return null;
  const scope = z.enum(["workspace", "personal", "organization"]).parse(result.scope);
  const subjectId = z.string().nullable().parse(result.subjectId);
  const originWorkspaceId = z.uuid().parse(result.originWorkspaceId);
  // The lease authorizes this lookup for accounting only. Its canonical owner
  // tuple is not an authenticated human, access grant, or publication authority.
  // Personal retained content survives deletion of its originating workspace.
  const billingWorkspaceId =
    scope === "personal" && subjectId
      ? ((await namedSubjectPersonalWorkspaceId(db, { accountId: claim.accountId, subjectId })) ??
        originWorkspaceId)
      : originWorkspaceId;
  return {
    billingWorkspaceId,
    entry: StoredKnowledgeEntryContent.parse(
      fromPostgresLosslessJson(result.body, result.codecVersion as number | null),
    ),
    nextIndex: z.number().int().nonnegative().parse(result.nextIndex),
    originWorkspaceId: z.uuid().parse(result.originWorkspaceId),
    scope: z.enum(["workspace", "personal", "organization"]).parse(result.scope),
  };
}
export type KnowledgeIndexProjectionChunk = {
  index: number;
  field: "content" | "title";
  start: number;
  end: number;
  text: string;
  embedding: number[];
};
export async function appendKnowledgeIndexChunks(
  db: Database,
  claim: KnowledgeIndexClaim,
  expectedNextIndex: number,
  chunks: KnowledgeIndexProjectionChunk[],
) {
  const input = z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        field: z.enum(["content", "title"]),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        text: z.string(),
        embedding: z.array(z.number().finite()).length(claim.dimensions),
      }),
    )
    .min(1)
    .max(64)
    .parse(chunks);
  return work(db, claim, {
    operation: "append",
    expectedNextIndex,
    chunks: input.map((chunk) => ({ ...chunk, text: toPostgresLosslessText(chunk.text) })),
  });
}
export async function completeKnowledgeIndexJob(
  db: Database,
  claim: KnowledgeIndexClaim,
  expectedNextIndex: number,
) {
  return work(db, claim, { operation: "complete", expectedNextIndex });
}
export async function deferKnowledgeIndexJob(db: Database, claim: KnowledgeIndexClaim) {
  return work(db, claim, { operation: "fail" });
}

/** A funding wait is not a provider failure. Keep the lease checkpoint intact. */
export async function waitKnowledgeIndexForFunding(db: Database, raw: KnowledgeIndexClaim) {
  const claim = Claim.parse(raw);
  return withRlsContext(db, { accountId: claim.accountId }, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`SELECT knowledge_index_wait_for_funding(${claim.accountId}::uuid,
        ${claim.revisionId}::uuid,${claim.leaseId}::uuid) AS result`,
    );
    return z.object({ status: z.enum(["pending", "obsolete"]) }).parse(row?.result);
  });
}

/** Hold publication stable through the paid append + post-use debit commit.
 * Call only after embedding, inside the same transaction as settlement. */
export async function guardPaidKnowledgeIndexPublication(db: Database, raw: KnowledgeIndexClaim) {
  const claim = Claim.parse(raw);
  return withRlsContext(db, { accountId: claim.accountId }, async (tx) => {
    const [row] = await rawRows<{ status: string }>(
      tx,
      sql`SELECT knowledge_index_paid_publication_guard(${claim.accountId}::uuid,
        ${claim.revisionId}::uuid,${claim.leaseId}::uuid) AS status`,
    );
    return z.enum(["published", "awaiting_review", "obsolete"]).parse(row?.status);
  });
}

export async function continueKnowledgeIndexJob(db: Database, claim: KnowledgeIndexClaim) {
  return work(db, claim, { operation: "continue" });
}
