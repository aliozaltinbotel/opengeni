import { afterEach, expect, spyOn, test } from "bun:test";
import * as database from "@opengeni/db";
import { REALTIME_SESSION_SOURCE_SCHEMA, RealtimeSessionUsageSource } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { createRealtimeUsageActivities, observeRealtimeSession } from "../src/activities/realtime-usage";
import type { ControlActivityServices } from "../src/activities/types";
import * as workflowRuntime from "@temporalio/workflow";
import { realtimeUsageWorkflow } from "../src/workflows/realtime-usage";

const ref = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), connectionId: crypto.randomUUID() };
const source = RealtimeSessionUsageSource.parse({ schema: REALTIME_SESSION_SOURCE_SCHEMA, connectionId: ref.connectionId,
  connectionEpoch: 1, provider: "azure-live", providerSessionId: "live-session", providerCredentialId: null,
  model: "opengeni-azure/gpt-live-1", upstreamModel: "gpt-live-1", billingPath: "external" });
const occurredAt = new Date("2026-10-09T23:59:59Z");
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
function service() {
  return async () => ({ db: {} as never, settings: testSettings({ azureLiveEndpoint: "https://voice.example.test", azureLiveApiKey: "fixture" }) }) as ControlActivityServices;
}
function bindSource(keys: string[] = []) {
  spies.push(spyOn(database, "loadRealtimeSessionUsageSource").mockResolvedValue({ source, occurredAt }));
  spies.push(spyOn(database, "existingUsageEventIdempotencyKeys").mockResolvedValue(new Set(keys)));
}

test("observer transport failure retains open accounting and never invents zero usage", async () => {
  bindSource();
  const write = spyOn(database, "recordUsageEvent").mockResolvedValue({} as never); spies.push(write);
  const activity = createRealtimeUsageActivities(service(), { observe: async input => {
    expect(input.url).toBe("wss://voice.example.test/openai/v1/live/sessions/live-session/attach");
    expect(input.previouslyAttached).toBeFalse();
    return { action: "waiting" };
  } });
  expect(await activity.observeRealtimeSessionUsage(ref)).toEqual({ action: "waiting", delayMs: 30_000 });
  expect(write).not.toHaveBeenCalled();
});

test("uncertain close leaves final key free; a later trusted final preserves exact occurrence time", async () => {
  bindSource();
  const write = spyOn(database, "recordUsageEvent").mockResolvedValue({} as never); spies.push(write);
  let finalObserved = false;
  const activity = createRealtimeUsageActivities(service(), { observe: async input => {
    if (!finalObserved) await input.onAttached();
    return { action: "closed", outcome: finalObserved ? "completed" : "indeterminate" };
  } });
  expect(await activity.observeRealtimeSessionUsage(ref)).toEqual({ action: "waiting", delayMs: 30_000 });
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]![1].eventType).toBe("model.realtime.session.attached");
  finalObserved = true;
  expect(await activity.observeRealtimeSessionUsage(ref)).toEqual({ action: "terminal" });
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1]![1]).toMatchObject({ occurredAt,
    idempotencyKey: `usage:model.call:realtime:${ref.connectionId}`,
    attributes: { outcome: "completed", usageReported: false, inputTokens: null, outputTokens: null,
      totalTokens: null, estimatedProviderCostMicros: null, pricingSource: null, priceVersion: null } });
});

test("the actual workflow waits after uncertain accounting and observes a later final exactly once", async () => {
  bindSource();
  const write = spyOn(database, "recordUsageEvent").mockResolvedValue({} as never); spies.push(write);
  let observations = 0;
  const activity = createRealtimeUsageActivities(service(), { observe: async input => {
    observations++;
    if (observations === 1) await input.onAttached();
    return { action: "closed", outcome: observations === 1 ? "indeterminate" : "completed" };
  } });
  spies.push(spyOn(workflowRuntime, "proxyActivities").mockReturnValue(activity));
  const sleep = spyOn(workflowRuntime, "sleep").mockImplementation(async delay => {
    expect(delay).toBe(30_000);
    expect(observations).toBe(1);
    expect(write.mock.calls.map(call => call[1].eventType)).toEqual(["model.realtime.session.attached"]);
  }); spies.push(sleep);
  const continuation = spyOn(workflowRuntime, "continueAsNew"); spies.push(continuation);
  await realtimeUsageWorkflow({ ...ref, baseTaskQueue: "realtime-observer-test" });
  expect(observations).toBe(2);
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(continuation).not.toHaveBeenCalled();
  expect(write.mock.calls.filter(call => call[1].eventType === "model.call")).toHaveLength(1);
  expect(write.mock.calls[1]![1]).toMatchObject({ occurredAt,
    idempotencyKey: `usage:model.call:realtime:${ref.connectionId}`, attributes: { outcome: "completed" } });
});

test("existing final receipt skips provider transport and missing source refuses it", async () => {
  bindSource([`usage:model.call:realtime:${ref.connectionId}`]);
  const activity = createRealtimeUsageActivities(service(), { observe: async () => { throw new Error("provider must not run"); } });
  expect(await activity.observeRealtimeSessionUsage(ref)).toEqual({ action: "terminal" });
  spies.push(spyOn(database, "loadRealtimeSessionUsageSource").mockResolvedValue(null));
  await expect(activity.observeRealtimeSessionUsage(ref)).rejects.toThrow("REALTIME_PROVIDER_SOURCE_UNBOUND");
});

test("provider final event survives socket close while attachment receipt commits", async () => {
  let acknowledge!: () => void;
  const attached = new Promise<void>(resolve => { acknowledge = resolve; });
  class Socket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    close() {}
    constructor() { queueMicrotask(() => {
      this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: "session.closed", reason: "remote_hangup" }) });
      this.onclose?.(); acknowledge();
    }); }
  }
  spies.push(spyOn(globalThis, "WebSocket").mockImplementation((() => new Socket()) as never));
  expect(await observeRealtimeSession({ url: "wss://voice.example.test", headers: {}, source, previouslyAttached: false,
    heartbeat: () => {}, onAttached: () => attached })).toEqual({ action: "closed", outcome: "completed" });
});

test("initial Codex absence cannot close accounting; confirmed attachment requires actual HTTP status", async () => {
  class Socket {
    onerror: (() => void) | null = null;
    close() {}
    constructor() { queueMicrotask(() => this.onerror?.()); }
  }
  spies.push(spyOn(globalThis, "WebSocket").mockImplementation((() => new Socket()) as never));
  const read = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 410 })); spies.push(read);
  const input = { url: "wss://api.openai.com/v1/live/exact-call", headers: {},
    source: { ...source, provider: "codex-subscription" as const }, heartbeat: () => {}, onAttached: async () => {} };
  expect(await observeRealtimeSession({ ...input, previouslyAttached: false })).toEqual({ action: "waiting" });
  expect(read).not.toHaveBeenCalled();
  expect(await observeRealtimeSession({ ...input, previouslyAttached: true })).toEqual({ action: "closed", outcome: "indeterminate" });
  read.mockResolvedValue(new Response(null, { status: 401 }));
  expect(await observeRealtimeSession({ ...input, previouslyAttached: true })).toEqual({ action: "waiting" });
});
