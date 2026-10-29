import { canonicalizeConfiguredModelId, resolveModelProvider } from "@opengeni/config";
import { createHash } from "node:crypto";
import {
  parsePromptCacheObservation,
  type PromptCacheObservation,
  type PromptCacheRequestFingerprint,
} from "@opengeni/contracts";
import {
  existingUsageEventIdempotencyKeys,
  isTransactionHandle,
  recordUsageEvent,
  isStoredVerbatimAsLosslessJsonString,
  recordModelCallFact,
  type AppendEventInput,
  type CanonicalTurnStartupMilestoneReceipt,
  type ModelCallTiming,
  type SessionEventMutation,
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
  configuredModels,
  responseSatisfiesLatencyMode,
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
  recordPromptCacheDiagnostics,
  recordModelResponseUsage,
} from "../../observability-metrics";
import {
  MODEL_CALL_USAGE_ATTRIBUTES_SCHEMA,
  MODEL_CALL_USAGE_EVENT_TYPE,
  MODEL_CALL_DISPATCH_EVENT_TYPE,
  MODEL_CALL_DISPATCH_REFUSED_EVENT_TYPE,
  ModelCallUsageAttributes,
  type LatencyMode,
  type ModelContextContributionSummary,
  type SessionEvent,
} from "@opengeni/contracts";
import { safeErrorDiagnostic } from "./errors";
import {
  holdSessionUsageReceipt,
  releaseHeldSessionUsageReceiptMeteredByEvent,
} from "./session-usage-custody";
import {
  sanitizedModelUsageInput,
  sessionUsageMeterAmountMicros,
  settleModelUsage,
  type ModelUsageBillingRecord,
} from "@opengeni/core";

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
  mutate?: SessionEventMutation<"event">,
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

/**
 * Why the worker made a model call. The durable `agent.model.usage` payload
 * records it so a reader can tell the turn's own inference (`main`, including
 * the aggregate billing fallback) from the auxiliary context summarizer and
 * session-title calls. Only the worker sets it, at the call site; it changes no
 * source key, billing, credit, idempotency or metric label.
 */
export type ModelCallPurpose = "main" | "compaction" | "session-title";

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
  /** The shared-core subscription connection that served the call (billing attribution). */
  subscriptionConnectionId?: string | null;
  emittedSourceKeys: Set<string>;
  renewLease: () => Promise<void>;
  leaseLost: () => boolean;
  leaseLostMessage: string;
  setLastInputTokens: (tokens: number | null) => Promise<void>;
  contextContributions?: readonly ModelContextContributionSummary[] | null;
  /** Timing of the call this terminal response completes; read once per claimed response. */
  responseTiming?: () => ModelCallTiming | null;
  /** Wire fingerprint of the request this response completes; read once per claimed response. */
  promptCacheRequest?: () => Promise<PromptCacheRequestFingerprint | null> | null;
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
  if (terminal.outcome === "indeterminate") {
    await recordModelCallUsageEvent(input.db, { ...input, sourceKey, callKind: "response", scope: "call",
      outcome: "indeterminate", stage: "dispatch", upstreamProvider: null, billing: null,
      billingPath: (input.chargesOpenGeniCredits ?? !input.externallyBilled) ? "opengeni_credits" : "external" });
    return { status: "processed", sourceKey, authoritative: false, usageReported: false };
  }
  const timing = input.responseTiming?.() ?? null;
  const promptCacheRequest = input.promptCacheRequest?.() ?? null;

  const responseUsage = terminal.usage;

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
      input.state.claimedSourceKeys.add(sourceKey);
      input.state.responseCount = responseOrdinal;
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
        purpose: "main",
        sourceKey,
        usage: responseUsage,
        normalizedUsage,
        ...(billing ? { billingPath: billing.billingPath } : {}),
        ...(billing ? { billingSnapshot: billing } : {}),
        ...(billing?.upstreamProvider ? { upstreamProvider: billing.upstreamProvider } : {}),
        servingAccountHash: accountContext.servingAccountHash,
        accountChangedFromPrevCall: accountContext.accountChangedFromPrevCall,
        emittedSourceKeys: input.emittedSourceKeys,
        timing,
      });
      if (authoritative && billing) {
        await recordAuthoritativeModelCallFact({
          timing,
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
          subscriptionConnectionId: input.subscriptionConnectionId ?? null,
          ...(input.contextContributions !== undefined
            ? { contextContributions: input.contextContributions }
            : {}),
          promptCache: await promptCacheObservation(responseUsage, promptCacheRequest),
        });
        recordAuthoritativeModelUsageMetrics({
          observability: input.observability,
          settings: input.settings,
          provider: input.provider,
          model: input.model,
          externallyBilled: input.externallyBilled,
          billing,
          webSearchRequests: responseUsage?.webSearchRequests,
        });
      }
      const observedInput = normalizedUsage.telemetry.inputTokens;
      if (authoritative && observedInput !== null && observedInput > 0) {
        recordModelInputTokens(input.observability, input.metricProvider, observedInput);
      }
    },
    recordAttemptSignals: async () => {
      if (!authoritative) return;
      // Context is what the last request sent, not the sum of a response that
      // took several requests (each re-sends the whole prefix).
      const finalRequest = normalizedUsage.requestUsageEntries?.at(-1);
      const observedTotal = finalRequest?.totalTokens ?? normalizedUsage.totalTokens;
      input.state.contextSignal =
        observedTotal !== null && observedTotal > 0
          ? { revision: responseOrdinal, totalTokens: observedTotal }
          : null;
      const observedInput = finalRequest?.inputTokens ?? normalizedUsage.telemetry.inputTokens;
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
  sourceKind?: Exclude<ModelCallPurpose, "main">;
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
  /** The shared-core subscription connection that served the call (billing attribution). */
  subscriptionConnectionId?: string | null;
  emittedSourceKeys: Set<string>;
  renewLease: () => Promise<void>;
  leaseLost: () => boolean;
  leaseLostMessage: string;
  contextContributions?: readonly ModelContextContributionSummary[] | null;
  /** Wire fingerprint of the compaction request this usage belongs to. */
  promptCacheRequest?: () => Promise<PromptCacheRequestFingerprint | null> | null;
}): Promise<
  | { status: "duplicate"; sourceKey: string }
  | { status: "processed"; sourceKey: string; authoritative: boolean }
> {
  if ((input.usage?.outcome ?? input.outcome) === "indeterminate") {
    const sourceKey = input.nativeSourceKey;
    if (!sourceKey) throw new Error("MODEL_SOURCE_RESPONSE_UNBOUND");
    await recordModelCallUsageEvent(input.db, { ...input, sourceKey,
      callKind: input.sourceKind === "session-title" ? "session_title" : "compaction", scope: "call",
      outcome: "indeterminate", stage: "dispatch", upstreamProvider: null, billing: null,
      billingPath: (input.chargesOpenGeniCredits ?? !input.externallyBilled) ? "opengeni_credits" : "external" });
    return { status: "processed", sourceKey, authoritative: false };
  }
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
  const purpose = input.sourceKind ?? "compaction";
  const usageOrdinal = input.state.usageCount + 1;
  const sourceKey = input.nativeSourceKey ?? modelUsageSourceKey({
    responseId: usage.responseId,
    dispatchId: input.dispatchId,
    positionalKey: `${purpose}-${usageOrdinal}`,
  });
  if (input.state.claimedSourceKeys.has(sourceKey)) {
    return { status: "duplicate", sourceKey };
  }
  input.state.claimedSourceKeys.add(sourceKey);
  input.state.usageCount = usageOrdinal;
  const promptCacheRequest = input.promptCacheRequest?.() ?? null;

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
        purpose,
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
          subscriptionConnectionId: input.subscriptionConnectionId ?? null,
          ...(input.contextContributions !== undefined
            ? { contextContributions: input.contextContributions }
            : {}),
          promptCache: await promptCacheObservation(input.usage, promptCacheRequest),
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

/** What the call itself reported plus the wire fingerprint of its request. */
async function promptCacheObservation(
  usage: ModelResponseUsage | null,
  request: Promise<PromptCacheRequestFingerprint | null> | null,
): Promise<PromptCacheObservation | null> {
  const fingerprint = request ? await request.catch(() => null) : null;
  return parsePromptCacheObservation({
    ...(usage?.thinkingBlocksDropped ? { thinkingBlocksDropped: usage.thinkingBlocksDropped } : {}),
    ...(fingerprint ? { request: fingerprint } : {}),
  });
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
  /** Why the worker made this call; durable event and log line only, never a metric label. */
  purpose: ModelCallPurpose;
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
  /** Worker-measured call timing, stored with the event for Insights repair. */
  timing?: ModelCallTiming | null;
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
          purpose: input.purpose,
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
          ...(input.timing ? { timing: input.timing } : {}),
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
  releaseReceiptMeteredByCommittedEvent(input, telemetry);
  try {
    input.observability.info("model call usage", {
      provider: input.provider,
      providerApi: input.providerApi,
      model: input.model,
      purpose: input.purpose,
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

const METERED_PRICING_SOURCES = new Set(["configured_list_price", "gateway_reported"]);
const MAX_METERED_SOURCE_KEY_BYTES = 1024;

/**
 * The committed `agent.model.usage` event metered this call's task usage in
 * its own transaction (the database trigger applies `<turnId>:<sourceKey>`
 * with the payload's amount; a failure would have rolled the event back).
 * Drop a held receipt for that identity when the event carried exactly its
 * amount, mirroring the trigger's acceptance rules conservatively: anything
 * the trigger might value differently keeps the hold for the direct write.
 * A source key the lossless codec stores encoded (NUL, a lone surrogate, the
 * codec prefix) reaches the trigger as a different string and identity, so it
 * never counts as metered here: the hold stays and fails closed.
 */
function releaseReceiptMeteredByCommittedEvent(
  input: {
    sessionId: string;
    turnId: string;
    sourceKey: string;
    billingSnapshot?: Pick<
      ModelUsageBillingRecord,
      "estimatedProviderCostMicros" | "pricingSource"
    >;
  },
  telemetry: { inputTokens?: number | null; outputTokens?: number | null },
): void {
  if (!isStoredVerbatimAsLosslessJsonString(input.sourceKey)) return;
  const keyBytes = new TextEncoder().encode(input.sourceKey).byteLength;
  if (keyBytes < 1 || keyBytes > MAX_METERED_SOURCE_KEY_BYTES) return;
  const estimated = input.billingSnapshot?.estimatedProviderCostMicros ?? null;
  const pricingSource = input.billingSnapshot?.pricingSource ?? null;
  const tokens = (value: number | null | undefined) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < 1e15
      ? value
      : null;
  const eventAmount =
    estimated !== null &&
    Number.isSafeInteger(estimated) &&
    estimated >= 0 &&
    estimated < 1e16 &&
    pricingSource !== null &&
    METERED_PRICING_SOURCES.has(pricingSource)
      ? sessionUsageMeterAmountMicros({
          estimatedProviderCostMicros: estimated,
          gatewayReported: pricingSource === "gateway_reported",
          inputTokens: tokens(telemetry.inputTokens),
          outputTokens: tokens(telemetry.outputTokens),
        })
      : null;
  releaseHeldSessionUsageReceiptMeteredByEvent({
    sessionId: input.sessionId,
    sourceId: `${input.turnId}:${input.sourceKey}`,
    amountMicros: eventAmount,
    pricingSource: eventAmount === null ? null : pricingSource,
  });
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

export type { ModelUsageBillingRecord };
export { sanitizedModelUsageInput };

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
    /** The caller retains the response durably and retries the whole transaction. */
    atomicReceiptPersistence?: boolean;
  },
): Promise<ModelUsageBillingRecord | null> {
  if (!input.usage) {
    return null;
  }
  return await settleModelUsage(settings, db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    model: input.model,
    chargesOpenGeniCredits: input.chargesOpenGeniCredits ?? !input.externallyBilled,
    countsTowardTokenCap: input.countsTowardTokenCap ?? !input.externallyBilled,
    creditPolicyRevision: input.creditPolicyRevision,
    ...(input.gatewayBilling ? { gatewayBilling: input.gatewayBilling } : {}),
    normalizedUsage: input.normalizedUsage ?? normalizeModelCallUsage(input.usage),
    ...(input.recordCall === false ? {} : { onAuthoritativeCall: async (record) => {
      const resolved = input.provider === undefined || input.providerApi === undefined
        ? resolveModelProvider(settings, input.model)?.provider : undefined;
      await recordModelCallUsageEvent(db, {
        accountId: input.accountId, workspaceId: input.workspaceId, sessionId: input.sessionId,
        turnId: input.turnId, turnAttemptId: input.turnAttemptId, sourceKey: input.sourceKey,
        callKind: input.callKind ?? "response", outcome: input.outcome ?? "completed", scope: input.scope ?? "call",
        provider: input.provider ?? resolved?.id ?? settings.openaiProvider ?? "openai",
        providerApi: input.providerApi ?? resolved?.api ?? "responses", upstreamProvider: record.upstreamProvider ?? null,
        model: input.model, billingPath: record.billingPath,
        billing: { normalizedUsage: record.normalizedUsage, estimatedProviderCostMicros: record.estimatedProviderCostMicros,
          pricingSource: record.pricingSource, priceVersion: record.estimateSchedule ? modelPricingScheduleVersion(record.estimateSchedule) : null },
      });
    } }),
    sourceId: `${input.turnId}:${input.sourceKey}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    turnAttemptId: input.turnAttemptId,
    usageLimitMetrics: input.observability ?? null,
    // A failed task-usage receipt write never loses or replays the response:
    // custody writes it before the next model request or turn completion.
    receiptCustody: input.atomicReceiptPersistence
      ? null
      : (receipt) =>
          holdSessionUsageReceipt(
            { accountId: input.accountId, workspaceId: input.workspaceId },
            receipt,
          ),
    ...(input.latencyMode ? { latencyMode: input.latencyMode } : {}),
    debitMetadata: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceKey: input.sourceKey,
    },
    onCreditsDebited: (result) => {
      recordCreditMicros(input.observability, "usage", result.debitedMicros);
      recordModelCreditsCharged(input.observability, {
        provider: input.metricProvider ?? "unknown",
        model: modelMetricProductId(settings, input.metricProvider, input.model),
        debitedMicros: result.debitedMicros,
        grantDebitedMicros: result.grantDebitedMicros,
      });
    },
  });
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
  /** Provider-run web searches this response billed, when the provider reports them. */
  webSearchRequests?: number | undefined;
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
      ...(input.webSearchRequests ? { webSearchRequests: input.webSearchRequests } : {}),
    });
  } catch {
    // Durable event + billing already committed; metrics are best-effort only.
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23503" || causeCode === "23503";
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
  /** The shared-core subscription connection that served the call, if any. */
  subscriptionConnectionId?: string | null;
  contextContributions?: readonly ModelContextContributionSummary[] | null;
  timing?: ModelCallTiming | null;
  /** Prompt-cache observation; the fact write classifies a warm miss from it. */
  promptCache?: PromptCacheObservation | null;
}): Promise<void> {
  try {
    const telemetry = input.billing.normalizedUsage.telemetry;
    const fact = (connectionId: string | null) => ({
      connectionId,
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
      timing: input.timing ?? null,
      ...(input.contextContributions !== undefined
        ? { contextContributions: input.contextContributions }
        : {}),
      promptCache: input.promptCache ?? null,
    });
    let recorded: Awaited<ReturnType<typeof recordModelCallFact>> | undefined;
    try {
      recorded = await recordModelCallFact(input.db, fact(input.subscriptionConnectionId ?? null));
    } catch (error) {
      // The served connection was deleted mid-turn: keep the usage fact and
      // drop only its attribution, never the whole fact.
      if (!input.subscriptionConnectionId || !isForeignKeyViolation(error)) throw error;
      recorded = await recordModelCallFact(input.db, fact(null));
    }
    recordPromptCacheDiagnostics(input.observability, {
      provider: input.billing.upstreamProvider ?? input.provider,
      model: input.model,
      diagnostics: recorded?.promptCacheDiagnostics ?? null,
      cachedTokens: telemetry.cachedTokens,
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
    /** `refused`: the intent's dispatch was refused before any request bytes. */
    stage?: "dispatch" | "refused" | "terminal";
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
  const eventType = input.stage === "refused"
    ? MODEL_CALL_DISPATCH_REFUSED_EVENT_TYPE
    : input.stage === "dispatch" || input.outcome === "indeterminate" ? MODEL_CALL_DISPATCH_EVENT_TYPE : MODEL_CALL_USAGE_EVENT_TYPE;
  if (eventType === MODEL_CALL_DISPATCH_EVENT_TYPE) input = { ...input, billing: null, outcome: "indeterminate" };
  // Known to have had no provider effect: admission revoked before consumption.
  if (eventType === MODEL_CALL_DISPATCH_REFUSED_EVENT_TYPE) input = { ...input, billing: null, outcome: "cancelled" };
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
    sourceResourceType: eventType === MODEL_CALL_USAGE_EVENT_TYPE ? "model_response" : "model_dispatch",
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
 * Source authority is checked once per literal dispatch, after the intent: the
 * receipt-persistence check has just run, so a check before the intent would
 * only repeat it. A refusal here throws before bytes, so its effect is known to
 * be none: the intent is settled by a `model.call.dispatch.refused` row
 * (outcome cancelled, no usage, no cost), never left indeterminate, and
 * `onDispatchFailure` leaves a settled refusal alone.
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
      await recordModelCallUsageEvent(db, { ...call, sourceKey, stage: "dispatch", outcome: "indeterminate", billing: null });
      // The one live check at the final literal boundary, outside the intent
      // transaction: persistence may have waited, so it runs after the intent.
      try {
        await authorize?.(sourceKey);
      } catch (refusal) {
        try {
          await recordModelCallUsageEvent(db, { ...call, sourceKey, stage: "refused", billing: null });
        } catch {
          // The intent then stays unknown (indeterminate): still never billed.
        }
        throw refusal;
      }
    },
    onDispatchFailure: async sourceKey => {
      assertRoot();
      if (claimedSourceKeys.has(sourceKey)) return;
      const dispatchKey = `usage:${MODEL_CALL_DISPATCH_EVENT_TYPE}:${call.turnId}:${sourceKey}`;
      const terminalKey = `usage:${MODEL_CALL_USAGE_EVENT_TYPE}:${call.turnId}:${sourceKey}`;
      const refusedKey = `usage:${MODEL_CALL_DISPATCH_REFUSED_EVENT_TYPE}:${call.turnId}:${sourceKey}`;
      const existing = await existingUsageEventIdempotencyKeys(db, {
        accountId: call.accountId, workspaceId: call.workspaceId, keys: [dispatchKey, terminalKey, refusedKey],
      });
      if (!existing.has(dispatchKey) || existing.has(terminalKey) || existing.has(refusedKey)) return;
      // Transport loss supplies no provider terminal. Preserve the existing
      // unknown dispatch SOURCE_FACT without claiming the final accounting key
      // or suppressing a later authenticated provider terminal.
      await recordModelCallUsageEvent(db, { ...call, sourceKey, stage: "dispatch", outcome: "indeterminate", billing: null });
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


export function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
