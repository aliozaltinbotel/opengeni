// NPD-013 (Cendra agent-ops): when a declared fallback may run inside the attempt, and when it is refused by name. The
// durable switch is packages/db/test/turn-route-fallback.test.ts; the end-to-end run is the Cendra eval-world live proof.
import { describe, expect, test } from "bun:test";
import { TurnExecutionPolicyV1, TurnRouteDeclarationV1 } from "@opengeni/contracts";
import { prepareDeclaredFallbackInAttempt } from "../src/activities/agent-turn/fallback-in-attempt";
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
});
