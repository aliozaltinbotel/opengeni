import { createHash } from "node:crypto";
import { configuredStaticUsageLimits } from "@opengeni/config";
import { EMBEDDING_CALL_USAGE_EVENT_TYPE } from "@opengeni/contracts";
import {
  documentEmbeddingCostMicros,
  embeddingCallUsageAttributes,
  embeddingCallSourceAttributes,
  paidDocumentEmbedding,
  searchKnowledgeEntries,
  authorizeKnowledgeQueryOwner,
  knowledgeQueryOperationId,
  type KnowledgeQueryWorkflowRequest,
  type KnowledgePreparationWorkflowRequest,
  prepareKnowledgeSave,
} from "@opengeni/core";
import {
  applyCreditDebitAfterUse,
  appendKnowledgeIndexChunks,
  claimKnowledgeIndexJobs,
  checkWorkspaceAllowance,
  completeKnowledgeIndexJob,
  continueKnowledgeIndexJob,
  creditDebitAttributionMetadata,
  deferKnowledgeIndexJob,
  freezeKnowledgeIndexBillingMode,
  getSpendableCreditBalance,
  guardPaidKnowledgeIndexPublication,
  knowledgeIndexBillingActivationTime,
  readKnowledgeIndexSource,
  hasIndeterminateKnowledgeIndexDispatch,
  pendingKnowledgeQueryPressure,
  readKnowledgeQueryUsageFact,
  withKnowledgeQueryAccountLock,
  isTransactionHandle,
  recordUsageEvent,
  sumUsageQuantity,
  withWorkspaceUsageLock,
  waitKnowledgeIndexForFunding,
} from "@opengeni/db";
import type { DocumentServices, EmbeddingProviderCompletionReceipt } from "@opengeni/documents";
import type { ControlActivityServices } from "./types";
import { Context } from "@temporalio/activity";

/** The configured monthly indexed-chunk limit, not a provider failure. */
export class KnowledgeIndexUsageLimitError extends Error {
  constructor() {
    super("monthly document indexing limit reached");
    this.name = "KnowledgeIndexUsageLimitError";
  }
}

export type KnowledgeIndexFailureStage = "embedding" | "processing";

/**
 * Content-free classification for a deferred Knowledge index batch. Only
 * protocol constants, an HTTP status, and a PostgreSQL SQLSTATE are retained;
 * provider messages, bodies, SQL, and identifiers never leave the process.
 * Outside the embedding call, only a PostgreSQL error in the cause chain is
 * attributed to the database; any other failure stays a worker failure.
 */
export function knowledgeIndexFailureDiagnostic(
  stage: KnowledgeIndexFailureStage,
  error: unknown,
): {
  errorClass: "KnowledgeIndexOperationError";
  errorCode:
    | "knowledge_index_usage_limit_reached"
    | "knowledge_index_embedding_failed"
    | "knowledge_index_persistence_failed"
    | "knowledge_index_failed";
  origin: "worker" | "db";
  status?: number;
  sqlState?: string;
} {
  if (error instanceof KnowledgeIndexUsageLimitError) {
    return {
      errorClass: "KnowledgeIndexOperationError",
      errorCode: "knowledge_index_usage_limit_reached",
      origin: "worker",
    };
  }
  if (stage === "embedding") {
    const status = ownValue(error, "status");
    return {
      errorClass: "KnowledgeIndexOperationError",
      errorCode: "knowledge_index_embedding_failed",
      origin: "worker",
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? { status }
        : {}),
    };
  }
  const postgres = postgresErrorState(error);
  if (!postgres) {
    return {
      errorClass: "KnowledgeIndexOperationError",
      errorCode: "knowledge_index_failed",
      origin: "worker",
    };
  }
  return {
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_persistence_failed",
    origin: "db",
    ...(postgres.sqlState ? { sqlState: postgres.sqlState } : {}),
  };
}

function ownValue(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** The nearest PostgreSQL error in a short cause chain, with its SQLSTATE
 * when that is a well-formed five-character code. */
function postgresErrorState(error: unknown): { sqlState?: string } | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (ownValue(current, "name") === "PostgresError") {
      const code = ownValue(current, "code");
      return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? { sqlState: code } : {};
    }
    current = ownValue(current, "cause");
  }
  return undefined;
}

export function createKnowledgeIndexingActivities(
  services: () => Promise<ControlActivityServices>,
  resolveDocumentServices?: () => Promise<DocumentServices>,
) {
  // Unpaid modes retain a conservative first-poll cutoff; paid mode uses the
  // operator's explicit timestamp so process restarts cannot change eligibility.
  let activationTime: Promise<Date> | undefined;
  return {
    executeKnowledgePreparation: async (input: KnowledgePreparationWorkflowRequest & { callId: string }) => {
      const { db, settings } = await services();
      if (!resolveDocumentServices) throw new Error("KNOWLEDGE_QUERY_PROVIDER_UNAVAILABLE");
      const documentServices = await resolveDocumentServices();
      const { workflowExecution, activityId } = Context.current().info;
      if (!workflowExecution || input.callId !== knowledgeQueryOperationId(input.context, input.operationId, "preparation") || workflowExecution.workflowId !== `knowledge-query:${input.callId}`)
        throw new Error("KNOWLEDGE_QUERY_EXECUTION_OWNER_CONFLICT");
      return prepareKnowledgeSave(db, input.context, input.request, () => documentServices.embedder, undefined, settings, {
        callId: input.callId, owner: { workflowId: workflowExecution.workflowId, workflowRunId: workflowExecution.runId, activityId },
        authorize: async tx => { const current = await services();
          await authorizeKnowledgeQueryOwner(tx, input, current.catalogSourceSettings ?? current.settings); },
      });
    },
    executeKnowledgeQuery: async (input: KnowledgeQueryWorkflowRequest & { callId: string }) => {
      const { db, settings } = await services();
      if (!resolveDocumentServices) throw new Error("KNOWLEDGE_QUERY_PROVIDER_UNAVAILABLE");
      const documentServices = await resolveDocumentServices();
      const { workflowExecution, activityId } = Context.current().info;
      if (!workflowExecution || input.callId !== knowledgeQueryOperationId(input.context, input.operationId) || workflowExecution.workflowId !== `knowledge-query:${input.callId}`)
        throw new Error("KNOWLEDGE_QUERY_EXECUTION_OWNER_CONFLICT");
      return searchKnowledgeEntries(db, input.context, input.request, () => documentServices.embedder, settings, {
        callId: input.callId,
        owner: { workflowId: workflowExecution.workflowId, workflowRunId: workflowExecution.runId, activityId },
        authorize: async tx => { const current = await services();
          await authorizeKnowledgeQueryOwner(tx, input, current.catalogSourceSettings ?? current.settings); },
      });
    },
    settleKnowledgeQueryUnknown: async (input: (KnowledgeQueryWorkflowRequest | KnowledgePreparationWorkflowRequest) & { callId: string; operationKind?: "query" | "preparation" }) => {
      const { db } = await services();
      if (isTransactionHandle(db)) throw new Error("KNOWLEDGE_QUERY_REQUIRES_ROOT_DATABASE");
      const { workflowExecution } = Context.current().info;
      if (!workflowExecution || input.callId !== knowledgeQueryOperationId(input.context, input.operationId, input.operationKind ?? "query") || workflowExecution.workflowId !== `knowledge-query:${input.callId}`)
        throw new Error("KNOWLEDGE_QUERY_EXECUTION_OWNER_CONFLICT");
      const scope = { accountId: input.context.accountId, workspaceId: input.context.workspaceId, callId: input.callId };
      const admission = await readKnowledgeQueryUsageFact(db, { ...scope, eventType: "knowledge.query.admitted" });
      const dispatch = await readKnowledgeQueryUsageFact(db, { ...scope, eventType: "knowledge.query.dispatched" });
      if (!dispatch) {
        await withKnowledgeQueryAccountLock(db, scope.accountId, scope.workspaceId, async tx => {
          // The permanent closure fences a late activity at admission and at
          // final dispatch; a Temporal timeout alone is not physical quiescence.
          if (await readKnowledgeQueryUsageFact(tx, { ...scope, eventType: "knowledge.query.dispatched" })) return;
          await recordUsageEvent(tx, { ...scope, eventType: "knowledge.query.closed", quantity: 1, unit: "call",
            sourceResourceType: "knowledge_query", sourceResourceId: scope.callId,
            idempotencyKey: `usage:knowledge.query.closed:query:${scope.callId}`,
            attributes: { ...(admission?.attributes ?? {
              schema: "opengeni.knowledge-query-source/v1",
              requestDigest: createHash("sha256").update(JSON.stringify(input.request)).digest("hex"),
              actorDigest: createHash("sha256").update(JSON.stringify(input.context.actor, Object.keys(input.context.actor).sort())).digest("hex"),
            }), settlement: "no_dispatch" } });
        });
        return;
      }
      const owner = dispatch.attributes.owner as Record<string, unknown> | null;
      if (!owner || owner.workflowId !== workflowExecution.workflowId || owner.workflowRunId !== workflowExecution.runId)
        throw new Error("KNOWLEDGE_QUERY_EXECUTION_OWNER_CONFLICT");
      const terminal = await readKnowledgeQueryUsageFact(db, { ...scope, eventType: "embedding.call" });
      if (terminal) {
        if (terminal.attributes.outcome !== "completed") return;
        await withKnowledgeQueryAccountLock(db, scope.accountId, scope.workspaceId, async tx => {
          if (await readKnowledgeQueryUsageFact(tx, { ...scope, eventType: "knowledge.query.closed" })) return;
          // A completed provider fact survives retrieval/debit rollback. The
          // same lock fences any late settlement before releasing its pressure.
          await recordUsageEvent(tx, { ...scope, eventType: "knowledge.query.closed", quantity: 1, unit: "call",
            sourceResourceType: "knowledge_query", sourceResourceId: scope.callId,
            idempotencyKey: `usage:knowledge.query.closed:query:${scope.callId}`,
            attributes: { ...admission?.attributes, settlement: "provider_completed_unsettled" } });
        });
        return;
      }
      if (!admission) throw new Error("KNOWLEDGE_QUERY_SOURCE_INVALID");
      const attributes = { ...admission.attributes, ...dispatch.attributes };
      if (!Number.isSafeInteger(attributes.inputBytes) || Number(attributes.inputBytes) < 0) throw new Error("KNOWLEDGE_QUERY_SOURCE_INVALID");
      await recordUsageEvent(db, { ...scope, eventType: "knowledge.query.indeterminate", quantity: 1, unit: "call",
        sourceResourceType: "knowledge_query", sourceResourceId: scope.callId,
        idempotencyKey: `usage:knowledge.query.indeterminate:query:${scope.callId}`, occurredAt: admission.occurredAt,
        attributes: { ...attributes, outcome: "indeterminate", inputTokens: null, estimatedProviderCostMicros: null, pricingSource: null } });
      // Unknown dispatch retains allowance/funding/ceiling pressure. A workflow
      // timeout cannot prove physical quiescence or reserve the immutable final
      // embedding.call key ahead of a late producer's known completion.
    },
    indexKnowledge: async () => {
      const result = { completed: 0, advanced: 0, deferred: 0, unavailable: 0 };
      if (!resolveDocumentServices) return result;
      const { db, settings, observability } = await services();
      if (isTransactionHandle(db)) throw new Error("KNOWLEDGE_EMBEDDING_REQUIRES_ROOT_DATABASE");
      let policyActivatedAt: Date;
      if (paidDocumentEmbedding(settings)) {
        if (!settings.documentEmbeddingCreditsActivatedAt)
          throw new Error("paid Knowledge embedding requires an activation cutoff");
        policyActivatedAt = new Date(settings.documentEmbeddingCreditsActivatedAt);
      } else {
        activationTime ??= knowledgeIndexBillingActivationTime(db).catch((error) => {
          activationTime = undefined;
          throw error;
        });
        policyActivatedAt = await activationTime;
      }
      const { embedder } = await resolveDocumentServices();
      const { knowledgeIndexChunks } = await import("@opengeni/documents");
      const claims = await claimKnowledgeIndexJobs(db, {
        model: embedder.model,
        dimensions: embedder.dimensions,
        limit: 2,
      });
      for (const claim of claims) {
        let stage: KnowledgeIndexFailureStage = "processing";
        const completedCalls: Promise<void>[] = [];
        const dispatchState: { fact: Parameters<typeof recordUsageEvent>[1] | null } = { fact: null };
        try {
          const source = await readKnowledgeIndexSource(db, claim);
          if (!source) {
            result.unavailable++;
            continue;
          }
          // The checkpoint, chunk/byte meters and post-use debit commit together. A new
          // generation requires funding once; committed batches may finish even
          // if their accumulated cost takes the balance below zero.
          const prepared = await withKnowledgeQueryAccountLock(db, claim.accountId, source.billingWorkspaceId, async (lockedDb) => {
            const current = await readKnowledgeIndexSource(lockedDb, claim);
            if (!current) {
              result.unavailable++;
              return;
            }
            const chunks = [];
            let more = false;
            for (const chunk of knowledgeIndexChunks(current.entry)) {
              if (chunk.index < current.nextIndex) continue;
              if (chunks.length === 32) {
                more = true;
                break;
              }
              chunks.push(chunk);
            }
            if (chunks.length) {
              const frozenPolicy = await freezeKnowledgeIndexBillingMode(
                lockedDb,
                claim,
                // Deterministic embeddings incur no provider charge; a valid
                // credits-mode config with zero tariff must still index them.
                // OpenAI shadow keeps its price snapshot for internal estimates.
                settings.documentEmbeddingProvider === "openai"
                  ? (settings.documentEmbeddingBillingMode ?? "usage_only")
                  : "usage_only",
                policyActivatedAt,
                settings.documentEmbeddingRateMicrosPerMillionBytes ?? 0,
              );
              if (frozenPolicy.mode === "awaiting_review") {
                result.deferred++;
                return;
              }
              if (frozenPolicy.mode === "obsolete") {
                result.unavailable++;
                return;
              }
              // An already-priced generation cannot become free when the
              // operator turns off paid embedding. Retain its checkpoint and
              // retry only after paid mode is restored; never call the provider
              // or append a batch that the live policy would not debit.
              if (frozenPolicy.mode === "credits" && !paidDocumentEmbedding(settings)) {
                await deferKnowledgeIndexJob(lockedDb, claim);
                result.deferred++;
                return;
              }
              const paid = frozenPolicy.mode === "credits";
              if (paid && claim.billingAttribution.kind === "unknown") {
                // Unknown legacy/source-preparation causality is not service.
                // Keep the checkpoint without making an uncountable paid call.
                observability.warn("Paid Knowledge indexing awaits initiating attribution", {
                  errorCode: "knowledge_index_attribution_unavailable",
                });
                await deferKnowledgeIndexJob(lockedDb, claim);
                result.deferred++;
                return;
              }
              if (paid && current.nextIndex === 0) {
                const balance = await getSpendableCreditBalance(lockedDb, claim.accountId);
                if (balance.balanceMicros <= 0) {
                  await waitKnowledgeIndexForFunding(lockedDb, claim);
                  result.deferred++;
                  return;
                }
              }
              if (paid) {
                const refusal = await checkWorkspaceAllowance(lockedDb, {
                  accountId: claim.accountId,
                  workspaceId: current.billingWorkspaceId,
                  subjectId:
                    claim.billingAttribution.kind === "turn" ||
                    claim.billingAttribution.kind === "human"
                      ? claim.billingAttribution.initiatingHumanSubjectId
                      : null,
                });
                if (refusal) {
                  await deferKnowledgeIndexJob(lockedDb, claim);
                  result.deferred++;
                  return;
                }
              }
              if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
                const limit =
                  configuredStaticUsageLimits(settings).maxDocumentIndexedChunksPerWorkspace;
                if (limit) {
                  const now = new Date();
                  const used = await sumUsageQuantity(lockedDb, {
                    workspaceId: current.billingWorkspaceId,
                    eventType: "document.indexed",
                    since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
                  });
                  if (used + chunks.length > limit) throw new KnowledgeIndexUsageLimitError();
                }
              }
              return { current, chunks, more, frozenPolicy, paid };
            }
            return { current, chunks, more, frozenPolicy: null, paid: false };
          });
          if (!prepared) continue;
          const { current, chunks, more, frozenPolicy, paid } = prepared;
          let vectors: number[][] = [];
          if (chunks.length) {
            if (!frozenPolicy) throw new Error("KNOWLEDGE_INDEX_POLICY_UNAVAILABLE");
            const inputs = chunks.map((chunk) => chunk.embeddingInput);
            const bytes = inputs.reduce(
              (sum, input) => sum + Buffer.byteLength(input, "utf8"),
              0,
            );
            // Every physical invocation has its own immutable identity. A
            // retry of an unpublished batch is another provider call, even
            // if its lease/checkpoint has not changed.
            const callId = crypto.randomUUID();
            const providerName = settings.documentEmbeddingProvider ?? "unspecified";
            const captureCompleted = async (receipt: EmbeddingProviderCompletionReceipt) => {
              if (receipt.callId !== callId || receipt.model !== claim.model || receipt.inputBytes !== bytes || receipt.inputItems !== chunks.length)
                throw new Error("KNOWLEDGE_INDEX_PROVIDER_CALL_ID_CONFLICT");
              // MAINT-P09-430: the completed provider call survives publication refusal
              // and rollback. This fact grants no source/publication authority.
              const fact: Parameters<typeof recordUsageEvent>[1] = {
                accountId: claim.accountId,
                workspaceId: current.billingWorkspaceId,
                occurredAt: new Date(receipt.completedAt),
                eventType: EMBEDDING_CALL_USAGE_EVENT_TYPE,
                quantity: 1,
                unit: "call",
                sourceResourceType: "knowledge_revision",
                sourceResourceId: claim.revisionId,
                idempotencyKey: `usage:${EMBEDDING_CALL_USAGE_EVENT_TYPE}:index:${claim.revisionId}:${claim.generation}:${current.nextIndex}:${receipt.callId}`,
                attributes: embeddingCallUsageAttributes({
                  callKind: "index",
                  provider: receipt.provider,
                  model: receipt.model,
                  inputBytes: receipt.inputBytes,
                  inputItems: receipt.inputItems,
                  rateMicrosPerMillionBytes: frozenPolicy.rateMicrosPerMillionBytes,
                  billingPath: paid ? "opengeni_credits" : "external",
                }),
              };
              const write = recordUsageEvent(db, fact).then(() => undefined);
              completedCalls.push(write);
              // Await the authoritative root write before SDK vector validation
              // and before any publication/settlement transaction can begin.
              await write;
            };
            const completionKey = `usage:${EMBEDDING_CALL_USAGE_EVENT_TYPE}:index:${claim.revisionId}:${claim.generation}:${current.nextIndex}:${callId}`;
            const dispatchFact: Parameters<typeof recordUsageEvent>[1] = {
              accountId: claim.accountId, workspaceId: current.billingWorkspaceId,
              eventType: "knowledge.index.dispatched", quantity: 1, unit: "call",
              sourceResourceType: "knowledge_revision", sourceResourceId: claim.revisionId,
              idempotencyKey: `usage:knowledge.index.dispatched:index:${callId}`,
              subjectId: claim.billingAttribution.kind === "turn" || claim.billingAttribution.kind === "human"
                ? claim.billingAttribution.initiatingHumanSubjectId : null,
              attributes: { schema: "opengeni.knowledge-index-dispatch/v1", callId, completionKey,
                providerReceipt: embeddingCallSourceAttributes({ callId, completionKey, callKind: "index", provider: providerName,
                  model: claim.model, inputBytes: bytes, inputItems: chunks.length,
                  rateMicrosPerMillionBytes: frozenPolicy.rateMicrosPerMillionBytes, billingPath: paid ? "opengeni_credits" : "external" }),
                generation: claim.generation, nextIndex: current.nextIndex, leaseId: claim.leaseId,
                provider: providerName, model: claim.model, inputBytes: bytes, inputItems: chunks.length,
                costBoundMicros: paid ? documentEmbeddingCostMicros({ ...settings, documentEmbeddingRateMicrosPerMillionBytes: frozenPolicy.rateMicrosPerMillionBytes }, bytes) : 0,
                billingPath: paid ? "opengeni_credits" : "external", outcome: "indeterminate",
                inputTokens: null, estimatedProviderCostMicros: null, pricingSource: null, priceVersion: null },
            };
            const beforeDispatch = async (receipt?: Omit<EmbeddingProviderCompletionReceipt, "completedAt"> & { dispatchedAt: string }) => {
              if (receipt && (receipt.callId !== callId || receipt.model !== claim.model || receipt.inputBytes !== bytes || receipt.inputItems !== chunks.length))
                throw new Error("KNOWLEDGE_INDEX_PROVIDER_DISPATCH_CONFLICT");
              await withKnowledgeQueryAccountLock(db, claim.accountId, current.billingWorkspaceId, async tx => {
                const latest = await readKnowledgeIndexSource(tx, claim);
                if (!latest || latest.nextIndex !== current.nextIndex || latest.billingWorkspaceId !== current.billingWorkspaceId)
                  throw new Error("KNOWLEDGE_INDEX_SOURCE_CHANGED");
                if (await hasIndeterminateKnowledgeIndexDispatch(tx, { accountId: claim.accountId,
                  workspaceId: current.billingWorkspaceId, revisionId: claim.revisionId,
                  generation: claim.generation, nextIndex: current.nextIndex, callId }))
                  throw new Error("KNOWLEDGE_INDEX_PROVIDER_OUTCOME_UNKNOWN");
                const subjectId = claim.billingAttribution.kind === "turn" || claim.billingAttribution.kind === "human"
                  ? claim.billingAttribution.initiatingHumanSubjectId : null;
                const pressure = await pendingKnowledgeQueryPressure(tx, { accountId: claim.accountId,
                  workspaceId: current.billingWorkspaceId, subjectId, excludeIndexCallId: callId });
                if (paid && current.nextIndex === 0 && (await getSpendableCreditBalance(tx, claim.accountId)).balanceMicros-pressure.micros<=0)
                  throw new Error("KNOWLEDGE_INDEX_FUNDING_CHANGED");
                if (paid && await checkWorkspaceAllowance(tx, { accountId: claim.accountId,
                  workspaceId: current.billingWorkspaceId, subjectId,
                  pendingWorkspaceMicros: pressure.workspaceMicros, pendingMemberMicros: pressure.memberMicros }))
                  throw new Error("KNOWLEDGE_INDEX_ALLOWANCE_CHANGED");
                if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
                  const limit = configuredStaticUsageLimits(settings).maxDocumentIndexedChunksPerWorkspace;
                  if (limit) {
                    const now = new Date();
                    const used = await sumUsageQuantity(tx, { workspaceId: current.billingWorkspaceId,
                      eventType: "document.indexed", since: new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)) });
                    if (used+pressure.indexedChunks+chunks.length>limit) throw new KnowledgeIndexUsageLimitError();
                  }
                }
                await recordUsageEvent(tx, dispatchFact);
              });
              dispatchState.fact = dispatchFact;
            };
            stage = "embedding";
            // Also protect compatible embedders that do not implement the SDK
            // dispatch hook; the installed SDK rechecks at its physical boundary.
            await beforeDispatch();
            vectors = await embedder.embedMany(inputs, captureCompleted, { callId, beforeDispatch });
            stage = "processing";
            if (completedCalls.length === 0)
              await captureCompleted({
                callId,
                provider: providerName,
                model: claim.model,
                inputBytes: bytes,
                inputItems: chunks.length,
                completedAt: new Date().toISOString(),
              });
            if (vectors.length !== chunks.length) throw new Error("Incomplete Knowledge embeddings");
          }
          // Re-enter only to settle the exact prepared lease/generation/checkpoint.
          // The provider never runs while a DB transaction or usage lock is held.
          await withKnowledgeQueryAccountLock(db, claim.accountId, current.billingWorkspaceId, async lockedDb => {
            const latest = await readKnowledgeIndexSource(lockedDb, claim);
            if (!latest || latest.nextIndex !== current.nextIndex || latest.billingWorkspaceId !== current.billingWorkspaceId) {
              result.unavailable++;
              return;
            }
            if (chunks.length) {
              if (!frozenPolicy) throw new Error("KNOWLEDGE_INDEX_POLICY_UNAVAILABLE");
              if (paid) {
                const refusal = await checkWorkspaceAllowance(lockedDb, {
                  accountId: claim.accountId, workspaceId: current.billingWorkspaceId,
                  subjectId: claim.billingAttribution.kind === "turn" || claim.billingAttribution.kind === "human"
                    ? claim.billingAttribution.initiatingHumanSubjectId : null,
                });
                if (refusal) {
                  await deferKnowledgeIndexJob(lockedDb, claim);
                  result.deferred++;
                  return;
                }
              }
              if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
                const limit = configuredStaticUsageLimits(settings).maxDocumentIndexedChunksPerWorkspace;
                if (limit) {
                  const now = new Date();
                  const used = await sumUsageQuantity(lockedDb, {
                    workspaceId: current.billingWorkspaceId, eventType: "document.indexed",
                    since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
                  });
                  if (used + chunks.length > limit) throw new KnowledgeIndexUsageLimitError();
                }
              }
              const inputs = chunks.map(chunk => chunk.embeddingInput);
              const bytes = inputs.reduce((sum, input) => sum + Buffer.byteLength(input, "utf8"), 0);
              // A reviewer may have rejected this revision during the provider
              // call. The DB guard holds its publication row through settlement.
              if (paid) {
                const publication = await guardPaidKnowledgeIndexPublication(lockedDb, claim);
                if (publication !== "published") {
                  if (publication === "obsolete") result.unavailable++;
                  else result.deferred++;
                  return;
                }
              }
              const appended = await appendKnowledgeIndexChunks(
                lockedDb,
                claim,
                current.nextIndex,
                chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index]! })),
              );
              if (appended.status !== "running") {
                result.unavailable++;
                return;
              }
              await recordUsageEvent(lockedDb, {
                accountId: claim.accountId,
                workspaceId: current.billingWorkspaceId,
                eventType: "document.indexed",
                quantity: chunks.length,
                unit: "chunk",
                sourceResourceType: "knowledge_revision",
                sourceResourceId: claim.revisionId,
                idempotencyKey: `knowledge.indexed:${claim.revisionId}:${claim.generation}:${current.nextIndex}`,
              });
              await recordUsageEvent(lockedDb, {
                accountId: claim.accountId,
                workspaceId: current.billingWorkspaceId,
                eventType: "document.embedding_bytes",
                quantity: bytes,
                unit: "byte",
                sourceResourceType: "knowledge_revision",
                sourceResourceId: claim.revisionId,
                idempotencyKey: `knowledge.embedding_bytes:${claim.revisionId}:${claim.generation}:${current.nextIndex}`,
              });
              if (frozenPolicy.mode === "shadow" && frozenPolicy.rateMicrosPerMillionBytes > 0) {
                const estimate = documentEmbeddingCostMicros(
                  {
                    ...settings,
                    documentEmbeddingRateMicrosPerMillionBytes:
                      frozenPolicy.rateMicrosPerMillionBytes,
                  },
                  bytes,
                );
                if (estimate > 0)
                  await recordUsageEvent(lockedDb, {
                    accountId: claim.accountId,
                    workspaceId: current.billingWorkspaceId,
                    eventType: "document.embedding_shadow_estimate",
                    quantity: estimate,
                    unit: "micro_usd",
                    sourceResourceType: "knowledge_revision",
                    sourceResourceId: claim.revisionId,
                    idempotencyKey: `knowledge.embedding_shadow:${claim.revisionId}:${claim.generation}:${current.nextIndex}`,
                  });
              }
              if (paid) {
                const cost = documentEmbeddingCostMicros(
                  {
                    ...settings,
                    documentEmbeddingRateMicrosPerMillionBytes:
                      frozenPolicy.rateMicrosPerMillionBytes,
                  },
                  bytes,
                );
                if (cost > 0)
                  await applyCreditDebitAfterUse(lockedDb, {
                    accountId: claim.accountId,
                    workspaceId: current.billingWorkspaceId,
                    type: "document_embedding_debit",
                    amountMicros: cost,
                    sourceType: "knowledge_revision",
                    sourceId: claim.revisionId,
                    idempotencyKey: `knowledge.embedding:${claim.revisionId}:${claim.generation}:${current.nextIndex}`,
                    metadata: {
                      ...creditDebitAttributionMetadata(claim.billingAttribution),
                      model: claim.model,
                      bytes,
                      chunks: chunks.length,
                      rateMicrosPerMillionBytes: frozenPolicy.rateMicrosPerMillionBytes,
                    },
                  });
              }
            }
            if (more) {
              await continueKnowledgeIndexJob(lockedDb, claim);
              result.advanced++;
            } else {
              const completed = await completeKnowledgeIndexJob(
                lockedDb,
                claim,
                current.nextIndex + chunks.length,
              );
              if (completed.status === "ready") result.completed++;
              else result.unavailable++;
            }
          });
        } catch (error) {
          if (dispatchState.fact && completedCalls.length === 0) await recordUsageEvent(db, {
            ...dispatchState.fact, eventType: "knowledge.index.indeterminate",
            idempotencyKey: dispatchState.fact.idempotencyKey.replace("knowledge.index.dispatched", "knowledge.index.indeterminate"),
          });
          // Provider failures retain the last completed projection. The durable
          // queue owns retry/backoff; do not retry an entire activity implicitly.
          // The stored reason stays the SQL lifecycle's fixed code; the log
          // carries the content-free class/code of the actual cause.
          observability.warn(
            "Knowledge indexing batch deferred",
            knowledgeIndexFailureDiagnostic(stage, error),
          );
          await deferKnowledgeIndexJob(db, claim).catch((deferError: unknown) => {
            const deferDiagnostic = knowledgeIndexFailureDiagnostic("processing", deferError);
            observability.warn("Knowledge indexing batch deferral failed", {
              ...deferDiagnostic,
              errorCode: "knowledge_index_defer_failed",
            });
          });
          result.deferred++;
        } finally {
          // Do not suppress a failed authoritative completion write. These are
          // the same already-awaited root writes, never another provider effect.
          await Promise.all(completedCalls);
        }
      }
      return result;
    },
  };
}
