import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createObservability, type Observability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { createRuntimeBatcher } from "../src/activities/streaming";
import {
  TOOL_PATH_PHASES,
  ToolPathPhaseTimer,
  toolPathPhaseMetricObserver,
  type ToolPathPhaseObservation,
} from "../src/activities/agent-turn/tool-path-phase-timing";

function fakeClock(start = 1_790_000_000_000) {
  let wall = start;
  let mono = 10;
  return {
    clock: { wall: () => wall, mono: () => mono },
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
  };
}

describe("tool-path phase timing", () => {
  test("each occurrence emits its fixed phase with wall start/end, duration and outcome", async () => {
    const seen: ToolPathPhaseObservation[] = [];
    const { clock, advance } = fakeClock();
    const timer = new ToolPathPhaseTimer((o) => seen.push(o), clock);
    const value = await timer.measure("pending_tool_registration", async () => {
      advance(12);
      return { accepted: true };
    });
    expect(value).toEqual({ accepted: true });
    await expect(
      timer.measure("pending_result_recording", async () => {
        advance(5);
        throw new Error("fenced");
      }),
    ).rejects.toThrow("fenced");
    // Two occurrences of the same phase are two observations, never a sum.
    await timer.measure("pending_tool_registration", async () => advance(3));
    expect(seen).toEqual([
      {
        phase: "pending_tool_registration",
        outcome: "completed",
        startedAtMs: 1_790_000_000_000,
        endedAtMs: 1_790_000_000_012,
        durationMs: 12,
      },
      {
        phase: "pending_result_recording",
        outcome: "failed",
        startedAtMs: 1_790_000_000_012,
        endedAtMs: 1_790_000_000_017,
        durationMs: 5,
      },
      {
        phase: "pending_tool_registration",
        outcome: "completed",
        startedAtMs: 1_790_000_000_017,
        endedAtMs: 1_790_000_000_020,
        durationMs: 3,
      },
    ]);
    for (const observation of seen) {
      expect(Object.keys(observation).sort()).toEqual(
        ["durationMs", "endedAtMs", "outcome", "phase", "startedAtMs"].sort(),
      );
      expect(TOOL_PATH_PHASES).toContain(observation.phase);
    }
  });

  test("terminal processing is recorded only for processed events (and failures)", async () => {
    const seen: ToolPathPhaseObservation[] = [];
    const timer = new ToolPathPhaseTimer((o) => seen.push(o));
    expect(await timer.measureTerminal(async () => ({ status: "not_response" }))).toEqual({
      status: "not_response",
    });
    expect(await timer.measureTerminal(async () => ({ status: "duplicate" }))).toEqual({
      status: "duplicate",
    });
    await timer.measureTerminal(async () => ({ status: "processed" }));
    await expect(
      timer.measureTerminal(async () => {
        throw new Error("lease lost");
      }),
    ).rejects.toThrow("lease lost");
    expect(seen.map((o) => [o.phase, o.outcome])).toEqual([
      ["model_response_terminal", "completed"],
      ["model_response_terminal", "failed"],
    ]);
  });

  test("a structural publication splits at the last write fence reported while it is in flight", async () => {
    const seen: ToolPathPhaseObservation[] = [];
    const { clock, advance } = fakeClock();
    const timer = new ToolPathPhaseTimer((o) => seen.push(o), clock);
    // Outside a structural publication a fence is ignored.
    timer.noteAppendFenceSettled();
    await timer.measureStructuralPublication(async () => {
      advance(40); // an earlier delta batch's append
      timer.noteAppendFenceSettled();
      advance(380); // this event's batch: transaction admission and its fence wait
      timer.noteAppendFenceSettled();
      advance(115); // insert (occurredAt assigned after the fence), projection, commit, publish
    });
    const byPhase = Object.fromEntries(seen.map((o) => [o.phase, o]));
    expect(byPhase.structural_publication).toMatchObject({ outcome: "completed", durationMs: 535 });
    expect(byPhase.structural_append_pre_fence).toMatchObject({
      outcome: "completed",
      durationMs: 420,
      startedAtMs: byPhase.structural_publication!.startedAtMs,
    });
    expect(byPhase.structural_append_post_fence).toMatchObject({
      outcome: "completed",
      durationMs: 115,
      endedAtMs: byPhase.structural_publication!.endedAtMs,
    });
    expect(byPhase.structural_append_pre_fence!.endedAtMs).toBe(
      byPhase.structural_append_post_fence!.startedAtMs,
    );
  });

  test("a throwing or rejecting observer changes no value, error, await or order", async () => {
    const order: string[] = [];
    const run = async (timer: ToolPathPhaseTimer) => {
      order.length = 0;
      const results: unknown[] = [];
      results.push(
        await timer.measure("stable_history_reconciliation", async () => {
          order.push("reconcile");
          return "stable";
        }),
      );
      try {
        await timer.measure("ensure_run_allowed", async () => {
          order.push("ensure");
          throw new RangeError("limit");
        });
      } catch (error) {
        results.push(error);
      }
      results.push(
        await timer.measureStructuralPublication(async () => {
          order.push("push");
          timer.noteAppendFenceSettled();
          return undefined;
        }),
      );
      return { results, order: [...order] };
    };
    const baseline = await run(new ToolPathPhaseTimer(undefined));
    const throwing = await run(
      new ToolPathPhaseTimer(() => {
        throw new Error("observer broke");
      }),
    );
    const rejecting = await run(new ToolPathPhaseTimer(async () => Promise.reject(new Error("x"))));
    for (const other of [throwing, rejecting]) {
      expect(other.order).toEqual(baseline.order);
      expect(other.results[0]).toBe("stable");
      expect(other.results[1]).toBeInstanceOf(RangeError);
      expect((other.results[1] as Error).message).toBe("limit");
      expect(other.results[2]).toBeUndefined();
    }
  });

  test("the structural split around a real batcher keeps its flush order and batches", async () => {
    const seen: ToolPathPhaseObservation[] = [];
    const timer = new ToolPathPhaseTimer((o) => seen.push(o));
    const appended: string[][] = [];
    const batcher = createRuntimeBatcher(async (events) => {
      // The append observer reports the fence inside each batch's transaction.
      timer.noteAppendFenceSettled();
      appended.push(events.map((event) => event.type));
    });
    await batcher.push({ type: "agent.message.delta", payload: {} });
    await timer.measureStructuralPublication(() =>
      batcher.push({ type: "agent.toolCall.output", payload: {} }),
    );
    await batcher.flush();
    // Same single flush carrying the pending delta first, exactly as without timing.
    expect(appended).toEqual([["agent.message.delta", "agent.toolCall.output"]]);
    expect(seen.map((o) => o.phase)).toEqual([
      "structural_publication",
      "structural_append_pre_fence",
      "structural_append_post_fence",
    ]);
  });

  test("metric observer uses closed labels and a debug record with wall times only", () => {
    const histograms: unknown[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const observer = toolPathPhaseMetricObserver({
      observeHistogram: (input) => histograms.push(input),
      debug: (message, attributes) => logs.push([message, attributes as Record<string, unknown>]),
    } as unknown as Observability)!;
    observer({
      phase: "structural_append_post_fence",
      outcome: "completed",
      startedAtMs: 1,
      endedAtMs: 2,
      durationMs: 115,
    });
    expect(histograms).toEqual([
      expect.objectContaining({
        name: "opengeni_turn_tool_path_phase_seconds",
        labels: { phase: "structural_append_post_fence", outcome: "completed" },
        value: 0.115,
      }),
    ]);
    expect(logs).toEqual([
      [
        "turn.tool_path.phase",
        {
          op: "structural_append_post_fence",
          outcome: "completed",
          startedAtMs: 1,
          endedAtMs: 2,
          durationMs: 115,
        },
      ],
    ]);
  });

  test("the worker keeps the same calls, awaits and transactions (source shape)", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/activities/agent-turn/stream-attempt.ts"),
      "utf8",
    );
    // Each instrumented call is still awaited exactly once, through the timer, with the same function.
    for (const [phase, call] of [
      ["pending_tool_registration", "registerPendingSessionToolCall(db, {"],
      ["pending_result_recording", "recordPendingSessionToolCallResult(db, {"],
      [
        "stable_history_reconciliation",
        "historySink.reconcileConversationTruth({ requireDurable: true })",
      ],
      ["terminal_history_reconciliation", "historySink.reconcileConversationTruth()"],
      ["ensure_run_allowed", "ensureRunAllowed("],
    ] as const) {
      const at = source.indexOf(`toolPathPhases.measure("${phase}"`);
      expect(at).toBeGreaterThan(-1);
      expect(source.indexOf(call, at)).toBeGreaterThan(at);
      expect(source.indexOf(call, at) - at).toBeLessThan(160);
    }
    expect(source).toContain("toolPathPhases.measureTerminal(() =>");
    expect(source).toContain(
      "await toolPathPhases.measureStructuralPublication(() => eventing.batcher!.push(event));",
    );
  });
});

test("real Observability public projection keeps the wall-clock numbers", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const observability = createObservability(testSettings({ observabilityStructuredLogs: true }), {
      component: "worker",
      now: () => 1,
    });
    toolPathPhaseMetricObserver(observability)!({
      phase: "model_response_terminal",
      outcome: "completed",
      startedAtMs: 1_790_000_000_000,
      endedAtMs: 1_790_000_000_123,
      durationMs: 123,
    });
  } finally {
    console.log = original;
  }
  const record = lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((value) => value?.message === "turn.tool_path.phase");
  expect(record).toBeTruthy();
  expect(JSON.stringify(record)).toContain("1790000000000");
  expect(JSON.stringify(record)).toContain("1790000000123");
});
