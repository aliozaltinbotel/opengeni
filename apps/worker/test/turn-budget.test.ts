// F-2 (Cendra agent-ops): a turn's declared token and duration limits, enforced before a model call.
import { describe, expect, test } from "bun:test";
import {
  createTurnBudgetGuard,
  createTurnRouteWatch,
  primaryModelRefusal,
  TurnBudgetExhaustedError,
  turnBudgetExhaustion,
  usageTokensOf,
} from "../src/activities/agent-turn/turn-budget";

const modelData = { input: [], instructions: "x" };
const args = { modelData, agent: {} as never, context: undefined };

describe("F-2 turn budget guard", () => {
  test("no guard without a token or duration limit (a model-call budget narrows the SDK cap instead)", () => {
    expect(createTurnBudgetGuard(null)).toBeNull();
    expect(createTurnBudgetGuard({ maxModelCalls: 3 })).toBeNull();
  });

  test("usage events count total tokens, or input plus output; other events count nothing", () => {
    expect(usageTokensOf({ type: "agent.model.usage", payload: { totalTokens: 120 } })).toBe(120);
    expect(usageTokensOf({ type: "agent.model.usage", payload: { inputTokens: 100, outputTokens: 20 } })).toBe(120);
    expect(usageTokensOf({ type: "agent.message.completed", payload: { totalTokens: 999 } })).toBe(0);
  });

  test("the first model call always runs; a later one is refused once the tokens reach the limit", async () => {
    const guard = createTurnBudgetGuard({ maxTotalTokens: 1_000 })!;
    expect(await guard.filter(args)).toBe(modelData);
    guard.observe({ type: "agent.model.usage", payload: { totalTokens: 600 } });
    expect(await guard.filter(args)).toBe(modelData);
    guard.observe({ type: "agent.model.usage", payload: { totalTokens: 400 } });
    await expect(guard.filter(args)).rejects.toBeInstanceOf(TurnBudgetExhaustedError);
    expect(guard.used()).toBe(1_000);
  });

  test("a later model call is refused once the declared duration has passed", async () => {
    let clock = 0;
    const guard = createTurnBudgetGuard({ maxDurationMs: 60_000 }, () => clock)!;
    expect(await guard.filter(args)).toBe(modelData);
    clock = 59_999;
    expect(await guard.filter(args)).toBe(modelData);
    clock = 60_000;
    const refusal = await guard.filter(args).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(TurnBudgetExhaustedError);
    expect((refusal as TurnBudgetExhaustedError).limit).toBe("duration");
  });

  test("the budget error is found through a wrapping error's cause chain, and nothing else is", () => {
    const inner = new TurnBudgetExhaustedError("total_tokens", 1_200, 1_000);
    const wrapped = new Error("model call failed", { cause: new Error("filter", { cause: inner }) });
    expect(turnBudgetExhaustion(wrapped)).toBe(inner);
    expect(turnBudgetExhaustion(new Error("other"))).toBeNull();
    expect(turnBudgetExhaustion(null)).toBeNull();
  });
});


describe("F-2 route watch and model refusal", () => {
  test("pre-output holds only through the first model call with no output event", async () => {
    const watch = createTurnRouteWatch(null);
    expect(watch.preOutput()).toBe(true);
    await watch.filter(args);
    expect(watch.preOutput()).toBe(true);
    watch.observe({ type: "agent.message.delta", payload: { text: "Hi" } });
    expect(watch.preOutput()).toBe(false);
    const toolFirst = createTurnRouteWatch(null);
    await toolFirst.filter(args);
    await toolFirst.filter(args);
    expect(toolFirst.preOutput()).toBe(false);
  });
  test("a definitive refusal of the model is recognised through the cause chain; transient and credential faults are not", () => {
    expect(primaryModelRefusal({ status: 404, code: "model_not_found" })).toBe("http_404:model_not_found");
    expect(primaryModelRefusal(new Error("x", { cause: { status: 400, error: { code: "unsupported_model" } } }))).toBe(
      "http_400:unsupported_model",
    );
    expect(primaryModelRefusal({ status: 429, code: "rate_limit_exceeded" })).toBeNull();
    expect(primaryModelRefusal({ status: 401, code: "invalid_api_key" })).toBeNull();
    expect(primaryModelRefusal({ status: 500 })).toBeNull();
    expect(primaryModelRefusal({ status: 403, code: "insufficient_quota" })).toBeNull();
  });
});
