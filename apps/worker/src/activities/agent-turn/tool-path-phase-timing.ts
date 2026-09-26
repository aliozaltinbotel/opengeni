import type { Observability } from "@opengeni/observability";

/**
 * Per-occurrence timing of the worker's model-response / tool-call persistence path (the wait between a
 * physical MCP call and its durable output publication). Fixed phase names, wall-clock start and end,
 * duration and outcome only: no identifier, SQL, tool name or payload is observed. Observers are inert:
 * a throwing or rejecting observer never changes a return value, an error, an await or a transaction.
 */
export const TOOL_PATH_PHASES = [
  "model_response_terminal",
  "terminal_history_reconciliation",
  "ensure_run_allowed",
  "pending_tool_registration",
  "pending_result_recording",
  "stable_history_reconciliation",
  "structural_publication",
  "structural_append_pre_fence",
  "structural_append_post_fence",
] as const;
export type ToolPathPhase = (typeof TOOL_PATH_PHASES)[number];

export type ToolPathPhaseObservation = {
  phase: ToolPathPhase;
  outcome: "completed" | "failed";
  /** Wall clock (epoch milliseconds). */
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
};
export type ToolPathPhaseObserver = (observation: ToolPathPhaseObservation) => void;

type Clock = { wall: () => number; mono: () => number };
const systemClock: Clock = { wall: () => Date.now(), mono: () => performance.now() };

type Mark = { wall: number; mono: number };

function observeSafely(
  observer: ToolPathPhaseObserver | undefined,
  observation: ToolPathPhaseObservation,
): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(observation) as unknown).catch(() => undefined);
  } catch {
    // Diagnostics are never authoritative for results, errors or ordering.
  }
}

/**
 * One turn attempt's recorder. `measure` awaits exactly the given work and returns or rethrows exactly
 * its outcome. A structural publication additionally splits at the last turn-attempt write fence the
 * append path reports while the publication is in flight (`noteAppendFenceSettled`): the event's own batch
 * is always the final batch of that drain, so its fence is the last one, and the created/output row's
 * `occurredAt` is assigned after it.
 */
export class ToolPathPhaseTimer {
  private structural: { start: Mark; lastFence: Mark | null } | null = null;

  constructor(
    private readonly observer: ToolPathPhaseObserver | undefined,
    private readonly clock: Clock = systemClock,
  ) {}

  private mark(): Mark {
    return { wall: this.clock.wall(), mono: this.clock.mono() };
  }

  private emit(
    phase: ToolPathPhase,
    outcome: ToolPathPhaseObservation["outcome"],
    start: Mark,
    end: Mark,
  ): void {
    observeSafely(this.observer, {
      phase,
      outcome,
      startedAtMs: start.wall,
      endedAtMs: end.wall,
      durationMs: Math.max(0, end.mono - start.mono),
    });
  }

  async measure<T>(phase: ToolPathPhase, work: () => Promise<T>): Promise<T> {
    if (!this.observer) return await work();
    const start = this.mark();
    let outcome: ToolPathPhaseObservation["outcome"] = "failed";
    try {
      const value = await work();
      outcome = "completed";
      return value;
    } finally {
      this.emit(phase, outcome, start, this.mark());
    }
  }

  /** Terminal-event processing, recorded only when the event was processed (or failed). */
  async measureTerminal<T extends { status: string }>(work: () => Promise<T>): Promise<T> {
    if (!this.observer) return await work();
    const start = this.mark();
    let value: T;
    try {
      value = await work();
    } catch (error) {
      this.emit("model_response_terminal", "failed", start, this.mark());
      throw error;
    }
    if (value.status === "processed") {
      this.emit("model_response_terminal", "completed", start, this.mark());
    }
    return value;
  }

  async measureStructuralPublication<T>(work: () => Promise<T>): Promise<T> {
    if (!this.observer) return await work();
    const state = { start: this.mark(), lastFence: null as Mark | null };
    this.structural = state;
    let outcome: ToolPathPhaseObservation["outcome"] = "failed";
    try {
      const value = await work();
      outcome = "completed";
      return value;
    } finally {
      if (this.structural === state) this.structural = null;
      const end = this.mark();
      this.emit("structural_publication", outcome, state.start, end);
      if (state.lastFence) {
        this.emit("structural_append_pre_fence", "completed", state.start, state.lastFence);
        this.emit("structural_append_post_fence", outcome, state.lastFence, end);
      }
    }
  }

  /** Called by the append observer when a turn-attempt write fence phase completes. */
  noteAppendFenceSettled(): void {
    try {
      if (this.structural) this.structural.lastFence = this.mark();
    } catch {
      // A clock failure must not reach the append path.
    }
  }
}

/** Existing observability surface: a closed-label histogram plus one debug record per occurrence. */
export function toolPathPhaseMetricObserver(
  observability: Pick<Observability, "observeHistogram" | "debug"> | null | undefined,
): ToolPathPhaseObserver | undefined {
  if (!observability) return undefined;
  return (observation) => {
    observability.observeHistogram({
      name: "opengeni_turn_tool_path_phase_seconds",
      help: "Per-occurrence duration of one fixed phase between a model response or tool call and its durable output publication.",
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      labels: { phase: observation.phase, outcome: observation.outcome },
      value: Math.max(0, observation.durationMs) / 1_000,
    });
    observability.debug("turn.tool_path.phase", {
      op: observation.phase,
      outcome: observation.outcome,
      startedAtMs: observation.startedAtMs,
      endedAtMs: observation.endedAtMs,
      durationMs: Math.round(observation.durationMs * 1_000) / 1_000,
    });
  };
}
