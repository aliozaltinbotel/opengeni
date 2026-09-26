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
 * its outcome.
 */
export class ToolPathPhaseTimer {
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

  /** A structural created/output publication (the durable append plus its publish), as one phase. */
  async measureStructuralPublication<T>(work: () => Promise<T>): Promise<T> {
    return await this.measure("structural_publication", work);
  }

  /**
   * Inert. The pre/post append-fence split was removed (audit review of b24faac92: a direct publication's fence
   * could replace the structural one, so the split misattributed time); nothing in the worker calls this, and it
   * records nothing, so no fence can be attributed to the wrong publication.
   */
  noteAppendFenceSettled(): void {}
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
