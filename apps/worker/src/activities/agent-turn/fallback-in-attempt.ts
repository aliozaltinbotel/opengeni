// NPD-013 (Cendra agent-ops): a turn's declared fallback runs INSIDE the attempt that holds the turn.
//
// A recovery re-claims the turn at the next execution generation, and an embedding host fences its compiled attempt
// context on that generation (Cendra refuses the re-claimed attempt). So the fallback never recovers: when the provider
// definitively refused the PRIMARY model on the turn's first model call, before any output or tool call, the same
// attempt re-runs the stream on the fallback route, from the same input, with the same prepared tools and host context.
//
// It runs only when:
//   * the turn declared a fallback and has not run it (the frozen declaration: executed = primary);
//   * the error is a model refusal whose code names the model (primaryModelRefusal);
//   * the route watch says nothing was produced: one model call, no output, no tool call (fallbackMayBegin);
//   * the fallback route is compatible with what this attempt prepared: the same provider and provider API, not a
//     connected subscription (whose credentials and transport were bound for the primary);
//   * the configuration, the session and the workspace model policy admit the fallback model.
// A declared fallback that cannot run is named (`providerTurn.fallbackNotRun`), and the turn ends FALLBACK_REFUSED.
// The switch is recorded durably and fenced BEFORE the fallback's first call (switchSessionTurnToDeclaredFallback).
import { assertTurnExecutionPolicyMatchesConfigV1, type Settings } from "@opengeni/config";
import {
  evaluateWorkspaceModelPolicy,
  type TurnExecutionPolicyV1,
  type TurnFallbackNotRunReason,
} from "@opengeni/contracts";
import { assertSessionAllowsProductModel } from "@opengeni/core";
import { switchSessionTurnToDeclaredFallback } from "@opengeni/db";

import { turnExecutionPolicyBillingIdentity } from "./admission";
import { primaryModelRefusal } from "./turn-budget";

type ResolvedModel = {
  provider: { id: string; api?: string; kind?: string };
  configured: unknown;
} | null;

export type InAttemptFallback<TTurn, TResolved> = {
  turn: TTurn;
  policy: TurnExecutionPolicyV1;
  runSettings: Settings;
  resolvedModel: TResolved;
  refusal: string;
};

const SUBSCRIPTION_PROVIDERS = new Set(["codex-subscription", "supergrok-subscription"]);

export async function prepareDeclaredFallbackInAttempt<
  TTurn extends { model: string; reasoningEffort: string; latencyMode: string },
  TResolved extends ResolvedModel,
>(deps: {
  error: unknown;
  db: Parameters<typeof switchSessionTurnToDeclaredFallback>[0];
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  turnId: string;
  executionGeneration: number;
  providerTurn: {
    turnRouteDeclaration: import("@opengeni/contracts").TurnRouteDeclarationV1 | null;
    turnRouteWatch: import("./turn-budget").TurnRouteWatch | null;
    fallbackNotRun: TurnFallbackNotRunReason | null;
  };
  billingState: {
    isExternallyBilledTurn: boolean;
    chargesOpenGeniCredits: boolean;
    countsTowardTokenCap: boolean;
    isCodexTurn: boolean;
    isXaiTurn: boolean;
  };
  capabilitySettings: Settings;
  resolveTurnModel: (settings: Settings, productModelId: string) => TResolved;
  session: Parameters<typeof assertSessionAllowsProductModel>[0];
  workspaceModelPolicy: Parameters<typeof evaluateWorkspaceModelPolicy>[0] | null | undefined;
  turn: TTurn;
  turnExecutionPolicy: TurnExecutionPolicyV1;
  resolvedModel: TResolved;
  runSettings: Settings;
  /** The durable, fenced switch (tests inject a fake). */
  switchTurn?: typeof switchSessionTurnToDeclaredFallback;
}): Promise<InAttemptFallback<TTurn, TResolved> | null> {
  const declared = deps.providerTurn.turnRouteDeclaration;
  const watch = deps.providerTurn.turnRouteWatch;
  if (!declared?.fallbackPolicy || declared.executed !== "primary" || !watch) return null;
  const refusal = primaryModelRefusal(deps.error);
  if (refusal === null || !watch.fallbackMayBegin()) return null;
  const notRun = (reason: TurnFallbackNotRunReason) => {
    deps.providerTurn.fallbackNotRun = reason;
    return null;
  };
  const fallback = declared.fallbackPolicy;
  const primary = deps.turnExecutionPolicy;
  const resolved = deps.resolveTurnModel(deps.capabilitySettings, fallback.productModelId);
  if (
    fallback.providerId !== primary.providerId ||
    SUBSCRIPTION_PROVIDERS.has(fallback.providerId) ||
    (resolved?.provider.id ?? null) !== (deps.resolvedModel?.provider.id ?? null) ||
    (resolved?.provider.api ?? "responses") !== (deps.resolvedModel?.provider.api ?? "responses")
  ) {
    return notRun("fallback_route_incompatible");
  }
  let verified: ReturnType<typeof assertTurnExecutionPolicyMatchesConfigV1>;
  try {
    verified = assertTurnExecutionPolicyMatchesConfigV1(deps.capabilitySettings, fallback, {
      modelId: fallback.productModelId,
      reasoningEffort: fallback.reasoningEffort as Settings["openaiReasoningEffort"],
      latencyMode: fallback.latencyMode,
    });
    assertSessionAllowsProductModel(deps.session, verified.policy.productModelId);
  } catch {
    return notRun("fallback_model_not_configured");
  }
  if (deps.workspaceModelPolicy) {
    const verdict = evaluateWorkspaceModelPolicy(deps.workspaceModelPolicy, {
      providerId: verified.policy.providerId,
      modelId: verified.policy.productModelId,
    });
    if (!verdict.allowed) return notRun("fallback_model_blocked_by_workspace_policy");
  }
  const switched = await (deps.switchTurn ?? switchSessionTurnToDeclaredFallback)(
    deps.db,
    deps.workspaceId,
    {
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      attemptId: deps.attemptId,
      executionGeneration: deps.executionGeneration,
      policy: fallback,
      reason: refusal,
    },
  );
  if (switched === null) return notRun("fallback_declaration_or_attempt_changed");
  watch.beginFallback();
  deps.providerTurn.turnRouteDeclaration = switched.declaration;
  const billing = turnExecutionPolicyBillingIdentity(verified.policy);
  deps.billingState.isExternallyBilledTurn = billing.externallyBilled;
  deps.billingState.chargesOpenGeniCredits = verified.model.cost === "credits";
  deps.billingState.countsTowardTokenCap = billing.countsTowardTokenCap;
  deps.billingState.isCodexTurn = billing.codexSubscription;
  deps.billingState.isXaiTurn = billing.xaiSubscription;
  return {
    turn: {
      ...deps.turn,
      model: verified.policy.productModelId,
      reasoningEffort: verified.policy.reasoningEffort,
      latencyMode: verified.policy.latencyMode,
    },
    policy: verified.policy,
    runSettings: {
      ...deps.runSettings,
      openaiModel: verified.policy.productModelId,
      openaiReasoningEffort: verified.policy.reasoningEffort as Settings["openaiReasoningEffort"],
    },
    resolvedModel: resolved,
    refusal,
  };
}

/**
 * The second run's inputs (review P1-2 of b4c66b449): the agent is rebuilt and the stream re-run on the FALLBACK's turn,
 * policy, run settings and resolved model -- everything else exactly as the primary prepared it (the same claim,
 * generation, tools and host context). The missing-title directive is not asked a second time (review P2-2): the
 * primary's first request already carried it. run.ts builds both inputs here, so a refactor that drops a field fails
 * test/fallback-in-attempt.test.ts rather than recording the primary's model for the fallback's run.
 */
export function fallbackRunInputs<TBuild extends object, TStream extends object, TTurn, TResolved>(
  build: TBuild,
  stream: TStream,
  fallback: InAttemptFallback<TTurn, TResolved>,
): {
  build: TBuild & FallbackRoute<TTurn, TResolved> & { suppressMissingSessionTitleHint: true };
  stream: TStream & FallbackRoute<TTurn, TResolved> & { generateSessionTitleInParallel: false };
} {
  const route: FallbackRoute<TTurn, TResolved> = {
    turn: fallback.turn,
    turnExecutionPolicy: fallback.policy,
    runSettings: fallback.runSettings,
    resolvedModel: fallback.resolvedModel,
  };
  return {
    build: { ...build, ...route, suppressMissingSessionTitleHint: true },
    stream: { ...stream, ...route, generateSessionTitleInParallel: false },
  };
}

type FallbackRoute<TTurn, TResolved> = {
  turn: TTurn;
  turnExecutionPolicy: TurnExecutionPolicyV1;
  runSettings: Settings;
  resolvedModel: TResolved;
};
