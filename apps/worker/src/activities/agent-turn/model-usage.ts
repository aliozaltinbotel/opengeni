import { canonicalizeConfiguredModelId } from "@opengeni/config";
import { createHash } from "node:crypto";
import {
  applyCreditDebitUpToBalance,
  existingUsageEventIdempotencyKeys,
  isTransactionHandle,
  recordUsageEvent,
  recordModelCallFact,
  type AppendEventInput,
  type CanonicalTurnStartupMilestoneReceipt,
} from "@opengeni/db";
import {
  modelResponseServiceTierFromSdkEvent,
  modelTerminalResponseFromSdkEvent,
  normalizeModelCallUsage,
  type ModelResponseUsage,
  type ModelCallUsageInput,
  type ModelCallUsageNormalization,
} from "@opengeni/runtime";
import {
  calculateGatewayReportedCostBreakdown,
  calculateGatewayReportedProviderCostMicros,
  calculateModelListUsageCostSnapshot,
  calculateModelUsageCostBreakdown,
  configuredModelListPricingSchedules,
  configuredModels,
  configuredModelPricingSchedules,
  resolveModelProvider,
  responseSatisfiesLatencyMode,
  OPENGENI_GATEWAY_PROVIDER_ID,
  OPPER_PROVIDER_ID,
  ORGANIZATION_OPPER_PROVIDER_ID,
  WORKSPACE_GATEWAY_PROVIDER_ID,
  WORKSPACE_OPPER_PROVIDER_ID,
  WORKSPACE_GATEWAY_MODEL_ID_PREFIX,
  type ModelUsageInput,
  type ModelPricingScheduleV1,
  type ModelProviderApi,
  type Settings,
} from "@opengeni/config";
import { CODEX_PROVIDER_ID } from "@opengeni/codex";
import type { TurnActivityServices as ActivityServices } from "../types";
import {
  modelCallAccountContext,
  recordCreditMicros,
  recordModelCacheTokens,
  recordModelCreditsCharged,
  recordModelInputTokens,
  recordModelResponseUsage,
} from "../../observability-metrics";
import {
  MODEL_CALL_USAGE_ATTRIBUTES_SCHEMA,
  MODEL_CALL_USAGE_EVENT_TYPE,
  MODEL_CALL_DISPATCH_EVENT_TYPE,
  ModelCallUsageAttributes,
  type LatencyMode,
  type ModelContextContributionSummary,
  type SessionEvent,
} from "@opengeni/contracts";
import type { InsightsUsageClassMicros } from "@opengeni/contracts/insights-usage";
import { safeErrorDiagnostic } from "./errors";

export function modelUsageSourceKey(input: {
  responseId?: string | null | undefined;
  dispatchId: string | null;
  positionalKey: string;
}): string {
  if (input.responseId) {
    return input.responseId;
  }
  return input.dispatchId ? `${input.dispatchId}:${input.positionalKey}` : input.positionalKey;
}

/** Legacy aggregate usage may only debit a policy shared by its completed calls. */
export function aggregateCreditPolicyRevision(input: {
  responseRevisions: ReadonlySet<number | undefined>;
  lastAdmittedRevision: number | undefined;
  chargesOpenGeniCredits: boolean;
  totalTokens: number | null;
}): number | undefined {
  if (
    input.chargesOpenGeniCredits &&
    input.responseRevisions.size > 1 &&
    (input.totalTokens ?? 0) > 0
  ) {
    throw new Error("Aggregate model usage spans different credit policy revisions");
  }
  // Bind the completed response, even if later preparation changed admission.
  // Older runtimes without response callbacks retain their admitted snapshot.
  return input.responseRevisions.size === 1
    ? input.responseRevisions.values().next().value
    : input.lastAdmittedRevision;
}

export function providerContextTokens(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | null
    | undefined,
): number | null {
  const total = normalizeModelCallUsage(usage).totalTokens;
  return total !== null && total > 0 ? total : null;
}

/**
 * A provider call has already consumed tokens by the time its usage frame is
 * available. Losing the Codex credential lease at the renewal checkpoint must
 * stop the result from becoming authoritative, but it must not erase accounting
 * truth for the call that already happened. Meter first, then surface the lost
 * lease, then write attempt-owned token/context signals. A replaced attempt can
 * reject those signals without erasing the provider usage already incurred.
 */
export async function recordCompletedModelCallBeforeOwnershipFences(input: {
  renewLease: () => Promise<void>;
  recordUsage: () => Promise<void>;
  leaseLost: () => boolean;
  leaseLostMessage: string;
  recordAttemptSignals?: () => Promise<void>;
}): Promise<void> {
  await input.renewLease();
  await input.recordUsage();
  if (input.leaseLost()) {
    throw new Error(input.leaseLostMessage);
  }
  await input.recordAttemptSignals?.();
}

export type TurnEventPublisher = (
  events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>,
  immediate?: boolean,
) => Promise<{
  events: SessionEvent[];
  accepted: boolean;
  canonicalStartupMilestones: CanonicalTurnStartupMilestoneReceipt[];
}>;

export type ModelResponseEventState = {
  responseCount: number;
  contextSignal: { revision: number; totalTokens: number } | null;
  claimedSourceKeys: Set<string>;
  /** Source keys of terminal calls committed with unknown usage, in order. */
  unreportedSourceKeys: string[];
};

export type CompactionModelUsageEventState = {
  usageCount: number;
  claimedSourceKeys: Set<string>;
};

export function createModelResponseEventState(
  claimedSourceKeys: Set<string> = new Set<string>(),
): ModelResponseEventState {
  return {
    responseCount: 0,
    contextSignal: null,
    claimedSourceKeys,
    unreportedSourceKeys: [],
  };
}

export function createCompactionModelUsageEventState(
  claimedSourceKeys: Set<string> = new Set<string>(),
): CompactionModelUsageEventState {
  return { usageCount: 0, claimedSourceKeys };
}

export const createSessionTitleModelUsageEventState = createCompactionModelUsageEventState;

export function modelResponseContextSignal(
  state: ModelResponseEventState,
  responseCountBeforeStream = 0,
): { revision: number; totalTokens: number } | null {
  const signal = state.contextSignal;
  // A compaction retry creates a new SDK request counter, but usage identities
  // remain activity-wide. Never bind a pre-stream report to a reused request
  // ordinal; translate only this stream's reports without mutating usage state.
  if (!signal || signal.revision <= responseCountBeforeStream) return null;
  return {
    revision: signal.revision - responseCountBeforeStream,
    totalTokens: signal.totalTokens,
  };
}

export function assertModelResponseLatencyMode(input: {
  event: Parameters<typeof modelResponseServiceTierFromSdkEvent>[0];
  requested: LatencyMode;
  model: string;
  /** When set to Codex ChatGPT auth, response `service_tier` is not an honor signal. */
  providerId?: string;
}): void {
  if (input.requested === "standard") {
    return;
  }
  // ChatGPT-auth Codex (subscription): Fast maps to request `service_tier=priority`
  // (see openai/codex ServiceTier::Fast.request_value). The backend may still return
  // `response.service_tier=default`; OpenAI maintainers document that this does not
  // mean Fast was ignored. Native CLI also does not fail closed on that field.
  if (input.providerId === CODEX_PROVIDER_ID) {
    return;
  }
  const serviceTierEvent = modelResponseServiceTierFromSdkEvent(input.event);
  if (
    !serviceTierEvent ||
    (serviceTierEvent.source === "normalized" && serviceTierEvent.serviceTier === null)
  ) {
    return;
  }
  if (!responseSatisfiesLatencyMode(input.requested, serviceTierEvent.serviceTier)) {
    throw new Error(
      `Provider did not honor ${input.requested} latency mode for ${input.model}: response service_tier=${serviceTierEvent.serviceTier ?? "missing"}`,
    );
  }
}

/**
 * Process one SDK terminal-response event through the production authority path.
 *
 * The pinned Responses SDK mirrors one provider terminal response as both a
 * normalized `response_done` and a raw `model/response.completed` event. Claim
 * the stable response/source key before lease renewal or any side effect, and
 * use that one positional ordinal for both response identity and same-run
 * context binding. A response without usage still clears attempt-owned token
 * state. When usage exists, the durable `agent.model.usage` source-key fence
 * remains the cross-restart authority: a replay may retry the idempotent billing
 * write, but it cannot advance metrics, context, or attempt-owned signals.
 */
export async function processModelResponseTerminalEvent(input: {
  event: Parameters<typeof modelTerminalResponseFromSdkEvent>[0];
  state: ModelResponseEventState;
  nativeSourceKey?: (responseId:string|null,event:Parameters<typeof modelTerminalResponseFromSdkEvent>[0])=>string|undefined;
  dispatchId: string | null;
  settings: Settings;
  db: ActivityServices["db"];
  observability: ActivityServices["observability"];
  publish: TurnEventPublisher | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
  provider: string;
  providerApi: ModelProviderApi;
  model: string;
  latencyMode?: LatencyMode;
  metricProvider: string;
  externallyBilled: boolean;
  chargesOpenGeniCredits?: boolean;
  countsTowardTokenCap?: boolean;
  creditPolicyRevision?: number | undefined;
  servingCredentialId: string | null;
  priorSessionCredentialId: string | null;
  emittedSourceKeys: Set<string>;
  renewLease: () => Promise<void>;
  leaseLost: () => boolean;
  leaseLostMessage: string;
  setLastInputTokens: (tokens: number | null) => Promise<void>;
  contextContributions?: readonly ModelContextContributionSummary[] | null;
}): Promise<
  | { status: "not_response" }
  | { status: "duplicate"; sourceKey: string }
  | {
      status: "processed";
      sourceKey: string;
      authoritative: boolean;
      usageReported: boolean;
    }
> {
  const terminal = modelTerminalResponseFromSdkEvent(input.event);
  if (!terminal) {
    return { status: "not_response" };
  }
  // Some providers mirror a terminal response before normalized usage arrives.
  // Claiming that empty raw mirror would discard the SDK's billable response.
  if (
    !terminal.usage &&
    terminal.outcome === "completed" &&
    input.event.type === "raw_model_stream_event" &&
    input.event.data.type !== "response_done"
  ) {
    return { status: "not_response" };
  }

  const responseOrdinal = input.state.responseCount + 1;
  const nativeSourceKey=input.nativeSourceKey?.(terminal.responseId ?? null,input.event);
  if(input.nativeSourceKey && !nativeSourceKey) throw new Error("MODEL_SOURCE_RESPONSE_UNBOUND");
  const sourceKey = nativeSourceKey ?? modelUsageSourceKey({
    responseId: terminal.responseId,
    dispatchId: input.dispatchId,
    positionalKey: `response-${responseOrdinal}`,
  });
  if (input.state.claimedSourceKeys.has(sourceKey)) {
    return { status: "duplicate", sourceKey };
  }
  const responseUsage = terminal.usage;
  if (responseUsage) {
    input.state.claimedSourceKeys.add(sourceKey);
    input.state.responseCount = responseOrdinal;
  }

  const normalizedUsage = normalizeModelCallUsage(responseUsage?.usage);
  const accountContext = modelCallAccountContext({
    servingCredentialId: input.servingCredentialId,
    priorSessionCredentialId: input.priorSessionCredentialId,
    isFirstCallOfTurn: responseOrdinal === 1,
  });
  // Missing token usage does not erase the provider's terminal call fact.
  let authoritative = responseUsage === null;
  await recordCompletedModelCallBeforeOwnershipFences({
    renewLease: input.renewLease,
    leaseLost: input.leaseLost,
    leaseLostMessage: input.leaseLostMessage,
    recordUsage: async () => {
      if (!responseUsage) {
        await recordModelCallUsageEvent(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnAttemptId: input.turnAttemptId,
          sourceKey,
          callKind: "response",
          outcome: terminal.outcome,
          scope: "call",
          provider: input.provider,
          providerApi: input.providerApi,
          upstreamProvider: null,
          model: input.model,
          billingPath:
            (input.chargesOpenGeniCredits ?? !input.externallyBilled)
              ? "opengeni_credits"
              : "external",
          billing: null,
        });
        // Claim only after durability. A refused write remains retryable under
        // the exact source key; it must not look settled to this consumer.
        input.state.claimedSourceKeys.add(sourceKey);
        input.state.responseCount = responseOrdinal;
        input.state.unreportedSourceKeys.push(sourceKey);
        return;
      }
      const billing = await recordModelUsageAndDebitCredits(input.settings, input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        turnAttemptId: input.turnAttemptId,
        model: input.model,
        creditPolicyRevision: input.creditPolicyRevision,
        provider: input.provider,
        providerApi: input.providerApi,
        callKind: "response",
        outcome: terminal.outcome,
        externallyBilled: input.externallyBilled,
        ...(input.chargesOpenGeniCredits !== undefined
          ? { chargesOpenGeniCredits: input.chargesOpenGeniCredits }
          : {}),
        ...(input.countsTowardTokenCap !== undefined
          ? { countsTowardTokenCap: input.countsTowardTokenCap }
          : {}),
        usage: responseUsage.usage,
        normalizedUsage,
        gatewayBilling: responseUsage.gatewayBilling,
        sourceKey,
        ...(input.latencyMode ? { latencyMode: input.latencyMode } : {}),
        observability: input.observability,
        metricProvider: input.provider,
      });
      authoritative = await emitModelCallUsage({
        observability: input.observability,
        publish: input.publish,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        provider: input.provider,
        providerApi: input.providerApi,
        model: input.model,
        sourceKey,
        usage: responseUsage,
        normalizedUsage,
        ...(billing ? { billingPath: billing.billingPath } : {}),
        ...(billing ? { billingSnapshot: billing } : {}),
        ...(billing?.upstreamProvider ? { upstreamProvider: billing.upstreamProvider } : {}),
        servingAccountHash: accountContext.servingAccountHash,
        accountChangedFromPrevCall: accountContext.accountChangedFromPrevCall,
        emittedSourceKeys: input.emittedSourceKeys,
      });
      if (authoritative && billing) {
        await recordAuthoritativeModelCallFact({
          db: input.db,
          observability: input.observability,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnAttemptId: input.turnAttemptId,
          sourceKey,
          provider: input.provider,
          providerApi: input.providerApi,
          model: input.model,
          billing,
          ...(input.contextContributions !== undefined
            ? { contextContributions: input.contextContributions }
            : {}),
        });
        recordAuthoritativeModelUsageMetrics({
          observability: input.observability,
          settings: input.settings,
          provider: input.provider,
          model: input.model,
          externallyBilled: input.externallyBilled,
          billing,
        });
      }
      const observedInput = normalizedUsage.telemetry.inputTokens;
      if (authoritative && observedInput !== null && observedInput > 0) {
        recordModelInputTokens(input.observability, input.metricProvider, observedInput);
      }
    },
    recordAttemptSignals: async () => {
      if (!authoritative) return;
      const observedTotal = normalizedUsage.totalTokens;
      input.state.contextSignal =
        observedTotal !== null && observedTotal > 0
          ? { revision: responseOrdinal, totalTokens: observedTotal }
          : null;
      const observedInput = normalizedUsage.telemetry.inputTokens;
      await input.setLastInputTokens(
        observedInput !== null && observedInput > 0 ? observedInput : null,
      );
    },
  });
  return {
    status: "processed",
    sourceKey,
    authoritative,
    usageReported: responseUsage !== null,
  };
}

/**
 * Apply the same source-key authority ordering to the compaction summarizer's
 * usage callback. The summarizer can retry or mirror a terminal response just
 * like the main stream, so claim before lease renewal, billing, durable usage,
 * logging, or cache metrics. Durable source-key idempotency remains the
 * cross-process authority after a worker restart.
 */
export async function processCompactionModelUsageEvent(input: {
  usage: ModelResponseUsage | null;
  outcome?: ModelCallUsageAttributes["outcome"];
  nativeSourceKey?:string;
  state: CompactionModelUsageEventState;
  sourceKind?: "compaction" | "session-title";
  dispatchId: string | null;
  settings: Settings;
  db: ActivityServices["db"];
  observability: ActivityServices["observability"];
  publish: TurnEventPublisher | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
  provider: string;
  providerApi: ModelProviderApi;
  model: string;
  externallyBilled: boolean;
  chargesOpenGeniCredits?: boolean;
  countsTowardTokenCap?: boolean;
  creditPolicyRevision?: number | undefined;
  servingCredentialId: string | null;
  priorSessionCredentialId: string | null;
  emittedSourceKeys: Set<string>;
  renewLease: () => Promise<void>;
  leaseLost: () => boolean;
  leaseLostMessage: string;
  contextContributions?: readonly ModelContextContributionSummary[] | null;
}): Promise<
  | { status: "duplicate"; sourceKey: string }
  | { status: "processed"; sourceKey: string; authoritative: boolean }
> {
  if (input.usage === null) {
    const sourceKey = input.nativeSourceKey;
    if (!sourceKey) throw new Error("MODEL_SOURCE_RESPONSE_UNBOUND");
    if (input.state.claimedSourceKeys.has(sourceKey)) return { status: "duplicate", sourceKey };
    await recordCompletedModelCallBeforeOwnershipFences({
      renewLease: input.renewLease,
      leaseLost: input.leaseLost,
      leaseLostMessage: input.leaseLostMessage,
      recordUsage: async () => {
        await recordModelCallUsageEvent(input.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnAttemptId: input.turnAttemptId,
          sourceKey,
          callKind: input.sourceKind === "session-title" ? "session_title" : "compaction",
          outcome: input.outcome ?? "completed",
          scope: "call",
          provider: input.provider,
          providerApi: input.providerApi,
          upstreamProvider: null,
          model: input.model,
          billingPath: (input.chargesOpenGeniCredits ?? !input.externallyBilled)
            ? "opengeni_credits" : "external",
          billing: null,
        });
        input.state.claimedSourceKeys.add(sourceKey);
        input.state.usageCount += 1;
      },
    });
    return { status: "processed", sourceKey, authoritative: true };
  }
  const usage = input.usage;
  const usageOrdinal = input.state.usageCount + 1;
  const sourceKey = input.nativeSourceKey ?? modelUsageSourceKey({
    responseId: usage.responseId,
    dispatchId: input.dispatchId,
    positionalKey: `${input.sourceKind ?? "compaction"}-${usageOrdinal}`,
  });
  if (input.state.claimedSourceKeys.has(sourceKey)) {
    return { status: "duplicate", sourceKey };
  }
  input.state.claimedSourceKeys.add(sourceKey);
  input.state.usageCount = usageOrdinal;

  const accountContext = modelCallAccountContext({
    servingCredentialId: input.servingCredentialId,
    priorSessionCredentialId: input.priorSessionCredentialId,
    isFirstCallOfTurn: usageOrdinal === 1,
  });
  const normalizedUsage = normalizeModelCallUsage(usage.usage);
  let authoritative = false;
  await recordCompletedModelCallBeforeOwnershipFences({
    renewLease: input.renewLease,
    leaseLost: input.leaseLost,
    leaseLostMessage: input.leaseLostMessage,
    recordUsage: async () => {
      const billing = await recordModelUsageAndDebitCredits(input.settings, input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        turnAttemptId: input.turnAttemptId,
        model: input.model,
        creditPolicyRevision: input.creditPolicyRevision,
        provider: input.provider,
        providerApi: input.providerApi,
        callKind: input.sourceKind === "session-title" ? "session_title" : "compaction",
        outcome: usage.outcome ?? input.outcome ?? "completed",
        externallyBilled: input.externallyBilled,
        ...(input.chargesOpenGeniCredits !== undefined
          ? { chargesOpenGeniCredits: input.chargesOpenGeniCredits }
          : {}),
        ...(input.countsTowardTokenCap !== undefined
          ? { countsTowardTokenCap: input.countsTowardTokenCap }
          : {}),
        usage: usage.usage,
        normalizedUsage,
        gatewayBilling: usage.gatewayBilling,
        sourceKey,
        observability: input.observability,
        metricProvider: input.provider,
      });
      authoritative = await emitModelCallUsage({
        observability: input.observability,
        publish: input.publish,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        provider: input.provider,
        providerApi: input.providerApi,
        model: input.model,
        sourceKey,
        usage: usage,
        normalizedUsage,
        ...(billing ? { billingPath: billing.billingPath } : {}),
        ...(billing ? { billingSnapshot: billing } : {}),
        ...(billing?.upstreamProvider ? { upstreamProvider: billing.upstreamProvider } : {}),
        servingAccountHash: accountContext.servingAccountHash,
        accountChangedFromPrevCall: accountContext.accountChangedFromPrevCall,
        emittedSourceKeys: input.emittedSourceKeys,
      });
      if (authoritative && billing) {
        await recordAuthoritativeModelCallFact({
          db: input.db,
          observability: input.observability,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnAttemptId: input.turnAttemptId,
          sourceKey,
          provider: input.provider,
          providerApi: input.providerApi,
          model: input.model,
          billing,
          ...(input.contextContributions !== undefined
            ? { contextContributions: input.contextContributions }
            : {}),
        });
        recordAuthoritativeModelUsageMetrics({
          observability: input.observability,
          settings: input.settings,
          provider: input.provider,
          model: input.model,
          externallyBilled: input.externallyBilled,
          billing,
        });
      }
    },
  });
  return { status: "processed", sourceKey, authoritative };
}

export async function processSessionTitleModelUsageEvent(
  input: Omit<Parameters<typeof processCompactionModelUsageEvent>[0], "sourceKind">,
): ReturnType<typeof processCompactionModelUsageEvent> {
  return await processCompactionModelUsageEvent({
    ...input,
    sourceKind: "session-title",
  });
}

export async function emitModelCallUsage(input: {
  observability: ActivityServices["observability"];
  publish: TurnEventPublisher | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  provider: string;
  providerApi: ModelProviderApi;
  model: string;
  sourceKey: string;
  usage: ModelResponseUsage | { usage?: unknown | null } | null;
  normalizedUsage?: ModelCallUsageNormalization;
  /** Accepted billing authority persisted for Insights repair after a soft fact-write failure. */
  billingPath?: ModelUsageBillingRecord["billingPath"];
  /** Accepted comparisons are frozen with the event, not repriced during fact repair. */
  billingSnapshot?: Pick<
    ModelUsageBillingRecord,
    | "pricedCostMicros"
    | "estimatedProviderCostMicros"
    | "equivalentCreditCostMicros"
    | "pricingSource"
    | "listByClassMicros"
    | "listByClassApprox"
  >;
  /** Validated Gateway endpoint provider persisted for exact Insights repair. */
  upstreamProvider?: string;
  // Prompt-cache research dimensions (log-only; NEVER on a metric label or a
  // durable event). The opaque serving-account tag and whether it changed since
  // the session's previous call — the account-switch hypothesis for cache misses.
  servingAccountHash?: string;
  accountChangedFromPrevCall?: boolean;
  emittedSourceKeys?: Set<string>;
}): Promise<boolean> {
  const usage =
    input.usage && typeof input.usage === "object" && "usage" in input.usage
      ? (input.usage as { usage?: unknown }).usage
      : null;
  if (!usage || typeof usage !== "object") {
    return false;
  }
  if (input.emittedSourceKeys?.has(input.sourceKey)) return false;
  const normalizedUsage =
    input.normalizedUsage ?? normalizeModelCallUsage(usage as ModelCallUsageInput);
  const telemetry = normalizedUsage.telemetry;
  const appended = await input.publish?.(
    [
      {
        type: "agent.model.usage",
        payload: {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          provider: input.provider,
          providerApi: input.providerApi,
          model: input.model,
          sourceKey: input.sourceKey,
          ...(input.billingPath ? { billingPath: input.billingPath } : {}),
          ...(input.upstreamProvider ? { upstreamProvider: input.upstreamProvider } : {}),
          ...(input.billingSnapshot
            ? {
                pricedCostMicros: input.billingSnapshot.pricedCostMicros,
                estimatedProviderCostMicros: input.billingSnapshot.estimatedProviderCostMicros,
                equivalentCreditCostMicros: input.billingSnapshot.equivalentCreditCostMicros,
                pricingSource: input.billingSnapshot.pricingSource,
                listByClassMicros: input.billingSnapshot.listByClassMicros ?? null,
                listByClassApprox: input.billingSnapshot.listByClassApprox ?? false,
              }
            : {}),
          ...telemetry,
        },
      },
    ],
    true,
  );
  input.emittedSourceKeys?.add(input.sourceKey);
  const authoritative = appended?.events.some(
    (event) =>
      event.type === "agent.model.usage" &&
      event.turnAssociation === "current" &&
      event.payload !== null &&
      typeof event.payload === "object" &&
      (event.payload as Record<string, unknown>).sourceKey === input.sourceKey,
  );
  if (!authoritative) return false;
  try {
    input.observability.info("model call usage", {
      provider: input.provider,
      providerApi: input.providerApi,
      model: input.model,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      cachedTokens: telemetry.cachedTokens,
      cacheWriteTokens: telemetry.cacheWriteTokens,
      reasoningTokens: telemetry.reasoningTokens,
      ...(input.servingAccountHash !== undefined
        ? { servingAccountHash: input.servingAccountHash }
        : {}),
      ...(input.accountChangedFromPrevCall !== undefined
        ? { accountChangedFromPrevCall: input.accountChangedFromPrevCall }
        : {}),
    });
    if (normalizedUsage.rejectedFields.length > 0) {
      input.observability.warn("model call usage fields rejected", {
        provider: input.provider,
        providerApi: input.providerApi,
        model: input.model,
        rejectedFields: normalizedUsage.rejectedFields.join(","),
      });
    }
  } catch {
    // Durable event + billing already committed; logging is best-effort only.
  }
  try {
    applyCodexCacheTelemetry(input.observability, input.provider, normalizedUsage);
  } catch {
    // Durable event + billing already committed; metrics are best-effort only.
  }
  return true;
}

/**
 * Apply one authoritative, normalized model-call usage frame to the shared
 * prompt-cache metrics. The durable source-key fence in `emitModelCallUsage`
 * owns idempotency; this helper must never receive raw provider values.
 */
export function applyCodexCacheTelemetry(
  observability: ActivityServices["observability"],
  provider: string,
  normalizedUsage: ModelCallUsageNormalization,
): void {
  recordModelCacheTokens(observability, provider, {
    cachedTokens: normalizedUsage.telemetry.cachedTokens,
    cacheWriteTokens: normalizedUsage.telemetry.cacheWriteTokens,
    promptTokens: normalizedUsage.telemetry.inputTokens,
  });
}

export type ModelUsageBillingRecord = {
  billingPath: "opengeni_credits" | "external";
  /** Same quantity written to usage_events.model.cost when present; else 0. */
  pricedCostMicros: number;
  /** Hypothetical provider-rate USD micros; never an Opengeni charge. */
  estimatedProviderCostMicros: number | null;
  /** Hypothetical Opengeni credit price at the captured rate; never a debit. */
  equivalentCreditCostMicros: number | null;
  pricingSource: "configured_list_price" | "gateway_reported" | null;
  /** Forward-only provider list class snapshot; older facts/events stay unknown. */
  listByClassMicros?: InsightsUsageClassMicros | null;
  listByClassApprox?: boolean;
  normalizedUsage: ModelCallUsageNormalization;
  upstreamProvider?: string;
};

// Exported for unit testing the external-billing bypass; not part of the activity surface.
export async function recordModelUsageAndDebitCredits(
  settings: Settings,
  db: ActivityServices["db"],
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    turnAttemptId: string;
    model: string;
    /** The serving provider and API of the call; resolved from the model when omitted. */
    provider?: string;
    providerApi?: ModelProviderApi;
    /** What made the call; a per-response turn call unless named. */
    callKind?: ModelCallUsageAttributes["callKind"];
    outcome?: ModelCallUsageAttributes["outcome"];
    /** `aggregate` only for the stream fallback that stands for unreported calls. */
    scope?: ModelCallUsageAttributes["scope"];
    /**
     * False only when the usage frame evidences no provider call (the stream
     * fallback's default zero frame): the caller then records the call itself.
     */
    recordCall?: boolean;
    externallyBilled: boolean;
    chargesOpenGeniCredits?: boolean;
    countsTowardTokenCap?: boolean;
    creditPolicyRevision?: number | undefined;
    gatewayBilling?: ModelResponseUsage["gatewayBilling"];
    usage?: ModelUsageInput | ModelCallUsageInput | null;
    normalizedUsage?: ModelCallUsageNormalization;
    sourceKey: string;
    latencyMode?: LatencyMode;
    observability?: ActivityServices["observability"];
    /** Configured provider id for metric labels; never billing authority. */
    metricProvider?: string;
  },
): Promise<ModelUsageBillingRecord | null> {
  if (!input.usage) {
    return null;
  }
  const normalizedUsage = input.normalizedUsage ?? normalizeModelCallUsage(input.usage);
  const sanitizedUsage = sanitizedModelUsageInput(normalizedUsage);
  const inputTokens = sanitizedUsage.inputTokens ?? 0;
  const outputTokens = sanitizedUsage.outputTokens ?? 0;
  const totalTokens = sanitizedUsage.totalTokens ?? 0;
  const chargesOpenGeniCredits = input.chargesOpenGeniCredits ?? !input.externallyBilled;
  const countsTowardTokenCap = input.countsTowardTokenCap ?? !input.externallyBilled;
  const resolvedGatewayModel = input.gatewayBilling
    ? resolveModelProvider(settings, input.model)
    : undefined;
  const gatewayProviderId = resolvedGatewayModel?.provider.id;
  // Opper reports the exact USD cost of every response (`usage.opper.cost`);
  // the Chat adapter surfaces it with `finalProvider: "opper"`.
  const opperReported =
    (gatewayProviderId === OPPER_PROVIDER_ID ||
      gatewayProviderId === WORKSPACE_OPPER_PROVIDER_ID ||
      gatewayProviderId === ORGANIZATION_OPPER_PROVIDER_ID) &&
    input.gatewayBilling?.finalProvider === "opper";
  const gatewayBilling =
    gatewayProviderId === OPENGENI_GATEWAY_PROVIDER_ID ||
    gatewayProviderId === WORKSPACE_GATEWAY_PROVIDER_ID ||
    opperReported
      ? input.gatewayBilling
      : undefined;
  const allowedProviders = resolvedGatewayModel?.model.requestPolicy?.gateway.only;
  // Scoped Opper rails settle externally; record the exact provider cost only.
  const unpinnedWorkspaceGatewayModel =
    (gatewayProviderId === WORKSPACE_GATEWAY_PROVIDER_ID && allowedProviders === undefined) ||
    (opperReported && gatewayProviderId !== OPPER_PROVIDER_ID);
  if (gatewayBilling && !opperReported) {
    if (
      !unpinnedWorkspaceGatewayModel &&
      (!allowedProviders ||
        !(allowedProviders as readonly string[]).includes(gatewayBilling.finalProvider))
    ) {
      throw new Error(
        `AI Gateway reported unapproved provider ${gatewayBilling.finalProvider} for ${input.model}`,
      );
    }
    if (unpinnedWorkspaceGatewayModel && chargesOpenGeniCredits) {
      throw new Error(
        `Workspace Gateway custom model ${input.model} cannot charge Opengeni credits without pinned pricing`,
      );
    }
  }
  const pricingSchedules = configuredModelPricingSchedules(settings);
  const configuredPricingModel = pricingSchedules[input.model]
    ? input.model
    : input.model.startsWith("codex/") && pricingSchedules[input.model.slice("codex/".length)]
      ? input.model.slice("codex/".length)
      : null;
  const pricingBreakdown = gatewayBilling
    ? unpinnedWorkspaceGatewayModel
      ? {
          providerCostMicros: calculateGatewayReportedProviderCostMicros(
            gatewayBilling.inferenceCostUsd,
          ),
          creditCostMicros: 0,
        }
      : calculateGatewayReportedCostBreakdown(
          settings,
          configuredPricingModel ?? input.model,
          gatewayBilling.inferenceCostUsd,
          { inputTokens },
        )
    : configuredPricingModel
      ? calculateModelUsageCostBreakdown(settings, configuredPricingModel, sanitizedUsage, {
          latencyMode: input.latencyMode ?? "standard",
        })
      : null;
  const hasCompleteCoreTokenTelemetry =
    normalizedUsage.telemetry.inputTokens !== null &&
    normalizedUsage.telemetry.outputTokens !== null;
  // Comparison rates are deliberately separate from debit authority. The
  // current usage frame does not establish geography/service-tier provenance,
  // so forward class splits stay unknown even when a total estimate is priced.
  const listPricingSchedules = configuredModelListPricingSchedules(settings);
  const configuredListPricingModel = listPricingSchedules[input.model]
    ? input.model
    : input.model.startsWith("codex/") && listPricingSchedules[input.model.slice("codex/".length)]
      ? input.model.slice("codex/".length)
      : null;
  const listSnapshot =
    !gatewayBilling && hasCompleteCoreTokenTelemetry && configuredListPricingModel
      ? calculateModelListUsageCostSnapshot(settings, configuredListPricingModel, sanitizedUsage, {
          latencyMode: input.latencyMode ?? "standard",
          priceContextKnown: false,
        })
      : null;
  const listClasses = {
    listByClassMicros: listSnapshot?.listByClassMicros ?? null,
    listByClassApprox: listSnapshot?.listByClassApprox ?? false,
  };
  const estimatedProviderCostMicros = gatewayBilling
    ? (pricingBreakdown?.providerCostMicros ?? null)
    : hasCompleteCoreTokenTelemetry
      ? (listSnapshot?.providerCostMicros ?? pricingBreakdown?.providerCostMicros ?? null)
      : null;
  const equivalentCreditCostMicros =
    pricingBreakdown && !unpinnedWorkspaceGatewayModel
      ? gatewayBilling || hasCompleteCoreTokenTelemetry
        ? pricingBreakdown.creditCostMicros
        : null
      : null;
  const pricingSource = gatewayBilling
    ? ("gateway_reported" as const)
    : estimatedProviderCostMicros !== null
      ? ("configured_list_price" as const)
      : null;
  // MAINT-P09-430: the call's own authoritative per-call fact, on every billing
  // path and before anything else is recorded for it. Durable like
  // model.tokens: a refused write rejects (never a soft fail), and the
  // idempotency key makes a replay of the same call the same row.
  const resolvedCallProvider =
    input.provider === undefined || input.providerApi === undefined
      ? resolveModelProvider(settings, input.model)?.provider
      : undefined;
  // The schedule that produced the estimate, chosen exactly as the estimate is:
  // the list (comparison) schedule when its snapshot priced the call, else the
  // configured debit schedule.
  const estimateSchedule =
    pricingSource !== "configured_list_price"
      ? null
      : listSnapshot?.providerCostMicros != null && configuredListPricingModel
        ? (listPricingSchedules[configuredListPricingModel] ?? null)
        : configuredPricingModel
          ? (pricingSchedules[configuredPricingModel] ?? null)
          : null;
  if (input.recordCall !== false)
    await recordModelCallUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      sourceKey: input.sourceKey,
      callKind: input.callKind ?? "response",
      outcome: input.outcome ?? "completed",
      scope: input.scope ?? "call",
      provider: input.provider ?? resolvedCallProvider?.id ?? settings.openaiProvider ?? "openai",
      providerApi: input.providerApi ?? resolvedCallProvider?.api ?? "responses",
      upstreamProvider: gatewayBilling?.finalProvider ?? null,
      model: input.model,
      billingPath: chargesOpenGeniCredits ? "opengeni_credits" : "external",
      billing: {
        normalizedUsage,
        estimatedProviderCostMicros,
        pricingSource,
        priceVersion: estimateSchedule ? modelPricingScheduleVersion(estimateSchedule) : null,
      },
    });
  // Provider settlement and workspace-facing cost are separate. Externally
  // metered subscription/workspace turns remain exempt from the Opengeni token
  // cap, while a deployment-funded free model still records model.tokens. Every
  // non-credit path records a zero-cost marker and never consults pricing for a
  // debit.
  if (countsTowardTokenCap && totalTokens > 0) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.tokens",
      quantity: totalTokens,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      idempotencyKey: `usage:model.tokens:${input.turnId}:${input.sourceKey}`,
    });
  }
  if (!chargesOpenGeniCredits) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.cost",
      quantity: 0,
      unit: "usd_micros",
      sourceResourceType: "model_response",
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      idempotencyKey: `usage:model.cost:${input.turnId}:${input.sourceKey}`,
    });
    return {
      billingPath: "external",
      pricedCostMicros: 0,
      estimatedProviderCostMicros,
      equivalentCreditCostMicros,
      pricingSource,
      ...listClasses,
      normalizedUsage,
      ...(gatewayBilling ? { upstreamProvider: gatewayBilling.finalProvider } : {}),
    };
  }
  const shouldDebit = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  if (!shouldDebit || (totalTokens === 0 && !gatewayBilling)) {
    return {
      billingPath: "opengeni_credits",
      pricedCostMicros: 0,
      estimatedProviderCostMicros,
      equivalentCreditCostMicros,
      pricingSource,
      ...listClasses,
      normalizedUsage,
      ...(gatewayBilling ? { upstreamProvider: gatewayBilling.finalProvider } : {}),
    };
  }
  if (!pricingBreakdown) {
    throw new Error(`Missing model pricing for ${input.model}`);
  }
  const costMicros = pricingBreakdown.creditCostMicros;
  await recordUsageEvent(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: "model.cost",
    quantity: costMicros,
    unit: "usd_micros",
    sourceResourceType: "model_response",
    sourceResourceId: `${input.turnId}:${input.sourceKey}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    turnAttemptId: input.turnAttemptId,
    idempotencyKey: `usage:model.cost:${input.turnId}:${input.sourceKey}`,
  });
  if (costMicros > 0) {
    const result = await applyCreditDebitUpToBalance(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: "model_usage_debit",
      requestedAmountMicros: costMicros,
      modelId: canonicalizeConfiguredModelId(settings, input.model),
      creditPolicyRevision: input.creditPolicyRevision,
      sourceType: "model_response",
      sourceId: `${input.turnId}:${input.sourceKey}`,
      idempotencyKey: `credit:model_usage_debit:${input.turnId}:${input.sourceKey}`,
      metadata: {
        model: input.model,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sourceKey: input.sourceKey,
        latencyMode: input.latencyMode ?? "standard",
        inputTokens,
        outputTokens,
        totalTokens,
        // Additive: the prompt-cache slice of this call's input tokens, so the
        // per-call debit record carries cache efficiency alongside the token
        // counts. 0 when the provider did not report cached tokens.
        cachedTokens: normalizedUsage.telemetry.cachedTokens ?? 0,
        ...(gatewayBilling ? { gatewayProvider: gatewayBilling.finalProvider } : {}),
      },
    });
    recordCreditMicros(input.observability, "usage", result.debitedMicros);
    try {
      recordModelCreditsCharged(input.observability, {
        provider: input.metricProvider ?? "unknown",
        model: modelMetricProductId(settings, input.metricProvider, input.model),
        debitedMicros: result.debitedMicros,
        grantDebitedMicros: result.grantDebitedMicros,
      });
    } catch {
      // The debit is committed; metrics are best-effort only.
    }
  }
  return {
    billingPath: "opengeni_credits",
    pricedCostMicros: costMicros,
    estimatedProviderCostMicros,
    equivalentCreditCostMicros,
    pricingSource,
    ...listClasses,
    normalizedUsage,
    ...(gatewayBilling ? { upstreamProvider: gatewayBilling.finalProvider } : {}),
  };
}

const modelMetricProductIds = new WeakMap<Settings, Map<string, string>>();

/**
 * The bounded `model` metric label: the deployment catalog product id for a
 * catalog model, or `custom` for a workspace-owned model (workspace gateway or
 * a customer-key provider) and for anything the deployment catalog does not
 * list. Metrics only; never billing or routing authority.
 */
export function modelMetricProductId(
  settings: Settings,
  provider: string | undefined,
  model: string,
): string {
  if (provider?.startsWith("workspace-") || model.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX)) {
    return "custom";
  }
  let cache = modelMetricProductIds.get(settings);
  if (!cache) {
    cache = new Map();
    modelMetricProductIds.set(settings, cache);
  }
  const cached = cache.get(model);
  if (cached !== undefined) return cached;
  let label = "custom";
  try {
    const canonical = canonicalizeConfiguredModelId(settings, model);
    if (configuredModels(settings).some((candidate) => candidate.id === canonical)) {
      label = canonical;
    }
  } catch {
    // An unreadable catalog leaves the call labelled `custom`.
  }
  if (cache.size < 256) cache.set(model, label);
  return label;
}

/**
 * Per-model usage and estimated provider cost for one authoritative response.
 * Call only after the durable usage event was accepted as current (the same
 * fence as the Insights fact). Best-effort: never throws.
 */
export function recordAuthoritativeModelUsageMetrics(input: {
  observability: ActivityServices["observability"];
  settings: Settings;
  provider: string;
  model: string;
  externallyBilled: boolean;
  billing: ModelUsageBillingRecord;
}): void {
  try {
    const telemetry = input.billing.normalizedUsage.telemetry;
    recordModelResponseUsage(input.observability, {
      provider: input.provider,
      model: modelMetricProductId(input.settings, input.provider, input.model),
      payer: input.externallyBilled ? "external" : "deployment",
      tokens: telemetry,
      estimatedProviderCostMicros: input.billing.estimatedProviderCostMicros,
      pricingSource: input.billing.pricingSource,
    });
  } catch {
    // Durable event + billing already committed; metrics are best-effort only.
  }
}

/** Soft-fail Insights fact write — never throws into the billing/emit path. */
export async function recordAuthoritativeModelCallFact(input: {
  db: ActivityServices["db"];
  observability: ActivityServices["observability"];
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
  sourceKey: string;
  provider: string;
  providerApi: ModelProviderApi;
  model: string;
  billing: ModelUsageBillingRecord;
  contextContributions?: readonly ModelContextContributionSummary[] | null;
}): Promise<void> {
  try {
    const telemetry = input.billing.normalizedUsage.telemetry;
    await recordModelCallFact(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      sourceKey: input.sourceKey,
      provider: input.billing.upstreamProvider ?? input.provider,
      providerApi: input.providerApi,
      model: input.model,
      billingPath: input.billing.billingPath,
      pricedCostMicros: input.billing.pricedCostMicros,
      estimatedProviderCostMicros: input.billing.estimatedProviderCostMicros,
      equivalentCreditCostMicros: input.billing.equivalentCreditCostMicros,
      pricingSource: input.billing.pricingSource,
      listByClassMicros: input.billing.listByClassMicros ?? null,
      listByClassApprox: input.billing.listByClassApprox ?? false,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      cachedTokens: telemetry.cachedTokens,
      cacheWriteTokens: telemetry.cacheWriteTokens,
      reasoningTokens: telemetry.reasoningTokens,
      totalTokens: input.billing.normalizedUsage.totalTokens,
      ...(input.contextContributions !== undefined
        ? { contextContributions: input.contextContributions }
        : {}),
    });
  } catch (error) {
    input.observability.warn("model call fact persist failed", {
      ...safeErrorDiagnostic(error),
    });
  }
}

/** Key-sorted JSON: the canonical text a pricing schedule's identity is taken over. */
function canonicalScheduleJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalScheduleJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalScheduleJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The identity of the configured price schedule a `configured_list_price`
 * estimate used: sha256 over the schedule's key-sorted JSON. Any change to a
 * rate, a tier or the margin yields a new version.
 */
export function modelPricingScheduleVersion(schedule: ModelPricingScheduleV1): string {
  return `schedule-sha256:${createHash("sha256").update(canonicalScheduleJson(schedule)).digest("hex")}`;
}

/**
 * Write the authoritative per-call `model.call` usage row (MAINT-P09-430).
 *
 * One row per provider call, idempotent on `usage:model.call:{turnId}:{sourceKey}`
 * (the same source key model.tokens/model.cost use), quantity 1, unit `call`.
 * `billing: null` records a call whose usage the provider never reported: every
 * token pool and the cost are null, never 0. The attributes are validated
 * against the published contract before the write, so a malformed fact fails
 * here rather than on the host export.
 */
export async function recordModelCallUsageEvent(
  db: ActivityServices["db"],
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    turnAttemptId: string;
    sourceKey: string;
    callKind: ModelCallUsageAttributes["callKind"];
    outcome?: ModelCallUsageAttributes["outcome"];
    stage?: "dispatch" | "terminal";
    scope: ModelCallUsageAttributes["scope"];
    provider: string;
    providerApi: string;
    upstreamProvider: string | null;
    model: string;
    billingPath: ModelCallUsageAttributes["billingPath"];
    billing: {
      normalizedUsage: ModelCallUsageNormalization;
      estimatedProviderCostMicros: number | null;
      pricingSource: ModelCallUsageAttributes["pricingSource"];
      priceVersion: string | null;
    } | null;
  },
): Promise<void> {
  const eventType = input.stage === "dispatch" ? MODEL_CALL_DISPATCH_EVENT_TYPE : MODEL_CALL_USAGE_EVENT_TYPE;
  const telemetry = input.billing?.normalizedUsage.telemetry ?? null;
  const attributes = ModelCallUsageAttributes.parse({
    schema: MODEL_CALL_USAGE_ATTRIBUTES_SCHEMA,
    callKind: input.callKind,
    scope: input.scope,
    sourceKey: input.sourceKey,
    provider: input.provider,
    providerApi: input.providerApi,
    upstreamProvider: input.upstreamProvider,
    model: input.model,
    outcome: input.outcome ?? "completed",
    usageReported: input.billing !== null,
    inputTokens: telemetry?.inputTokens ?? null,
    outputTokens: telemetry?.outputTokens ?? null,
    cachedTokens: telemetry?.cachedTokens ?? null,
    cacheWriteTokens: telemetry?.cacheWriteTokens ?? null,
    reasoningTokens: telemetry?.reasoningTokens ?? null,
    totalTokens: input.billing?.normalizedUsage.totalTokens ?? null,
    estimatedProviderCostMicros: input.billing?.estimatedProviderCostMicros ?? null,
    pricingSource: input.billing?.pricingSource ?? null,
    priceVersion: input.billing?.priceVersion ?? null,
    billingPath: input.billingPath,
  });
  await recordUsageEvent(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType,
    quantity: 1,
    unit: "call",
    sourceResourceType: input.stage === "dispatch" ? "model_dispatch" : "model_response",
    sourceResourceId: `${input.turnId}:${input.sourceKey}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    turnAttemptId: input.turnAttemptId,
    idempotencyKey: `usage:${eventType}:${input.turnId}:${input.sourceKey}`,
    attributes,
  });
}

/** One installed usage producer for literal transport admission and failure.
 * Intent is durable outside a transaction before bytes; it never bills.
 * A failed transport has unknown provider effect, so its call is indeterminate.
 */
export function createModelCallUsageSourceHooks(
  db: ActivityServices["db"],
  call: Omit<Parameters<typeof recordModelCallUsageEvent>[1], "sourceKey" | "billing" | "outcome" | "stage">,
  claimedSourceKeys: Set<string>,
  authorize?: (sourceKey: string) => Promise<void>,
): Pick<import("@opengeni/runtime").BeforeModelCallSourceReceipt, "beforeProviderDispatch" | "onDispatchFailure"> {
  const assertRoot = () => { if (isTransactionHandle(db)) throw new Error("MODEL_CALL_DISPATCH_REQUIRES_ROOT_DATABASE"); };
  return {
    beforeProviderDispatch: async sourceKey => {
      assertRoot();
      await authorize?.(sourceKey);
      await recordModelCallUsageEvent(db, { ...call, sourceKey, stage: "dispatch", outcome: "indeterminate", billing: null });
      // Persistence may have waited: recheck the current source authority at
      // the final literal boundary, outside the intent transaction.
      await authorize?.(sourceKey);
    },
    onDispatchFailure: async sourceKey => {
      assertRoot();
      if (claimedSourceKeys.has(sourceKey)) return;
      const dispatchKey = `usage:${MODEL_CALL_DISPATCH_EVENT_TYPE}:${call.turnId}:${sourceKey}`;
      const terminalKey = `usage:${MODEL_CALL_USAGE_EVENT_TYPE}:${call.turnId}:${sourceKey}`;
      const existing = await existingUsageEventIdempotencyKeys(db, {
        accountId: call.accountId, workspaceId: call.workspaceId, keys: [dispatchKey, terminalKey],
      });
      if (!existing.has(dispatchKey) || existing.has(terminalKey)) return;
      await recordModelCallUsageEvent(db, { ...call, sourceKey, outcome: "indeterminate", billing: null });
      claimedSourceKeys.add(sourceKey);
    },
  };
}

/**
 * Settle the terminal responses of one stream that reported no usage, once the
 * stream knows how they are covered: when no response of the stream reported
 * usage, the aggregate fallback row stands for all of them and nothing is
 * written here; otherwise each is recorded as its own unknown call (null usage,
 * null cost) so a partially reported stream never silently drops a call.
 */
export async function recordUnreportedModelCalls(
  db: ActivityServices["db"],
  input: Omit<
    Parameters<typeof recordModelCallUsageEvent>[1],
    "sourceKey" | "scope" | "billing"
  > & {
    sourceKeys: readonly string[];
    coveredByAggregate: boolean;
  },
): Promise<number> {
  if (input.coveredByAggregate) return 0;
  const { sourceKeys, coveredByAggregate: _covered, ...call } = input;
  for (const sourceKey of sourceKeys) {
    await recordModelCallUsageEvent(db, { ...call, sourceKey, scope: "call", billing: null });
  }
  return sourceKeys.length;
}

export function sanitizedModelUsageInput(normalized: ModelCallUsageNormalization): ModelUsageInput {
  return {
    ...(normalized.telemetry.inputTokens !== null
      ? { inputTokens: normalized.telemetry.inputTokens }
      : {}),
    ...(normalized.telemetry.outputTokens !== null
      ? { outputTokens: normalized.telemetry.outputTokens }
      : {}),
    ...(normalized.totalTokens !== null ? { totalTokens: normalized.totalTokens } : {}),
    ...(normalized.telemetry.cachedTokens !== null ||
    normalized.telemetry.cacheWriteTokens !== null ||
    normalized.cacheWriteTokensByTtl !== undefined
      ? {
          inputTokensDetails: {
            ...(normalized.telemetry.cachedTokens === null
              ? {}
              : { cached_tokens: normalized.telemetry.cachedTokens }),
            ...(normalized.telemetry.cacheWriteTokens === null
              ? {}
              : { cache_write_tokens: normalized.telemetry.cacheWriteTokens }),
            ...(normalized.cacheWriteTokensByTtl?.fiveMinute == null
              ? {}
              : { cache_write_tokens_5m: normalized.cacheWriteTokensByTtl.fiveMinute }),
            ...(normalized.cacheWriteTokensByTtl?.oneHour == null
              ? {}
              : { cache_write_tokens_1h: normalized.cacheWriteTokensByTtl.oneHour }),
          },
        }
      : {}),
    ...(normalized.requestUsageEntries
      ? { requestUsageEntries: normalized.requestUsageEntries }
      : {}),
  };
}

export function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
