import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import * as runInput from "../src/activities/run-input";
import * as openSuffix from "../src/activities/open-suffix-resume";
import * as admission from "../src/activities/agent-turn/admission";
import { runTurnStreamAttempt } from "../src/activities/agent-turn/stream-attempt";

// A parallel tool batch reaches the consumer as N adjacent `tool_called` items
// (the SDK streams them before it executes the batch) and, after execution, N
// adjacent `tool_output` items. The consumer persists the batch, not each event:
// one atomic registration + `created` append and one atomic result + `output`
// append. The existing publish mutation owns the receipt and timeline together;
// authoritative history retirement and foreground release follow durable output.

const CALLS = ["call_a", "call_b", "call_c", "call_d"] as const;

function harness(
  calls: readonly string[] = CALLS,
  options: { stream?: unknown; appendDelayMs?: number } = {},
) {
  const order: string[] = [];
  const appended: Array<{ type: string; id: string | undefined; occurredAt: unknown; appendedAt: number }> = [];
  const publishes: Array<string[]> = [];
  const finalizations: Array<readonly string[] | undefined> = [];
  const registrationTransactions: string[][] = [];
  const stopped = new Error("stream ended by the fixture");
  const settings = testSettings({ sandboxBackend: "none", billingMode: "disabled", usageLimitsMode: "none" });
  const checkpoint = [{ type: "message", role: "user", content: "Run four parallel reads" }];
  const spies: Array<{ mockRestore(): void }> = [
    spyOn(runInput, "turnInput").mockResolvedValue({
      input: { input: checkpoint },
      persistedHistoryCount: checkpoint.length,
      providerArtifactCandidates: { knownHistoryItemIds: [], historyItemIds: [] },
    } as Awaited<ReturnType<typeof runInput.turnInput>>),
    spyOn(openSuffix, "settleOpenSuffixResumeIfNeeded").mockResolvedValue({
      action: "continue",
    } as Awaited<ReturnType<typeof openSuffix.settleOpenSuffixResumeIfNeeded>>),
    spyOn(admission, "ensureRunAllowedBetweenModelCalls").mockResolvedValue(),
    spyOn(db, "nextSessionHistoryPosition").mockResolvedValue(2),
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "listTurnCodemodeApprovals").mockResolvedValue([]),
    spyOn(db, "sessionTurnHasFinalReplyNudge").mockResolvedValue(false),
    spyOn(db, "registerPendingSessionToolCallInTransaction").mockImplementation(async (_db, input) => {
      registrationTransactions.push([input.callId]);
      order.push(`register:${input.callId}`);
      return { accepted: true, registered: true };
    }),
    spyOn(db, "recordPendingSessionToolCallResultInTransaction").mockImplementation(async (_db, input) => {
      order.push(`receipt:${input.callId}`);
      return { accepted: true, recorded: true };
    }),
    spyOn(db, "clearDurablePendingSessionToolCalls").mockImplementation(async (_db, input) => {
      order.push(`clear:${[...input.callIds].join(",")}`);
      return { accepted: true } as Awaited<ReturnType<typeof db.clearDurablePendingSessionToolCalls>>;
    }),
  ];
  const metric = { record() {}, observe() {}, add() {}, inc() {}, set() {} };
  const stream = options.stream ?? {
    completed: Promise.resolve(),
    error: null,
    toStream: () => ({
      async *[Symbol.asyncIterator]() {
        for (const callId of calls) {
          yield {
            type: "run_item_stream_event",
            item: { type: "tool_call_item", rawItem: { type: "function_call", callId, name: "command", arguments: "{}" } },
          };
        }
        for (const callId of calls) {
          yield {
            type: "run_item_stream_event",
            item: {
              type: "tool_call_output_item",
              rawItem: { type: "function_call_result", callId, output: { type: "text", text: `result ${callId}` } },
              output: { type: "text", text: `result ${callId}` },
            },
          };
        }
        throw stopped;
      },
    }),
  };
  const run = () =>
    runTurnStreamAttempt({
      input: { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), attemptId: crypto.randomUUID() },
      settings,
      runSettings: settings,
      db: {} as db.Database,
      runtime: { runStream: async () => stream },
      observability: {
        metrics: { histogram: () => metric, counter: () => metric, gauge: () => metric },
        observeHistogram() {},
        incrementCounter() {},
        info() {},
        warn() {},
        debug() {},
      },
      attempt: { turnId: crypto.randomUUID(), executionGeneration: 1 },
      turn: { id: crypto.randomUUID(), executionGeneration: 1, model: "scripted-model" },
      turnExecutionPolicy: { providerId: "openai" },
      trigger: { type: "user.message" },
      eventing: {
        modelRunSettings: settings,
        toolCancellationFenceRef: { current: null },
        firstModelRequestPreparationRecorded: true,
        publish: async (events: Array<{ type: string; payload?: { id?: string }; occurredAt?: unknown }>, _immediate: boolean, mutate?: db.SessionEventMutation) => {
          if (mutate) {
            const prior = registrationTransactions.length;
            await mutate({} as db.Database, { allowed: true } as Parameters<db.SessionEventMutation>[1]);
            const group = registrationTransactions.splice(prior).flat();
            if (group.length) registrationTransactions.push(group);
          }
          const tools = events.filter((event) => event.type.startsWith("agent.toolCall."));
          if (tools.length === 0) return;
          if (options.appendDelayMs) await new Promise((resolve) => setTimeout(resolve, options.appendDelayMs));
          for (const event of tools) {
            appended.push({ type: event.type, id: event.payload?.id, occurredAt: event.occurredAt, appendedAt: Date.now() });
          }
          publishes.push(tools.map((event) => `${event.type.slice("agent.toolCall.".length)}:${event.payload?.id}`));
          order.push(`publish:${tools.map((event) => `${event.type.slice("agent.toolCall.".length)}:${event.payload?.id}`).join(",")}`);
        },
      },
      historySink: {
        seedHistory() {},
        reconcileConversationTruth: async () => { order.push("history"); },
      },
      billingState: { isCodexTurn: false },
      providerTurn: {},
      sandboxState: {},
      leases: { codex: { lost: false }, xai: { lost: false } },
      media: {
        retainedScreenshotReceiptsByCallId: new Map(),
        retainedSessionImageCallIds: new Set(),
        retainedSessionImageKindsByCallId: new Map(),
      },
      videoGenerationAcceptancesByCallId: new Map(),
      generatedImageHistoryProjector: async (items: unknown) => items,
      claimedModelUsageSourceKeys: new Set(),
      runtimeCancellationSignal: new AbortController().signal,
      activityContext: null,
      workerPreparationStartedAt: performance.now(),
      groupBoxBackend: "none",
      agent: {},
      turnTools: [],
      throwIfWorkerShuttingDown() {},
      throwIfTurnCancelled() {},
      recordCompanyBrainContributionReceiptOnce() {},
      withProviderRequestContext: async (operation: () => Promise<unknown>) => operation(),
      beforeModelCallSourceReceipt: async () => "source-key",
      finalizeTurnOpStreamOps: async (callIds?: readonly string[]) => {
        order.push(`finalize:${[...(callIds ?? [])].join(",")}`);
        finalizations.push(callIds);
      },
    } as unknown as Parameters<typeof runTurnStreamAttempt>[0]);
  return { appended, order, publishes, finalizations, registrationTransactions, stopped, run, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

test("a parallel tool batch is registered in one transaction and published in one append per phase", async () => {
  const h = harness();
  try {
    await expect(h.run()).rejects.toBe(h.stopped);
    expect(h.registrationTransactions).toEqual([[...CALLS]]);
    expect(h.publishes).toEqual([
      CALLS.map((id) => `created:${id}`),
      CALLS.map((id) => `output:${id}`),
    ]);
  } finally {
    h.restore();
  }
});

test("every call is registered before any created event, every receipt precedes the output append, and release follows it", async () => {
  const h = harness();
  try {
    await expect(h.run()).rejects.toBe(h.stopped);
    const createdAt = h.order.findIndex((entry) => entry.startsWith("publish:created"));
    const outputAt = h.order.findIndex((entry) => entry.startsWith("publish:output"));
    for (const id of CALLS) {
      expect(h.order.indexOf(`register:${id}`)).toBeGreaterThan(-1);
      expect(h.order.indexOf(`register:${id}`)).toBeLessThan(createdAt);
      expect(h.order.indexOf(`receipt:${id}`)).toBeGreaterThan(createdAt);
      expect(h.order.indexOf(`receipt:${id}`)).toBeLessThan(outputAt);
    }
    // The committed outputs precede authoritative history retirement and release.
    expect(h.order.lastIndexOf("history")).toBeGreaterThan(outputAt);
    expect(h.order.slice(outputAt + 1)).toEqual(["history", `finalize:${CALLS.join(",")}`]);
    expect(h.finalizations).toEqual([[...CALLS]]);
  } finally {
    h.restore();
  }
});

test("a single call keeps one registration, one created append and one output append", async () => {
  const h = harness(["call_only"]);
  try {
    await expect(h.run()).rejects.toBe(h.stopped);
    expect(h.registrationTransactions).toEqual([["call_only"]]);
    expect(h.publishes).toEqual([["created:call_only"], ["output:call_only"]]);
    expect(h.finalizations).toEqual([["call_only"]]);
  } finally {
    h.restore();
  }
});

/** An SDK-shaped run result: items reach the consumer only through `_addItem`. */
function sdkRunResult() {
  let controller!: ReadableStreamDefaultController<unknown>;
  const readable = new ReadableStream<unknown>({ start: (c) => { controller = c; } });
  return {
    completed: Promise.resolve(),
    error: null,
    _addItem(item: unknown) { controller.enqueue(item); },
    _raiseError(error: unknown) { controller.error(error); },
    toStream: () => readable,
  };
}

test("created/output occurredAt bracket the SDK's own execution of the batch, not the slow appends", async () => {
  const sdk = sdkRunResult();
  const h = harness(CALLS, { stream: sdk, appendDelayMs: 40 });
  const execution = { startedBefore: 0, startedAfter: 0, endedBefore: 0, endedAfter: 0 };
  try {
    const running = h.run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The SDK streams the batch's calls and immediately executes them.
    execution.startedBefore = Date.now();
    for (const callId of CALLS) {
      sdk._addItem({ type: "run_item_stream_event", item: { type: "tool_call_item", rawItem: { type: "function_call", callId, name: "command", arguments: "{}" } } });
    }
    execution.startedAfter = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 120)); // real execution
    execution.endedBefore = Date.now();
    for (const callId of CALLS) {
      sdk._addItem({
        type: "run_item_stream_event",
        item: { type: "tool_call_output_item", rawItem: { type: "function_call_result", callId, output: { type: "text", text: `result ${callId}` } }, output: { type: "text", text: `result ${callId}` } },
      });
    }
    execution.endedAfter = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    sdk._raiseError(h.stopped);
    await expect(running).rejects.toBe(h.stopped);
    expect(h.appended).toHaveLength(CALLS.length * 2);
    for (const id of CALLS) {
      const created = h.appended.find((event) => event.type === "agent.toolCall.created" && event.id === id)!;
      const output = h.appended.find((event) => event.type === "agent.toolCall.output" && event.id === id)!;
      expect(created.occurredAt).toBeInstanceOf(Date);
      expect(output.occurredAt).toBeInstanceOf(Date);
      const createdAt = (created.occurredAt as Date).getTime();
      const outputAt = (output.occurredAt as Date).getTime();
      expect(createdAt).toBeGreaterThanOrEqual(execution.startedBefore);
      expect(createdAt).toBeLessThanOrEqual(execution.startedAfter);
      expect(outputAt).toBeGreaterThanOrEqual(execution.endedBefore);
      expect(outputAt).toBeLessThanOrEqual(execution.endedAfter);
      // Created never follows its output, and both precede their (slower) append.
      expect(createdAt).toBeLessThanOrEqual(outputAt);
      expect(createdAt).toBeLessThan(created.appendedAt);
      expect(outputAt).toBeLessThan(output.appendedAt);
    }
  } finally {
    h.restore();
  }
});

test("events the SDK did not emit through _addItem keep the append time (no explicit occurredAt)", async () => {
  const h = harness(["call_only"]);
  try {
    await expect(h.run()).rejects.toBe(h.stopped);
    expect(h.appended.map((event) => event.occurredAt)).toEqual([undefined, undefined]);
  } finally {
    h.restore();
  }
});
