// NPD-013 (Cendra agent-ops): when a declared fallback may run inside the attempt, and when it is refused by name. The
// durable switch is packages/db/test/turn-route-fallback.test.ts; the end-to-end run is the Cendra eval-world live proof.
import { describe, expect, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import {
  TURN_FALLBACK_NOT_RUN_REASONS,
  TurnExecutionPolicyV1,
  TurnRouteDeclarationV1,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  fallbackRunInputs,
  prepareDeclaredFallbackInAttempt,
} from "../src/activities/agent-turn/fallback-in-attempt";
import { createTurnRouteWatch } from "../src/activities/agent-turn/turn-budget";

const primary = TurnExecutionPolicyV1.parse({
  schemaVersion: 1,
  productModelId: "gpt-6-sol",
  requestedModelId: "gpt-6-sol",
  modelSource: "explicit",
  reasoningEffort: "low",
  reasoningSource: "explicit",
  providerId: "openai",
  upstreamModelId: "gpt-6-sol",
  wireApi: "responses",
  credentialSource: { kind: "deployment", mechanism: "none" },
  billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
  definitionVersion: `sha256:${"a".repeat(64)}`,
});
const fallback = TurnExecutionPolicyV1.parse({
  ...primary,
  productModelId: "gpt-6-astra",
  requestedModelId: "gpt-6-astra",
  upstreamModelId: "gpt-6-astra",
  definitionVersion: `sha256:${"b".repeat(64)}`,
});
const refused = Object.assign(new Error("404 The model does not exist"), {
  status: 404,
  code: "model_not_found",
});
const args = {
  modelData: { input: [], instructions: "x" },
  agent: {} as never,
  context: undefined,
};

function deps(overrides: Record<string, unknown> = {}) {
  const watch = createTurnRouteWatch(null);
  const providerTurn = {
    turnRouteDeclaration: TurnRouteDeclarationV1.parse({
      schemaVersion: 1,
      fallbackPolicy: fallback,
      turnBudget: null,
    }),
    turnRouteWatch: watch,
    fallbackNotRun: null as string | null,
  };
  const switched: unknown[] = [];
  return {
    watch,
    providerTurn,
    switched,
    input: {
      error: refused,
      db: {} as never,
      workspaceId: "w",
      sessionId: "s",
      attemptId: "a",
      turnId: "t",
      executionGeneration: 1,
      providerTurn,
      billingState: {
        isExternallyBilledTurn: false,
        chargesOpenGeniCredits: true,
        countsTowardTokenCap: true,
        isCodexTurn: false,
        isXaiTurn: false,
      },
      capabilitySettings: {} as never,
      resolveTurnModel: () => ({ provider: { id: "openai", api: "responses" }, configured: {} }),
      session: { codexCompactionMode: null } as never,
      workspaceModelPolicy: null,
      turn: { model: primary.productModelId, reasoningEffort: "low", latencyMode: "standard" },
      turnExecutionPolicy: primary,
      resolvedModel: { provider: { id: "openai", api: "responses" }, configured: {} },
      runSettings: {} as never,
      switchTurn: (async (...call: unknown[]) => {
        switched.push(call);
        return null;
      }) as never,
      ...overrides,
    },
  };
}

describe("NPD-013 declared fallback in the attempt", () => {
  test("nothing runs without a declared, unused fallback, a model refusal, or after the first call produced anything", async () => {
    const none = deps();
    none.providerTurn.turnRouteDeclaration = TurnRouteDeclarationV1.parse({
      schemaVersion: 1,
      fallbackPolicy: null,
      turnBudget: null,
    });
    await none.watch.filter(args);
    expect(await prepareDeclaredFallbackInAttempt(none.input as never)).toBeNull();
    const notModel = deps({
      error: Object.assign(new Error("rate"), { status: 429, code: "rate_limit_exceeded" }),
    });
    await notModel.watch.filter(args);
    expect(await prepareDeclaredFallbackInAttempt(notModel.input as never)).toBeNull();
    const afterOutput = deps();
    await afterOutput.watch.filter(args);
    afterOutput.watch.observe({ type: "agent.message.delta", payload: {} });
    expect(await prepareDeclaredFallbackInAttempt(afterOutput.input as never)).toBeNull();
    for (const value of [none, notModel, afterOutput]) {
      expect(value.switched).toHaveLength(0);
      expect(value.providerTurn.fallbackNotRun).toBeNull();
    }
  });

  test("a fallback on another provider or wire API cannot reuse this attempt's tools: refused by name, nothing switched", async () => {
    const otherApi = deps({
      resolveTurnModel: () => ({ provider: { id: "openai", api: "chat" }, configured: {} }),
    });
    await otherApi.watch.filter(args);
    expect(await prepareDeclaredFallbackInAttempt(otherApi.input as never)).toBeNull();
    expect(otherApi.providerTurn.fallbackNotRun).toBe("fallback_route_incompatible");
    expect(otherApi.switched).toHaveLength(0);
  });

  test("the accepting path: one fenced switch at this attempt and generation, the watch begun, billing re-derived, and the fallback is what runs", async () => {
    const settings = testSettings();
    const policyFor = (modelId: string) =>
      resolveTurnExecutionPolicyV1(settings, {
        modelId,
        requestedModelId: modelId,
        modelSource: "explicit",
        reasoningEffort: "low",
        reasoningSource: "explicit",
      } as never);
    const primaryPolicy = policyFor("gpt-5.6-sol");
    const fallbackPolicy = policyFor("gpt-5.6-terra");
    const switchedDeclaration = TurnRouteDeclarationV1.parse({
      schemaVersion: 1,
      fallbackPolicy,
      turnBudget: null,
      executed: "fallback",
      fallbackReason: "http_404:model_not_found",
    });
    const calls: unknown[][] = [];
    const accepted = deps({
      capabilitySettings: settings,
      turnExecutionPolicy: primaryPolicy,
      turn: { model: "gpt-5.6-sol", reasoningEffort: "low", latencyMode: "standard" },
      runSettings: { ...settings, openaiModel: "gpt-5.6-sol" },
      executionGeneration: 1,
      billingState: {
        isExternallyBilledTurn: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: false,
        isCodexTurn: true,
        isXaiTurn: true,
      },
      switchTurn: (async (...call: unknown[]) => {
        calls.push(call);
        return { declaration: switchedDeclaration };
      }) as never,
    });
    accepted.providerTurn.turnRouteDeclaration = TurnRouteDeclarationV1.parse({
      schemaVersion: 1,
      fallbackPolicy,
      turnBudget: null,
    });
    await accepted.watch.filter(args);
    const result = await prepareDeclaredFallbackInAttempt(accepted.input as never);
    expect(result).not.toBeNull();
    // One durable switch, fenced to THIS attempt and generation, naming the fallback and the provider's refusal.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe("w");
    expect(calls[0]?.[2]).toMatchObject({
      sessionId: "s",
      turnId: "t",
      attemptId: "a",
      executionGeneration: 1,
      policy: fallbackPolicy,
    });
    const switchInput = calls[0]![2] as { reason?: unknown };
    expect(typeof switchInput.reason).toBe("string");
    expect(accepted.watch.fallbackBegun()).toBe(true);
    expect(accepted.providerTurn.turnRouteDeclaration).toBe(switchedDeclaration);
    expect(accepted.providerTurn.fallbackNotRun).toBeNull();
    // The second run is the fallback's: its model on the turn and in the run settings, and its billing identity.
    expect(result!.turn.model).toBe("gpt-5.6-terra");
    expect((result!.runSettings as { openaiModel?: string }).openaiModel).toBe("gpt-5.6-terra");
    expect(result!.policy.productModelId).toBe("gpt-5.6-terra");
    const billing = accepted.input.billingState;
    expect([billing.isCodexTurn, billing.isXaiTurn]).toEqual([false, false]);
    // A second preparation in the same attempt never switches again (the watch has begun).
    await expect(prepareDeclaredFallbackInAttempt(accepted.input as never)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("the second run is built and streamed on the fallback's route, and the missing-title directive is not asked again", () => {
    const fallbackTurn = {
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      latencyMode: "standard",
    };
    const prepared = {
      turn: fallbackTurn,
      policy: fallback,
      runSettings: { openaiModel: "gpt-5.6-terra" } as never,
      resolvedModel: { provider: { id: "openai" } },
      refusal: "http_404:model_not_found",
    };
    const build = {
      turn: { model: "gpt-5.6-sol" },
      turnExecutionPolicy: primary,
      runSettings: {},
      resolvedModel: null,
      tools: ["kept"],
    };
    const stream = {
      turn: { model: "gpt-5.6-sol" },
      turnExecutionPolicy: primary,
      runSettings: {},
      resolvedModel: null,
      attemptId: "a",
      generateSessionTitleInParallel: true,
    };
    const next = fallbackRunInputs(build, stream, prepared);
    for (const input of [next.build, next.stream]) {
      expect(input.turn).toBe(fallbackTurn);
      expect(input.turn.model).toBe("gpt-5.6-terra");
      expect(input.turnExecutionPolicy).toBe(fallback);
      expect(input.runSettings).toBe(prepared.runSettings);
      expect(input.resolvedModel).toBe(prepared.resolvedModel);
    }
    expect(next.build.tools).toEqual(["kept"]);
    expect(next.stream.attemptId).toBe("a");
    expect(next.build.suppressMissingSessionTitleHint).toBe(true);
    expect(next.stream.generateSessionTitleInParallel).toBe(false);
    expect(build.turn.model).toBe("gpt-5.6-sol");
    expect(stream.generateSessionTitleInParallel).toBe(true);
  });

  test("every reason a declared fallback did not run is one the contract names", async () => {
    const reasons = new Set<string>();
    const incompatible = deps({
      resolveTurnModel: () => ({ provider: { id: "openai", api: "chat" }, configured: {} }),
    });
    await incompatible.watch.filter(args);
    await prepareDeclaredFallbackInAttempt(incompatible.input as never);
    reasons.add(incompatible.providerTurn.fallbackNotRun!);
    const unconfigured = deps();
    await unconfigured.watch.filter(args);
    await prepareDeclaredFallbackInAttempt(unconfigured.input as never);
    reasons.add(unconfigured.providerTurn.fallbackNotRun!);
    for (const reason of reasons)
      expect(TURN_FALLBACK_NOT_RUN_REASONS as readonly string[]).toContain(reason);
    expect(Object.isFrozen(TURN_FALLBACK_NOT_RUN_REASONS)).toBe(true);
    expect([...TURN_FALLBACK_NOT_RUN_REASONS]).toEqual([
      "fallback_route_incompatible",
      "fallback_model_not_configured",
      "fallback_model_blocked_by_workspace_policy",
      "fallback_declaration_or_attempt_changed",
    ]);
  });
});
