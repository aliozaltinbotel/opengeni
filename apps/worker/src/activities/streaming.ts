import type { SessionEventType } from "@opengeni/contracts";
import { TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS } from "@opengeni/core";
import type { AppendEventInput } from "@opengeni/db";
import { Context } from "@temporalio/activity";

// Trailing-flush window. A burst of coalesced deltas followed by model silence
// must not sit in `pending` unbounded — without a timer, flush fires only on
// the NEXT push. Matched to the 33ms coalesce window so the client-visible
// latency added by batching is bounded to ~one window (imperceptible, and far
// cheaper than the per-delta DB round-trip it replaces).
const TRAILING_FLUSH_MS = 33;
const MAX_BATCH_EVENTS = 50;
// Keep model ingestion independent from a slow durable append, but never let a
// provider outrun storage without bound. At the high-water mark `push` waits for
// the serialized drain before consuming more provider output.
const MAX_BUFFERED_EVENTS = 1_000;

/** Optional metrics seam for the batcher. `onFlush` fires once per flush (on both
 *  success and failure) with the coalesced event count and the flush duration, so
 *  the worker can meter batch shape without the batcher knowing about Observability.
 *  `now` is injectable for deterministic tests. Both are optional; absent ⇒ no-op. */
export type RuntimeBatcherOptions = {
  onFlush?: (info: { events: number; durationSeconds: number }) => void;
  now?: () => number;
};

export function createRuntimeBatcher(
  flushEvents: (events: AppendEventInput[]) => Promise<void>,
  options: RuntimeBatcherOptions = {},
) {
  const now = options.now ?? (() => performance.now());
  let pending: AppendEventInput[] = [];
  let lastFlush = Date.now();
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let activeBatchSize = 0;
  // One drain loop owns `flushEvents`, so DB-assigned sequence order always
  // matches push order. Ordinary deltas do not await this promise; structural
  // boundaries, explicit flushes, and the bounded high-water mark do.
  let drainPromise: Promise<void> | null = null;
  // A timer has no direct awaiter. Retain its failure so the next push or final
  // flush terminates the turn instead of silently losing streamed evidence.
  let flushFailed = false;
  let flushFailure: unknown;
  // The high-volume token deltas (agent.message.delta, agent.reasoning.delta,
  // sandbox.command.output.delta) are DELIBERATELY NOT here: they coalesce
  // under the 50-event / 33ms policy into one appendSessionEvents txn + one
  // publish per flush, instead of one DB round-trip per token. Only events that
  // must be delivered promptly stay structural (flush-immediately). PTY bytes
  // stay structural on purpose — an interactive terminal is useless batched
  // 33ms behind (P4.4).
  const structural = new Set<SessionEventType>([
    "terminal.pty.output.delta",
    "agent.toolCall.created",
    "agent.toolCall.output",
    "agent.message.completed",
    "tool.auth_needed",
    "credential.auth_needed",
    "session.requiresAction",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
  ]);
  return {
    /**
     * `defer` queues an event for the NEXT structural flush (or explicit flush)
     * without starting a drain or timer, so the adjacent structural events of
     * one parallel tool batch reach storage in one ordered append. A deferred
     * event is not durable when `push` returns; the caller awaits the flushing
     * push before treating it as durable.
     */
    push: async (
      event: { type: SessionEventType; payload: unknown; occurredAt?: Date },
      pushOptions: { defer?: boolean } = {},
    ) => {
      throwIfFlushFailed();
      // Append BEFORE the structural check so a structural event's flush always
      // carries any pending deltas in order (same flush, order preserved).
      // An explicit occurrence time is kept; otherwise storage stamps the append.
      pending.push({
        type: event.type,
        payload: event.payload,
        ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
      });
      if (pushOptions.defer) {
        if (activeBatchSize + pending.length >= MAX_BUFFERED_EVENTS) await flush();
        return;
      }
      const elapsed = Date.now() - lastFlush;
      if (structural.has(event.type)) {
        await flush();
        return;
      }
      if (pending.length >= MAX_BATCH_EVENTS || elapsed >= TRAILING_FLUSH_MS) {
        // Start the serialized drain, but keep consuming provider deltas while
        // the append/publish round-trip is in flight. The active drain records
        // any failure for the next awaited boundary.
        void startDrain().catch(() => undefined);
      }
      if (activeBatchSize + pending.length >= MAX_BUFFERED_EVENTS) {
        await flush();
        return;
      }
      armTrailingTimer();
    },
    flush,
  };

  function armTrailingTimer() {
    if (trailingTimer !== null) {
      return;
    }
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      // A timer has no awaiter, so prevent an unhandled rejection. startDrain
      // retains the exact error and the next push/final flush rethrows it.
      void flush().catch(() => undefined);
    }, TRAILING_FLUSH_MS);
    if ("unref" in trailingTimer && typeof trailingTimer.unref === "function") {
      trailingTimer.unref();
    }
  }

  function clearTrailingTimer() {
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
  }

  async function flush(): Promise<void> {
    throwIfFlushFailed();
    clearTrailingTimer();
    await startDrain();
    throwIfFlushFailed();
  }

  function startDrain(): Promise<void> {
    if (drainPromise) {
      return drainPromise;
    }
    if (flushFailed) {
      return Promise.reject(flushFailure);
    }
    if (pending.length === 0) {
      return Promise.resolve();
    }
    clearTrailingTimer();
    const running = (async () => {
      while (pending.length > 0) {
        const events = pending.splice(0, MAX_BATCH_EVENTS);
        activeBatchSize = events.length;
        lastFlush = Date.now();
        const startedAt = now();
        try {
          await flushEvents(events);
        } catch (error) {
          flushFailed = true;
          flushFailure = error;
          throw error;
        } finally {
          activeBatchSize = 0;
          if (options.onFlush) {
            try {
              options.onFlush({
                events: events.length,
                durationSeconds: Math.max(0, (now() - startedAt) / 1000),
              });
            } catch {
              // Metrics emission must never affect a flush.
            }
          }
        }
      }
    })();
    drainPromise = running.finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  function throwIfFlushFailed(): void {
    if (flushFailed) {
      throw flushFailure;
    }
  }
}

export function currentActivityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}

export function startActivityHeartbeat(
  context: Context | null,
  details: Record<string, unknown>,
  schedule: typeof setInterval = setInterval,
): ReturnType<typeof setInterval> | null {
  if (!context) {
    return null;
  }
  const timer = schedule(() => {
    context.heartbeat({ ...details, at: new Date().toISOString() });
  }, TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS);
  if ("unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

/**
 * Record when the Agents SDK emits each stream event, by wrapping the run
 * result's `_addItem` (the one funnel through which the SDK enqueues every
 * event). The SDK streams a batch's `tool_called` items immediately before it
 * executes the batch and its outputs immediately after, so these times are the
 * batch's own execution start and end, independent of how far the consumer lags
 * behind. A result without that funnel yields no times (callers then keep the
 * append time).
 */
export function observeStreamEmissionTimes(stream: unknown): (event: unknown) => Date | undefined {
  const emitted = new WeakMap<object, Date>();
  const result = stream as { _addItem?: unknown } | null;
  if (result && typeof result._addItem === "function") {
    const add = (result._addItem as (item: unknown) => void).bind(result);
    result._addItem = (item: unknown) => {
      if (item && typeof item === "object") emitted.set(item, new Date());
      add(item);
    };
  }
  return (event) => (event && typeof event === "object" ? emitted.get(event) : undefined);
}

/**
 * A stream reader that can take, without waiting, the events the producer has
 * already queued. The SDK streams a parallel tool batch's N items adjacently
 * (its `tool_called` items before it executes the batch, its outputs after),
 * so the consumer can persist the batch as a unit. Draining never waits for the
 * producer: a read that is not already settled when the event loop next turns
 * is kept and becomes the reader's next read, never a second read on top of it.
 *
 * A ReadableStream is read through its own reader, so `cancel()` cancels the
 * producer at once even while such a read is pending (an async iterator's
 * `return()` would wait behind that read).
 */
export function createStreamLookahead<T>(source: ReadableStream<T> | AsyncIterable<T>, context: Context | null) {
  const reader =
    typeof (source as ReadableStream<T>).getReader === "function"
      ? (source as ReadableStream<T>).getReader()
      : null;
  const iterator = reader ? null : (source as AsyncIterable<T>)[Symbol.asyncIterator]();
  const read = (): Promise<IteratorResult<T>> =>
    reader
      ? (reader.read() as Promise<IteratorResult<T>>)
      : Promise.resolve(iterator!.next());
  const source$ = { next: read };
  const buffered: T[] = [];
  let pendingRead: Promise<IteratorResult<T>> | null = null;
  const notReady: unique symbol = Symbol("not-ready");
  return {
    async next(): Promise<IteratorResult<T>> {
      if (buffered.length > 0) {
        const signal = context?.cancellationSignal;
        if (signal?.aborted) throw signal.reason;
        return { done: false, value: buffered.shift()! };
      }
      if (pendingRead) {
        const kept = pendingRead;
        pendingRead = null;
        return await nextStreamEvent({ next: () => kept }, context);
      }
      return await nextStreamEvent(source$, context);
    },
    /** The next already-taken event, if any, without consuming it. */
    peek(): T | undefined {
      return buffered[0];
    },
    /** Take every already-queued event into the buffer; returns the buffer (read-only). */
    async drainReady(limit = 256): Promise<readonly T[]> {
      while (!pendingRead && buffered.length < limit) {
        let attempt: Promise<IteratorResult<T>>;
        try {
          attempt = read();
        } catch (error) {
          attempt = Promise.reject(error);
        }
        const settled = await Promise.race([
          attempt.then(
            (result) => result,
            () => notReady,
          ),
          new Promise<typeof notReady>((resolve) => setImmediate(() => resolve(notReady))),
        ]);
        if (typeof settled === "symbol" || settled.done) {
          // Not yet produced, finished or failed: the reader's next read settles it in order.
          pendingRead = attempt;
          break;
        }
        buffered.push(settled.value);
      }
      return buffered;
    },
    /** Cancel the producer; never waits behind a pending lookahead read. */
    async cancel(): Promise<void> {
      if (reader) await reader.cancel();
      else await iterator!.return?.();
    },
  };
}

export async function nextStreamEvent<T>(
  iterator: AsyncIterator<T>,
  context: Context | null,
): Promise<IteratorResult<T>> {
  if (!context) {
    return await iterator.next();
  }
  const signal = context.cancellationSignal;
  if (signal.aborted) {
    throw signal.reason;
  }

  // Context.cancelled never settles for a normally completed activity. Racing
  // every token/event read against that lifetime promise leaves one losing
  // Promise reaction attached for every event until the Context itself dies.
  // Use the equivalent Temporal AbortSignal and remove each listener as soon as
  // the iterator wins, so a long stream retains at most its one pending read.
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => settle(() => reject(signal.reason));

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let next: PromiseLike<IteratorResult<T>>;
    try {
      next = iterator.next();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    void Promise.resolve(next).then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
}
