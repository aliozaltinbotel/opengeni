// F-2 (Cendra agent-ops): a turn's explicitly declared budget, enforced at the model-call boundary.
//
// Runs have no default length limit (docs/run-lifecycle.md). A declared budget is an explicit cap: before each model
// call the guard checks the tokens the turn's calls have used and the time since the attempt began, and when a limit
// is reached it throws TurnBudgetExhaustedError INSTEAD of calling the model. The failure settlement ends the turn
// gracefully (turn.completed {segmentLimit: "turn_budget", terminalReason: "TURN_BUDGET_EXHAUSTED"}, the session
// idles), exactly as a configured model-call cap does. The first model call of a turn always runs. maxModelCalls is not
// counted here: it narrows the SDK's own per-turn cap at claim.
//
// Where the tokens come from: the worker's stream loop settles each terminal model response (`responseSettled`, the
// same response the usage ledger records). Usage never arrives as a runtime event -- the worker publishes
// agent.model.usage itself -- so counting runtime events counted nothing (measured live: a 1,000-token budget let a
// turn make three calls). The SDK can reach the next model call before the loop has processed the previous response,
// so the check first waits, bounded, until every earlier call's response is settled.
import type { CallModelInputFilter } from "@openai/agents";
import type { TurnBudgetV1 } from "@opengeni/contracts";
import { modelTerminalResponseFromSdkEvent, normalizeModelCallUsage } from "@opengeni/runtime";

/** How long a token check waits for the earlier calls' responses to be settled before it judges what it has. */
export const TURN_BUDGET_SETTLE_WAIT_MS = 5_000;

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
  while (
    current !== null &&
    current !== undefined &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    if (current instanceof TurnBudgetExhaustedError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Tokens one terminal model response reports (its total, or input plus output; 0 when the provider reported no usage),
 * or null when the stream event is not a terminal response.
 */
export function terminalResponseTokens(
  event: Parameters<typeof modelTerminalResponseFromSdkEvent>[0],
): number | null {
  const terminal = modelTerminalResponseFromSdkEvent(event);
  if (!terminal) return null;
  const usage = terminal.usage?.usage;
  if (!usage) return 0;
  const normalized = normalizeModelCallUsage(usage);
  if (typeof normalized.totalTokens === "number" && Number.isFinite(normalized.totalTokens))
    return Math.max(0, normalized.totalTokens);
  return (
    Math.max(0, normalized.telemetry.inputTokens ?? 0) +
    Math.max(0, normalized.telemetry.outputTokens ?? 0)
  );
}

/**
 * A guard for the declared token and duration limits, or null when the budget declares neither. `settle` takes each
 * terminal model response's tokens as the worker processes it; `filter` is chained as the run's host model-input filter.
 */
export function createTurnBudgetGuard(
  budget: TurnBudgetV1 | null | undefined,
  now: () => number = () => Date.now(),
  settleWaitMs: number = TURN_BUDGET_SETTLE_WAIT_MS,
): Readonly<{
  settle: (tokens: number) => void;
  filter: CallModelInputFilter;
  used: () => number;
  settled: () => number;
}> | null {
  if (!budget || (budget.maxTotalTokens === undefined && budget.maxDurationMs === undefined))
    return null;
  const startedAt = now();
  let tokens = 0;
  let calls = 0;
  let settled = 0;
  const waiters = new Set<() => void>();
  const waitForSettled = async (count: number): Promise<void> => {
    const deadline = Date.now() + settleWaitMs;
    for (;;) {
      if (settled >= count) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        waiters.add(done);
      });
    }
  };
  return Object.freeze({
    settle(responseTokens: number) {
      tokens += Number.isFinite(responseTokens) ? Math.max(0, responseTokens) : 0;
      settled += 1;
      for (const wake of [...waiters]) wake();
    },
    used: () => tokens,
    settled: () => settled,
    filter: async ({ modelData }) => {
      calls += 1;
      if (calls > 1) {
        if (budget.maxTotalTokens !== undefined) await waitForSettled(calls - 1);
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
const OUTPUT_EVENT_TYPES = new Set([
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
]);

/**
 * F-2: what the attempt must know about a turn that declared a route. `preOutput()` holds only while the turn's FIRST
 * model call has not produced anything: no output event, no tool call created, and no second model call (a first
 * response of tool calls leads to a second call). A declared fallback runs only in that state, once, inside the same
 * attempt (NPD-013: `beginFallback`), so nothing was sent and nothing is sent twice. One watch spans both runs, so the
 * declared budget spans them too.
 */
export function createTurnRouteWatch(
  budget: TurnBudgetV1 | null | undefined,
  now: () => number = () => Date.now(),
  settleWaitMs: number = TURN_BUDGET_SETTLE_WAIT_MS,
) {
  const guard = createTurnBudgetGuard(budget, now, settleWaitMs);
  let modelCalls = 0;
  let outputObserved = false;
  let toolCallCreated = false;
  let fallbackBegun = false;
  const filter: CallModelInputFilter = async (args) => {
    modelCalls += 1;
    return guard ? await guard.filter(args) : args.modelData;
  };
  return Object.freeze({
    observe(event: Readonly<{ type: string; payload?: unknown }>) {
      if (OUTPUT_EVENT_TYPES.has(event.type)) outputObserved = true;
      if (event.type === "agent.toolCall.created") toolCallCreated = true;
    },
    /** One terminal model response processed by the worker's stream loop, with the tokens it reported. */
    responseSettled(tokens: number) {
      guard?.settle(tokens);
    },
    tokensUsed: () => guard?.used() ?? 0,
    filter,
    preOutput: () => modelCalls <= 1 && !outputObserved && !toolCallCreated,
    /** The declared fallback may begin: the primary's first call produced nothing, and no fallback ran yet. */
    fallbackMayBegin: () =>
      !fallbackBegun && modelCalls <= 1 && !outputObserved && !toolCallCreated,
    /**
     * NPD-013: the fallback begins in this attempt. The refused call is settled with no tokens (it produced no response),
     * so the fallback's first call never waits on it; its time stays counted against a declared duration.
     */
    beginFallback() {
      if (fallbackBegun) throw new Error("F-2: the declared fallback runs at most once per turn");
      fallbackBegun = true;
      guard?.settle(0);
    },
    fallbackBegun: () => fallbackBegun,
    modelCalls: () => modelCalls,
  });
}
export type TurnRouteWatch = ReturnType<typeof createTurnRouteWatch>;

/**
 * F-2: a provider's typed, definitive refusal of the requested MODEL (not a transient or credential fault): HTTP 404,
 * 400 or 403 whose error code names the model (a bare 404 from a gateway or proxy is not the model's). Anywhere in the
 * cause chain. Returns a short reason, or null.
 */
export function primaryModelRefusal(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== null &&
    current !== undefined &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);
    const record = current as {
      status?: unknown;
      code?: unknown;
      error?: { code?: unknown } | null;
      cause?: unknown;
    };
    const status = typeof record.status === "number" ? record.status : null;
    const code =
      typeof record.code === "string"
        ? record.code
        : typeof record.error?.code === "string"
          ? record.error.code
          : null;
    // Review P2-1: only a refusal whose code names the model counts (a gateway's or proxy's bare 404 is not the model's).
    if (
      (status === 404 || status === 400 || status === 403) &&
      code !== null &&
      /model/iu.test(code)
    )
      return `http_${status}:${code}`.slice(0, 200);
    current = record.cause;
  }
  return null;
}

/**
 * A host's refusal of a re-claimed attempt: the embedding host's tool preparation threw an error carrying
 * `hostAttemptRefusal: {code}` (anywhere in the cause chain). Returns the host's code, or null.
 */
export function hostAttemptRefusal(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== null &&
    current !== undefined &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);
    const marked = (current as { hostAttemptRefusal?: { code?: unknown } | null })
      .hostAttemptRefusal;
    if (marked && typeof marked.code === "string" && /^[A-Z][A-Z0-9_]{2,99}$/u.test(marked.code))
      return marked.code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
