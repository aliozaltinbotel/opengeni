import { createHash } from "node:crypto";
import {
  EMBEDDING_CALL_USAGE_EVENT_TYPE,
  KnowledgeEntryListRequest,
  type KnowledgeEntryListResponse,
} from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import {
  applyCreditDebitAfterUse,
  checkWorkspaceAllowance,
  creditDebitAttributionForTurn,
  getSpendableCreditBalance,
  listKnowledgeEntries,
  recordUsageEvent,
  sumUsageQuantity,
  pendingKnowledgeQueryPressure,
  readKnowledgeQueryUsageFact,
  isTransactionHandle,
  withRlsContext,
  knowledgeEntryIdForOperation,
  withKnowledgeQueryAccountLock,
  type Database,
  type KnowledgeContext,
  type CreditDebitAttribution,
} from "@opengeni/db";
import type { DocumentEmbedder, EmbeddingProviderCompletionReceipt } from "@opengeni/documents";
import type { z } from "zod";
import {
  documentEmbeddingCostMicros,
  embeddingCallUsageAttributes,
  embeddingCallSourceAttributes,
  paidDocumentEmbedding,
} from "../billing/limits";

// Safety ceilings, not a commercial tariff. Paid queries have no durable
// reusable vector cache, so each bounded request consumes the provider once.
const MAX_PAID_QUERY_BYTES = 4096;
const MAX_PAID_QUERY_MICROS = 1000;
const MAX_PAID_QUERY_BYTES_PER_MINUTE = 64 * 1024;
const MAX_PAID_QUERY_BYTES_PER_MONTH = 8 * 1024 * 1024;
const MAX_PAID_QUERY_MICROS_PER_MINUTE = 10_000;
const MAX_PAID_QUERY_MICROS_PER_MONTH = 1_000_000;

export class KnowledgeVectorFundingError extends Error {
  readonly code = "knowledge_vector_funding_required";
  constructor() {
    super("Knowledge vector search needs Opengeni credits; keyword search remains available.");
    this.name = "KnowledgeVectorFundingError";
  }
}

export class KnowledgeVectorQueryRejectedError extends Error {
  constructor(
    public readonly code: "pagination_unavailable" | "query_limit" | "quota",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeVectorQueryRejectedError";
  }
}

export type KnowledgeQueryExecution = {
  callId: string;
  owner: { workflowId: string; workflowRunId: string; activityId: string };
  authorize: (tx: Database) => Promise<void>;
};

export function knowledgeQueryOperationId(context: KnowledgeContext, operationId: string, kind: "query" | "preparation" = "query"): string {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(operationId)) throw new Error("KNOWLEDGE_QUERY_OPERATION_ID_INVALID");
  const actor = context.actor;
  const identity = actor.kind === "agent" ? actor
    : { kind: actor.kind, principalKind: actor.principalKind, subjectId: actor.subjectId };
  return knowledgeEntryIdForOperation(context.accountId, `${kind}:${context.workspaceId}:${JSON.stringify(identity)}:${operationId}`);
}

export function knowledgeQueryRetrievalRequest(request: KnowledgeEntryListRequest): KnowledgeEntryListRequest {
  if (!request.query || request.mode !== "hybrid") return request;
  const lexicalQuery = /^[\p{L}\p{N}\s]+$/u.test(request.query) && !/\bOR\b/i.test(request.query)
    ? [...new Set(request.query.trim().split(/\s+/u))].map(term => `"${term}"`).join(" OR ") : request.query;
  const lexical = KnowledgeEntryListRequest.safeParse({ ...request, query: lexicalQuery });
  return lexical.success ? lexical.data : request;
}

/** Shared search path for HTTP and both first-party retrieval servers. */
export async function searchKnowledgeEntries(
  db: Database,
  context: KnowledgeContext,
  input: z.input<typeof KnowledgeEntryListRequest>,
  embedder: () => DocumentEmbedder,
  settings?: Settings,
  execution?: KnowledgeQueryExecution,
): Promise<KnowledgeEntryListResponse> {
  if (isTransactionHandle(db)) throw new Error("KNOWLEDGE_QUERY_REQUIRES_ROOT_DATABASE");
  const request = KnowledgeEntryListRequest.parse(input);
  // Copy trusted actor fields before any provider/lock await. Request lifetime
  // mutation cannot replace the initiating identity between admission/debit.
  const billingActor = { ...context.actor };
  const callOwner = { accountId: context.accountId, workspaceId: context.workspaceId };
  let paidAttribution: CreditDebitAttribution =
    billingActor.kind === "human"
      ? { kind: "human", initiatingHumanSubjectId: billingActor.subjectId }
      : billingActor.kind === "service"
        ? { kind: "service" }
        : { kind: "unknown" };
  if (!request.query || request.mode === "keyword") {
    return {
      ...(await listKnowledgeEntries(db, context, request)),
      searchMode: "keyword" as const,
    };
  }
  // Hybrid queries are natural language, not a conjunction of every synonym.
  // Keep lexical recall useful when embeddings or vector indexing are unavailable.
  // Explicit keyword syntax and keyword-mode queries retain their exact semantics.
  const retrievalRequest = knowledgeQueryRetrievalRequest(request);
  const keywordFallback = async (
    queryDb: Database,
    error: unknown,
    fallbackReason: "awaiting_funding" | "quota" | "provider_unavailable" | "query_limit",
  ) => {
    if (request.mode === "vector") throw error;
    return {
      ...(await listKnowledgeEntries(queryDb, context, { ...retrievalRequest, mode: "keyword" })),
      searchMode: "keyword" as const,
      fallbackReason,
    };
  };
  const bytes = Buffer.byteLength(request.query, "utf8");
  const paidSettings = settings && paidDocumentEmbedding(settings) ? settings : undefined;
  // Paid cursors would re-embed and re-charge on each page. Until a durable
  // vector cache exists, require explicit keyword mode to paginate instead.
  if (paidSettings && request.cursor)
    throw new KnowledgeVectorQueryRejectedError(
      "pagination_unavailable",
      "Paid semantic Knowledge pagination is unavailable; use keyword mode",
    );
  const cost = paidSettings ? documentEmbeddingCostMicros(paidSettings, bytes) : 0;
  if (paidSettings && (bytes > MAX_PAID_QUERY_BYTES || cost > MAX_PAID_QUERY_MICROS))
    return keywordFallback(
      db,
      new KnowledgeVectorQueryRejectedError(
        "query_limit",
        "Paid Knowledge query exceeds the per-request limit",
      ),
      "query_limit",
    );

  const usageId = execution?.callId ?? crypto.randomUUID();
  const requestDigest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const actorDigest = createHash("sha256").update(JSON.stringify(billingActor, Object.keys(billingActor).sort())).digest("hex");
  const binding = { schema: "opengeni.knowledge-query-source/v1", requestDigest, actorDigest,
    inputBytes: bytes, costBoundMicros: cost, provider: settings?.documentEmbeddingProvider ?? null,
    model: settings?.documentEmbeddingModel ?? null, rateMicrosPerMillionBytes: settings?.documentEmbeddingRateMicrosPerMillionBytes ?? null,
    billingPath: paidSettings ? "opengeni_credits" : "external" };
  const locked = <T>(fn: (tx: Database) => Promise<T>): Promise<T> =>
    withRlsContext(db, callOwner, async tx => {
      // External organization lifecycle precedes the shared tenancy/usage locks.
      await execution?.authorize(tx);
      return withKnowledgeQueryAccountLock(tx, context.accountId, context.workspaceId, fn);
    }, undefined, "none");
  const sourceFact = (eventType: "knowledge.query.admitted" | "knowledge.query.dispatched" | "knowledge.query.closed",
    attributes: Record<string, unknown>, queryDb: Database) => recordUsageEvent(queryDb, {
      ...callOwner, eventType, quantity: 1, unit: "call", sourceResourceType: "knowledge_query", sourceResourceId: usageId,
      idempotencyKey: `usage:${eventType}:query:${usageId}`, attributes,
      subjectId: paidAttribution.kind === "human" ? paidAttribution.initiatingHumanSubjectId
        : paidAttribution.kind === "turn" ? paidAttribution.initiatingHumanSubjectId : null,
    });
  const completedCalls: Parameters<typeof recordUsageEvent>[1][] = [];
  const factWrites: Promise<unknown>[] = [];
  let dispatched = false;
  const close = async (queryDb: Database, settlement: string) => {
    await sourceFact("knowledge.query.closed", { ...binding, settlement }, queryDb);
  };
  const retrieveThenSettle = async (queryDb: Database) => {
    const providerName = settings?.documentEmbeddingProvider ?? "unspecified";
    const rate = settings?.documentEmbeddingRateMicrosPerMillionBytes ?? 0;
    const captureCompleted = (receipt: EmbeddingProviderCompletionReceipt) => {
      // Commit at provider return, before vector validation or customer
      // settlement. A provider fact cannot be erased by their rollback.
      if (receipt.callId !== usageId) throw new Error("KNOWLEDGE_QUERY_PROVIDER_CALL_ID_CONFLICT");
      const fact: Parameters<typeof recordUsageEvent>[1] = {
        ...callOwner,
        occurredAt: new Date(receipt.completedAt),
        eventType: EMBEDDING_CALL_USAGE_EVENT_TYPE,
        quantity: 1,
        unit: "call",
        sourceResourceType: "knowledge_query",
        sourceResourceId: receipt.callId,
        idempotencyKey: `usage:${EMBEDDING_CALL_USAGE_EVENT_TYPE}:query:${receipt.callId}`,
        attributes: embeddingCallUsageAttributes({
          callKind: "query",
          provider: receipt.provider === "unspecified" ? null : receipt.provider,
          model: receipt.model,
          inputBytes: receipt.inputBytes,
          inputItems: receipt.inputItems,
          rateMicrosPerMillionBytes: rate,
          billingPath: paidSettings ? "opengeni_credits" : "external",
        }),
      };
      completedCalls.push(fact);
      const write = recordUsageEvent(db, fact);
      factWrites.push(write);
      return write.then(() => undefined);
    };
    let embedding: { model: string; values: number[] };
    let dimensions: number;
    try {
      const provider = embedder();
      const model = provider.model;
      dimensions = provider.dimensions;
      // The dispatch claim is committed before the provider sees the request.
      // Re-entry never repeats an effect whose response may have been lost.
      await locked(async tx => {
        if (await readKnowledgeQueryUsageFact(tx, { ...callOwner, callId: usageId, eventType: "knowledge.query.closed" }))
          throw new Error("KNOWLEDGE_QUERY_EXECUTION_CLOSED");
        if (await readKnowledgeQueryUsageFact(tx, { ...callOwner, callId: usageId, eventType: "knowledge.query.dispatched" }))
          throw new Error("KNOWLEDGE_QUERY_DISPATCH_ALREADY_RECORDED");
        await sourceFact("knowledge.query.dispatched", { ...binding, model, owner: execution?.owner ?? null,
          providerReceipt: embeddingCallSourceAttributes({ callId: usageId, callKind: "query",
            provider: providerName === "unspecified" ? null : providerName, model, inputBytes: bytes, inputItems: 1,
            rateMicrosPerMillionBytes: rate, billingPath: paidSettings ? "opengeni_credits" : "external" }) }, tx);
      });
      dispatched = true;
      const values = await provider.embedQuery(request.query!, captureCompleted, { callId: usageId,
        beforeDispatch: async receipt => {
          if (receipt.callId !== usageId || receipt.model !== model || receipt.inputBytes !== bytes || receipt.inputItems !== 1)
            throw new Error("KNOWLEDGE_QUERY_PROVIDER_DISPATCH_CONFLICT");
          await locked(async tx => {
            if (await readKnowledgeQueryUsageFact(tx, { ...callOwner, callId: usageId, eventType: "knowledge.query.closed" }))
              throw new Error("KNOWLEDGE_QUERY_EXECUTION_CLOSED");
            if (paidSettings) {
              const subjectId = paidAttribution.kind === "turn" || paidAttribution.kind === "human"
                ? paidAttribution.initiatingHumanSubjectId : null;
              const pressure = await pendingKnowledgeQueryPressure(tx, { ...callOwner, subjectId, excludeQueryCallId: usageId });
              if ((await getSpendableCreditBalance(tx, context.accountId)).balanceMicros-pressure.micros<=0)
                throw new KnowledgeVectorFundingError();
              const refusal = await checkWorkspaceAllowance(tx, { ...callOwner, subjectId,
                pendingWorkspaceMicros: pressure.workspaceMicros, pendingMemberMicros: pressure.memberMicros });
              if (refusal) throw Object.assign(new Error(refusal.message),refusal);
            }
          });
        },
      });
      embedding = { model, values };
    } catch (error) {
      if (dispatched && completedCalls.length === 0) {
        const admission = await readKnowledgeQueryUsageFact(db, { ...callOwner, callId: usageId, eventType: "knowledge.query.admitted" });
        const dispatch = await readKnowledgeQueryUsageFact(db, { ...callOwner, callId: usageId, eventType: "knowledge.query.dispatched" });
        if (!admission || !dispatch) throw new Error("KNOWLEDGE_QUERY_SOURCE_INVALID");
        await recordUsageEvent(db, { ...callOwner, eventType: "knowledge.query.indeterminate", quantity: 1, unit: "call",
          sourceResourceType: "knowledge_query", sourceResourceId: usageId,
          idempotencyKey: `usage:knowledge.query.indeterminate:query:${usageId}`, occurredAt: admission.occurredAt,
          attributes: { ...admission.attributes, ...dispatch.attributes,
            outcome: "indeterminate", inputTokens: null, estimatedProviderCostMicros: null, pricingSource: null } });
      }
      return keywordFallback(queryDb, error, "provider_unavailable");
    }
    // Older/local embedders expose vectors only. Their successful return is
    // still the completion fact; observer-aware adapters already captured it.
    if (completedCalls.length === 0)
      await captureCompleted({
        callId: usageId,
        provider: providerName,
        model: embedding.model,
        inputBytes: bytes,
        inputItems: 1,
        completedAt: new Date().toISOString(),
      });
    await Promise.all(factWrites);
    const settle = async (settlementDb: Database) => {
    if (await readKnowledgeQueryUsageFact(settlementDb, { ...callOwner, callId: usageId, eventType: "knowledge.query.closed" }))
      throw new Error("KNOWLEDGE_QUERY_EXECUTION_CLOSED");
    if (
      embedding.values.length !== dimensions ||
      embedding.values.some((value) => !Number.isFinite(value)) ||
      !embedding.values.some((value) => value !== 0)
    )
      {
      await close(settlementDb, "provider_completed_unusable");
      return keywordFallback(
        settlementDb,
        new Error("Knowledge query embedding is unavailable"),
        "provider_unavailable",
      );
      }
    // Retrieval and customer settlement remain atomic in paid mode. A failed
    // read leaves no customer debit while preserving the provider call fact.
    const found = await listKnowledgeEntries(settlementDb, context, retrievalRequest, embedding);
    if (settings) {
      await recordUsageEvent(settlementDb, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        eventType: "document.query_embedding_bytes",
        quantity: bytes,
        unit: "byte",
        sourceResourceType: "knowledge_query",
        sourceResourceId: usageId,
        idempotencyKey: `knowledge.query_bytes:${usageId}`,
      });
      if (paidSettings && cost > 0)
        await recordUsageEvent(settlementDb, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          eventType: "document.query_embedding_cost",
          quantity: cost,
          unit: "micro_usd",
          sourceResourceType: "knowledge_query",
          sourceResourceId: usageId,
          idempotencyKey: `knowledge.query_cost:${usageId}`,
          // Durable receipt inserted before the debit in this same transaction.
          // The service is the writer, not an inferred causal human.
          initiator: { kind: "service", subjectId: "worker:knowledge-query" },
          initiatorContext: { creditDebitAttribution: paidAttribution },
        });
      if (paidSettings && cost > 0)
        await applyCreditDebitAfterUse(settlementDb, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          type: "document_embedding_debit",
          amountMicros: cost,
          sourceType: "knowledge_query",
          sourceId: usageId,
          idempotencyKey: `knowledge.query_embedding:${usageId}`,
          metadata: {
            model: embedding.model,
            bytes,
            // This context is constructed by the trusted HTTP/MCP host, never
            // from request input. The ledger resolves the immutable exact turn;
            // an API key's subject (or a session creator) is not a human.
            ...(billingActor.kind === "agent"
              ? { turnId: billingActor.turnId }
              : billingActor.kind === "human"
                ? { initiatingHumanSubjectId: billingActor.subjectId }
                : {}),
          },
        });
    }
    await close(settlementDb, "settled");
    return { ...found, searchMode: request.mode };
    };
    return locked(settle);
  };
  try {
    // Serialize paid queries across all workspaces of the account before
    // checking balance. This is an execution fence, not a credit reservation.
    const admission = await locked(async (lockedDb) => {
        if (await readKnowledgeQueryUsageFact(lockedDb, { ...callOwner, callId: usageId, eventType: "knowledge.query.closed" }))
          throw new Error("KNOWLEDGE_QUERY_EXECUTION_CLOSED");
        const existing = await readKnowledgeQueryUsageFact(lockedDb, { ...callOwner, callId: usageId, eventType: "knowledge.query.admitted" });
        if (existing) {
          if (existing.attributes.requestDigest !== requestDigest || existing.attributes.actorDigest !== actorDigest)
            throw new Error("KNOWLEDGE_QUERY_OPERATION_INPUT_CONFLICT");
          for (const field of ["inputBytes", "costBoundMicros", "provider", "model", "rateMicrosPerMillionBytes", "billingPath"] as const)
            if (existing.attributes[field] !== binding[field]) throw new Error("KNOWLEDGE_QUERY_ADMISSION_CONFIGURATION_CONFLICT");
          return { admitted: true as const };
        }
        if (!paidSettings) {
          await sourceFact("knowledge.query.admitted", binding, lockedDb);
          return { admitted: true as const };
        }
        const attribution = billingActor.kind === "agent"
          ? await creditDebitAttributionForTurn(lockedDb, { ...callOwner, turnId: billingActor.turnId })
          : null;
        const subjectId = billingActor.kind === "human" ? billingActor.subjectId
          : attribution?.kind === "turn" || attribution?.kind === "human" ? attribution.initiatingHumanSubjectId : null;
        const pressure = await pendingKnowledgeQueryPressure(lockedDb, { ...callOwner, subjectId });
        const balance = await getSpendableCreditBalance(lockedDb, context.accountId);
        if (balance.balanceMicros - pressure.micros <= 0)
          return { admitted: false as const, response: await keywordFallback(lockedDb, new KnowledgeVectorFundingError(), "awaiting_funding") };
        if (attribution) paidAttribution = attribution;
        const refusal = await checkWorkspaceAllowance(lockedDb, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          pendingWorkspaceMicros: pressure.workspaceMicros, pendingMemberMicros: pressure.memberMicros,
          subjectId:
            billingActor.kind === "human"
              ? billingActor.subjectId
              : attribution?.kind === "turn"
                ? attribution.initiatingHumanSubjectId
                : null,
        });
        if (refusal)
          return { admitted: false as const, response: await keywordFallback(
            lockedDb, Object.assign(new Error(refusal.message), refusal), "quota") };
        const now = new Date();
        const minuteBytes = await sumUsageQuantity(lockedDb, {
          accountId: context.accountId,
          eventType: "document.query_embedding_bytes",
          since: new Date(now.getTime() - 60_000),
        });
        const monthBytes = await sumUsageQuantity(lockedDb, {
          accountId: context.accountId,
          eventType: "document.query_embedding_bytes",
          since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        });
        const minuteMicros = await sumUsageQuantity(lockedDb, {
          accountId: context.accountId,
          eventType: "document.query_embedding_cost",
          since: new Date(now.getTime() - 60_000),
        });
        const monthMicros = await sumUsageQuantity(lockedDb, {
          accountId: context.accountId,
          eventType: "document.query_embedding_cost",
          since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        });
        if (
          minuteBytes + pressure.bytes + bytes > MAX_PAID_QUERY_BYTES_PER_MINUTE ||
          monthBytes + pressure.bytes + bytes > MAX_PAID_QUERY_BYTES_PER_MONTH ||
          minuteMicros + pressure.queryMicros + cost > MAX_PAID_QUERY_MICROS_PER_MINUTE ||
          monthMicros + pressure.queryMicros + cost > MAX_PAID_QUERY_MICROS_PER_MONTH
        )
          return { admitted: false as const, response: await keywordFallback(
            lockedDb, new KnowledgeVectorQueryRejectedError("quota", "Paid Knowledge query rate limit reached"), "quota") };
        await sourceFact("knowledge.query.admitted", binding, lockedDb);
        return { admitted: true as const };
    });
    if (!admission.admitted) return admission.response;
    return await retrieveThenSettle(db);
  } finally {
    // Drain the original fact only after the usage transaction has committed or
    // rolled back. This works on a single-connection pool and cannot be erased
    // by retrieval/debit failure. A failed fact write is never a fallback.
    await Promise.all(factWrites);
  }
}
