// F-2 (Cendra agent-ops): a turn's declared token and duration limits, enforced before a model call.
import { describe, expect, test } from "bun:test";
import {
  createTurnBudgetGuard,
  createTurnRouteWatch,
  hostAttemptRefusal,
  primaryModelRefusal,
  terminalResponseTokens,
  TurnBudgetExhaustedError,
  turnBudgetExhaustion,
} from "../src/activities/agent-turn/turn-budget";

const modelData = { input: [], instructions: "x" };
const args = { modelData, agent: {} as never, context: undefined };

describe("F-2 turn budget guard", () => {
  test("no guard without a token or duration limit (a model-call budget narrows the SDK cap instead)", () => {
    expect(createTurnBudgetGuard(null)).toBeNull();
    expect(createTurnBudgetGuard({ maxModelCalls: 3 })).toBeNull();
  });

  test("a terminal response counts its total tokens, or input plus output; no usage is 0; any other event is not a response", () => {
    const done = (usage: unknown) =>
      ({
        type: "raw_model_stream_event",
        data: { type: "response_done", response: { id: "resp_1", usage } },
      }) as never;
    expect(
      terminalResponseTokens(done({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })),
    ).toBe(120);
    expect(terminalResponseTokens(done({ input_tokens: 100, output_tokens: 20 }))).toBe(120);
    expect(terminalResponseTokens(done(undefined))).toBe(0);
    expect(
      terminalResponseTokens({
        type: "raw_model_stream_event",
        data: { type: "output_text_delta", delta: "x" },
      } as never),
    ).toBeNull();
  });

  test("the first model call always runs; a later one is refused once the settled responses reach the limit", async () => {
    const guard = createTurnBudgetGuard({ maxTotalTokens: 1_000 })!;
    expect(await guard.filter(args)).toBe(modelData);
    guard.settle(600);
    expect(await guard.filter(args)).toBe(modelData);
    guard.settle(400);
    await expect(guard.filter(args)).rejects.toBeInstanceOf(TurnBudgetExhaustedError);
    expect(guard.used()).toBe(1_000);
  });

  test("a later call waits for the earlier call's response to be settled, so a fast SDK cannot pass on a stale count", async () => {
    const guard = createTurnBudgetGuard({ maxTotalTokens: 1_000 })!;
    await guard.filter(args);
    // The SDK reaches the second call before the loop has processed the first response (1,200 tokens).
    const second = guard.filter(args).then(
      () => "called",
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    guard.settle(1_200);
    expect(await second).toBeInstanceOf(TurnBudgetExhaustedError);
  });

  test("the wait is bounded: an unsettled response lets the call through on what is counted", async () => {
    const guard = createTurnBudgetGuard({ maxTotalTokens: 1_000 }, () => Date.now(), 30)!;
    await guard.filter(args);
    const started = Date.now();
    expect(await guard.filter(args)).toBe(modelData);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(guard.settled()).toBe(0);
  });

  test("a duration-only budget never waits for settlement", async () => {
    const guard = createTurnBudgetGuard({ maxDurationMs: 60_000 }, () => 0, 60_000)!;
    await guard.filter(args);
    const started = Date.now();
    expect(await guard.filter(args)).toBe(modelData);
    expect(Date.now() - started).toBeLessThan(1_000);
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
    const wrapped = new Error("model call failed", {
      cause: new Error("filter", { cause: inner }),
    });
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
  test("the watch feeds settled responses to its budget and reports the tokens used", async () => {
    const watch = createTurnRouteWatch({ maxTotalTokens: 1_000 });
    await watch.filter(args);
    watch.responseSettled(1_000);
    expect(watch.tokensUsed()).toBe(1_000);
    await expect(watch.filter(args)).rejects.toBeInstanceOf(TurnBudgetExhaustedError);
    // Usage published as an event is not counted twice (the worker publishes agent.model.usage itself).
    const other = createTurnRouteWatch({ maxTotalTokens: 1_000 });
    other.observe({ type: "agent.model.usage", payload: { totalTokens: 5_000 } });
    expect(other.tokensUsed()).toBe(0);
  });
  test("a definitive refusal of the model is recognised through the cause chain; transient and credential faults are not", () => {
    expect(primaryModelRefusal({ status: 404, code: "model_not_found" })).toBe(
      "http_404:model_not_found",
    );
    expect(
      primaryModelRefusal(
        new Error("x", { cause: { status: 400, error: { code: "unsupported_model" } } }),
      ),
    ).toBe("http_400:unsupported_model");
    expect(primaryModelRefusal({ status: 429, code: "rate_limit_exceeded" })).toBeNull();
    expect(primaryModelRefusal({ status: 401, code: "invalid_api_key" })).toBeNull();
    expect(primaryModelRefusal({ status: 500 })).toBeNull();
    expect(primaryModelRefusal({ status: 403, code: "insufficient_quota" })).toBeNull();
    // Review P2-1: a bare 404 (a gateway's or proxy's) is not the model's refusal.
    expect(primaryModelRefusal({ status: 404 })).toBeNull();
    expect(primaryModelRefusal({ status: 404, code: "not_found" })).toBeNull();
  });
});

describe("NPD-013 route watch: the fallback begins once, only before anything was produced", () => {
  test("a tool call created, or output, or a second call closes it; beginning twice is refused", async () => {
    const watch = createTurnRouteWatch({ maxTotalTokens: 1_000 });
    await watch.filter(args);
    expect(watch.fallbackMayBegin()).toBe(true);
    watch.beginFallback();
    expect(watch.fallbackMayBegin()).toBe(false);
    expect(() => watch.beginFallback()).toThrow();
    // The refused call was settled with no tokens: the fallback's first call does not wait on it.
    const started = Date.now();
    expect(await watch.filter(args)).toBe(modelData);
    expect(Date.now() - started).toBeLessThan(1_000);
    const tool = createTurnRouteWatch(null);
    await tool.filter(args);
    tool.observe({ type: "agent.toolCall.created", payload: {} });
    expect(tool.fallbackMayBegin()).toBe(false);
    expect(tool.preOutput()).toBe(false);
  });
  test("a host's refusal is read from the cause chain by its code, and nothing else is", () => {
    const refused = Object.assign(new Error("ATTEMPT_CONTEXT_AUTHORITY_STALE"), {
      hostAttemptRefusal: { code: "ATTEMPT_CONTEXT_AUTHORITY_STALE" },
    });
    expect(hostAttemptRefusal(new Error("wrapped", { cause: refused }))).toBe(
      "ATTEMPT_CONTEXT_AUTHORITY_STALE",
    );
    expect(hostAttemptRefusal(new Error("ATTEMPT_CONTEXT_AUTHORITY_STALE"))).toBeNull();
    expect(hostAttemptRefusal({ hostAttemptRefusal: { code: "not a code" } })).toBeNull();
  });
});
