// F-2 (Cendra agent-ops): a turn's explicitly declared budget, enforced at the model-call boundary.
//
// Runs have no default length limit (docs/run-lifecycle.md). A declared budget is an explicit cap: before each model
// call the guard checks the tokens the turn's calls have used and the time since the attempt began, and when a limit
// is reached it throws TurnBudgetExhaustedError INSTEAD of calling the model. The failure settlement ends the turn
// gracefully (turn.completed {segmentLimit: "turn_budget", terminalReason: "TURN_BUDGET_EXHAUSTED"}, the session
// idles), exactly as a configured model-call cap does. The first model call of a turn always runs. maxModelCalls is not
// counted here: it narrows the SDK's own per-turn cap at claim.
import type { CallModelInputFilter } from "@openai/agents";
import type { TurnBudgetV1 } from "@opengeni/contracts";

export type TurnBudgetLimit = "total_tokens" | "duration";

export class TurnBudgetExhaustedError extends Error {
  readonly limit: TurnBudgetLimit;
  readonly used: number;
  readonly maximum: number;
  constructor(limit: TurnBudgetLimit, used: number, maximum: number) {
    super(`TURN_BUDGET_EXHAUSTED: ${limit} ${used} of ${maximum}`);
    this.name = "TurnBudgetExhaustedError";
    this.limit = limit;
    this.used = used;
    this.maximum = maximum;
  }
}

/** The declared budget error anywhere in an error's cause chain (the SDK may wrap what a filter throws). */
export function turnBudgetExhaustion(error: unknown): TurnBudgetExhaustedError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && typeof current === "object" && !seen.has(current)) {
    if (current instanceof TurnBudgetExhaustedError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Tokens one runtime event reports, when it is a model usage event (0 otherwise). */
export function usageTokensOf(event: Readonly<{ type: string; payload?: unknown }>): number {
  if (event.type !== "agent.model.usage") return 0;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const total = payload.totalTokens;
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) return total;
  const input = typeof payload.inputTokens === "number" ? payload.inputTokens : 0;
  const output = typeof payload.outputTokens === "number" ? payload.outputTokens : 0;
  return Math.max(0, input) + Math.max(0, output);
}

/**
 * A guard for the declared token and duration limits, or null when the budget declares neither. `observe` takes every
 * runtime event the worker publishes; `filter` is chained as the run's host model-input filter.
 */
export function createTurnBudgetGuard(
  budget: TurnBudgetV1 | null | undefined,
  now: () => number = () => Date.now(),
): Readonly<{ observe: (event: Readonly<{ type: string; payload?: unknown }>) => void; filter: CallModelInputFilter; used: () => number }> | null {
  if (!budget || (budget.maxTotalTokens === undefined && budget.maxDurationMs === undefined)) return null;
  const startedAt = now();
  let tokens = 0;
  let calls = 0;
  return Object.freeze({
    observe(event) {
      tokens += usageTokensOf(event);
    },
    used: () => tokens,
    filter: async ({ modelData }) => {
      calls += 1;
      if (calls > 1) {
        if (budget.maxTotalTokens !== undefined && tokens >= budget.maxTotalTokens) {
          throw new TurnBudgetExhaustedError("total_tokens", tokens, budget.maxTotalTokens);
        }
        const elapsed = now() - startedAt;
        if (budget.maxDurationMs !== undefined && elapsed >= budget.maxDurationMs) {
          throw new TurnBudgetExhaustedError("duration", elapsed, budget.maxDurationMs);
        }
      }
      return modelData;
    },
  });
}

/** Runtime events that mean the model produced output for the turn (text or reasoning). */
const OUTPUT_EVENT_TYPES = new Set(["agent.message.delta", "agent.message.completed", "agent.reasoning.delta"]);

/**
 * F-2: what the settlement must know about a turn that declared a route. `preOutput()` holds only while the turn's
 * FIRST model call has not produced anything: no output event, and no second model call (a first response of tool
 * calls leads to a second call). A declared fallback runs only in that state.
 */
export function createTurnRouteWatch(budget: TurnBudgetV1 | null | undefined, now: () => number = () => Date.now()) {
  const guard = createTurnBudgetGuard(budget, now);
  let modelCalls = 0;
  let outputObserved = false;
  const filter: CallModelInputFilter = async (args) => {
    modelCalls += 1;
    return guard ? await guard.filter(args) : args.modelData;
  };
  return Object.freeze({
    observe(event: Readonly<{ type: string; payload?: unknown }>) {
      if (OUTPUT_EVENT_TYPES.has(event.type)) outputObserved = true;
      guard?.observe(event);
    },
    filter,
    preOutput: () => modelCalls <= 1 && !outputObserved,
    modelCalls: () => modelCalls,
  });
}
export type TurnRouteWatch = ReturnType<typeof createTurnRouteWatch>;

/**
 * F-2: a provider's typed, definitive refusal of the requested MODEL (not a transient or credential fault): HTTP 404,
 * or HTTP 400/403 whose error code names the model. Anywhere in the cause chain. Returns a short reason, or null.
 */
export function primaryModelRefusal(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { status?: unknown; code?: unknown; error?: { code?: unknown } | null; cause?: unknown };
    const status = typeof record.status === "number" ? record.status : null;
    const code =
      typeof record.code === "string" ? record.code : typeof record.error?.code === "string" ? record.error.code : null;
    if (status === 404) return `http_404${code ? `:${code}` : ""}`.slice(0, 200);
    if ((status === 400 || status === 403) && code !== null && /model/iu.test(code)) return `http_${status}:${code}`.slice(0, 200);
    current = record.cause;
  }
  return null;
}
