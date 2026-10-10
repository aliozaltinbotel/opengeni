import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { responsesStreamingTerminalError } from "../../../packages/runtime/src/responses-terminal-error";
import { createHash } from "node:crypto";
import { RunRawModelStreamEvent } from "@openai/agents-core";
import { OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE } from "@openai/agents";
import {
  OPENGENI_GATEWAY_MODELS,
  configuredModelListPricingSchedules,
  configuredModelPricingSchedules,
} from "@opengeni/config";
import {
  MODEL_CALL_USAGE_ATTRIBUTES_SCHEMA,
  MODEL_CALL_USAGE_EVENT_TYPE,
  MODEL_CALL_DISPATCH_EVENT_TYPE,
  ModelCallUsageAttributes,
  ModelCallUsageAttributesV1,
  ReadModelCallUsageAttributes,
  MODEL_CALL_USAGE_ATTRIBUTES_SCHEMA_V1,
} from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { normalizeModelCallUsage } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";

import {
  createModelCallUsageSourceHooks,
  createModelResponseEventState,
  createCompactionModelUsageEventState,
  processCompactionModelUsageEvent,
  processModelResponseTerminalEvent,
  recordModelCallUsageEvent,
  recordModelUsageAndDebitCredits,
} from "../src/activities/agent-turn";

// MAINT-P09-430: every provider model call writes ONE authoritative, idempotent
// `model.call` usage row whose attributes carry the call's own facts, on every
// billing path (Cendra's external path included, where model.tokens is not
// written at all and model.cost is a 0 marker). Unknown is null, never 0.

const ACCOUNT = "acct-1";
const WORKSPACE = "ws-1";
const db = {} as Database;
const producedFailedFacts: Array<Record<string, unknown>> = [];
afterAll(async () => {
  const file = process.env.OPENGENI_TEST_FAILED_MODEL_FIXTURE_FILE;
  if (file) await Bun.write(file, JSON.stringify({ producer: "actual provider failure projection through native model terminal writer", events: producedFailedFacts }, null, 2) + "\n");
});

function billedSettings() {
  return testSettings({
    billingMode: "stripe",
    usageLimitsMode: "managed",
    vercelAiGatewayApiKey: "test-gateway-key",
    modelPricingJson: JSON.stringify({
      "gpt-5.6-sol": {
        inputMicrosPerMillionTokens: 4_000_000,
        cachedInputMicrosPerMillionTokens: 400_000,
        cacheWriteMicrosPerMillionTokens: 5_000_000,
        outputMicrosPerMillionTokens: 20_000_000,
        marginBps: 500,
      },
    }),
  });
}

/** Independent derivation of the schedule identity: sha256 over key-sorted JSON. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function captureUsageRows() {
  const rows: Array<Record<string, unknown>> = [];
  const spy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async (_db, input) => {
    rows.push(input as unknown as Record<string, unknown>);
    return undefined as never;
  });
  return { rows, spy };
}

function callRows(rows: Array<Record<string, unknown>>) {
  return rows.filter((row) => row.eventType === MODEL_CALL_USAGE_EVENT_TYPE);
}

describe("model.call usage row", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  test("transport loss preserves unknown dispatch and leaves authentic terminal accounting available", async () => {
    const order: string[] = [];
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());
    const keys = spyOn(opengeniDb, "existingUsageEventIdempotencyKeys").mockImplementation(async (_db, input) => {
      expect(input).toEqual({ accountId: ACCOUNT, workspaceId: WORKSPACE, keys: [
        "usage:model.call.dispatch:turn-1:native-1", "usage:model.call:turn-1:native-1",
      ] });
      return new Set(rows.map(row => row.idempotencyKey as string));
    });
    restores.push(() => keys.mockRestore());
    const claimed = new Set<string>();
    const hooks = createModelCallUsageSourceHooks(db, {
      accountId: ACCOUNT, workspaceId: WORKSPACE, sessionId: "sess-1", turnId: "turn-1",
      turnAttemptId: "attempt-1", callKind: "response", scope: "call", provider: "gateway",
      providerApi: "responses", upstreamProvider: null, model: "gpt-5.6-sol", billingPath: "external",
    }, claimed, async () => { order.push(`authorize:${rows.length}`); });
    await hooks.onDispatchFailure!("native-1");
    expect(rows).toHaveLength(0);
    await hooks.beforeProviderDispatch!("native-1");
    expect(order).toEqual(["authorize:0", "authorize:1"]);
    expect(rows[0]).toMatchObject({ eventType: MODEL_CALL_DISPATCH_EVENT_TYPE, sourceResourceType: "model_dispatch" });
    await hooks.onDispatchFailure!("native-1");
    await hooks.onDispatchFailure!("native-1");
    expect(callRows(rows)).toHaveLength(0);
    expect(claimed.size).toBe(0);
    expect(rows.at(-1)!.attributes).toMatchObject({ outcome: "indeterminate", usageReported: false,
      inputTokens: null, outputTokens: null, totalTokens: null, estimatedProviderCostMicros: null,
      pricingSource: null, priceVersion: null });
  });

  test("transport dispatch refuses ambient transactions and rejected authority before a durable intent", async () => {
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());
    const call = { accountId: ACCOUNT, workspaceId: WORKSPACE, sessionId: "sess-1", turnId: "turn-1",
      turnAttemptId: "attempt-1", callKind: "response" as const, scope: "call" as const, provider: "gateway",
      providerApi: "responses", upstreamProvider: null, model: "gpt-5.6-sol", billingPath: "external" as const };
    const transactional = createModelCallUsageSourceHooks({ rollback() {} } as unknown as Database, call, new Set());
    await expect(transactional.beforeProviderDispatch!("native-1")).rejects.toThrow("MODEL_CALL_DISPATCH_REQUIRES_ROOT_DATABASE");
    const refused = createModelCallUsageSourceHooks(db, call, new Set(), async () => { throw new Error("authority withdrawn"); });
    await expect(refused.beforeProviderDispatch!("native-1")).rejects.toThrow("authority withdrawn");
    expect(rows).toHaveLength(0);
  });

  test("failure receipt refusal does not claim its native key or erase a future exact settlement", async () => {
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());
    const keys = spyOn(opengeniDb, "existingUsageEventIdempotencyKeys").mockResolvedValue(new Set(["usage:model.call.dispatch:turn-1:native-1"]));
    restores.push(() => keys.mockRestore());
    const claimed = new Set<string>();
    const hooks = createModelCallUsageSourceHooks(db, {
      accountId: ACCOUNT, workspaceId: WORKSPACE, sessionId: "sess-1", turnId: "turn-1", turnAttemptId: "attempt-1",
      callKind: "compaction", scope: "call", provider: "gateway", providerApi: "responses",
      upstreamProvider: null, model: "gpt-5.6-sol", billingPath: "external",
    }, claimed);
    spy.mockImplementationOnce(async () => { throw new Error("writer unavailable"); });
    await expect(hooks.onDispatchFailure!("native-1")).rejects.toThrow("writer unavailable");
    expect(claimed.size).toBe(0);
    await hooks.onDispatchFailure!("native-1");
    expect(claimed.has("native-1")).toBe(false);
    expect(callRows(rows)).toHaveLength(0);
    await recordModelCallUsageEvent(db, {
      accountId: ACCOUNT, workspaceId: WORKSPACE, sessionId: "sess-1", turnId: "turn-1", turnAttemptId: "attempt-1",
      sourceKey: "native-1", callKind: "compaction", scope: "call", provider: "gateway", providerApi: "responses",
      upstreamProvider: null, model: "gpt-5.6-sol", billingPath: "external", outcome: "failed",
      billing: { normalizedUsage: normalizeModelCallUsage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
        estimatedProviderCostMicros: null, pricingSource: null, priceVersion: null },
    });
    expect(callRows(rows)).toHaveLength(1);
    expect(callRows(rows)[0]!.idempotencyKey).toBe("usage:model.call:turn-1:native-1");
    expect(callRows(rows)[0]!.attributes).toMatchObject({ outcome: "failed", usageReported: true, inputTokens: 2, totalTokens: 3 });
  });

  test("external list-priced call: one idempotent row with the call's facts and the schedule identity", async () => {
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(
      async () => {
        throw new Error("an externally billed call must never debit credits");
      },
    );
    restores.push(() => debitSpy.mockRestore());
    const settings = billedSettings();

    await recordModelUsageAndDebitCredits(settings, db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
      model: "codex/gpt-5.6-sol",
      provider: "openai",
      providerApi: "responses",
      externallyBilled: true,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokensDetails: { cached_tokens: 200 },
      },
      sourceKey: "response-1",
    });

    const calls = callRows(rows);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call).toMatchObject({
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      eventType: "model.call",
      quantity: 1,
      unit: "call",
      sourceResourceType: "model_response",
      sourceResourceId: "turn-1:response-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      turnAttemptId: "attempt-1",
      idempotencyKey: "usage:model.call:turn-1:response-1",
    });
    const attributes = ModelCallUsageAttributes.parse(call.attributes);
    const schedule = configuredModelPricingSchedules(settings)["gpt-5.6-sol"];
    expect(schedule).toBeDefined();
    expect(attributes).toEqual({
      schema: MODEL_CALL_USAGE_ATTRIBUTES_SCHEMA,
      callKind: "response",
      scope: "call",
      sourceKey: "response-1",
      provider: "openai",
      providerApi: "responses",
      upstreamProvider: null,
      model: "codex/gpt-5.6-sol",
      outcome: "completed",
      usageReported: true,
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 1500,
      estimatedProviderCostMicros: expect.any(Number),
      pricingSource: "configured_list_price",
      priceVersion: `schedule-sha256:${createHash("sha256").update(sortedJson(schedule)).digest("hex")}`,
      billingPath: "external",
    });
    expect(attributes.estimatedProviderCostMicros).toBeGreaterThan(0);
    // Cendra's path: model.tokens is not written (token cap exempt) and model.cost is a 0 marker,
    // so model.call is the only row that carries the call's cost.
    expect(rows.map((row) => row.eventType)).toEqual(["model.call", "model.cost"]);
    expect(rows.find((row) => row.eventType === "model.cost")?.quantity).toBe(0);
  });

  test("a reviewed list-only model names the list schedule that produced its estimate, never the debit schedule", async () => {
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());
    const settings = {
      ...billedSettings(),
      openaiModel: "gpt-6.1-sol",
      openaiAllowedModels: "gpt-6.1-sol",
    };
    // gpt-6.1-sol has a reviewed list price and no configured debit price.
    expect(configuredModelPricingSchedules(settings)["gpt-6.1-sol"]).toBeUndefined();
    const listSchedule = configuredModelListPricingSchedules(settings)["gpt-6.1-sol"];
    expect(listSchedule).toBeDefined();

    await recordModelUsageAndDebitCredits(settings, db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-list-only",
      turnId: "turn-list-only",
      turnAttemptId: "attempt-list-only",
      model: "gpt-6.1-sol",
      externallyBilled: true,
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      sourceKey: "response-list-only",
    });

    const attributes = ModelCallUsageAttributes.parse(callRows(rows)[0]!.attributes);
    expect(attributes).toMatchObject({
      estimatedProviderCostMicros: 7000,
      pricingSource: "configured_list_price",
      priceVersion: `schedule-sha256:${createHash("sha256").update(sortedJson(listSchedule)).digest("hex")}`,
    });
  });

  test("an unpriced model records a null cost, a null pricing source and no schedule, never 0", async () => {
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());

    await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-unpriced",
      turnId: "turn-unpriced",
      turnAttemptId: "attempt-unpriced",
      model: "codex/not-priced",
      provider: "openai",
      providerApi: "responses",
      externallyBilled: true,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      sourceKey: "response-unpriced",
    });

    const [call] = callRows(rows);
    const attributes = ModelCallUsageAttributes.parse(call?.attributes);
    expect(attributes).toMatchObject({
      usageReported: true,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      estimatedProviderCostMicros: null,
      pricingSource: null,
      priceVersion: null,
    });
  });

  test("a call that reported only part of its usage is unpriced and keeps the missing pool null", async () => {
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());

    await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-partial",
      turnId: "turn-partial",
      turnAttemptId: "attempt-partial",
      model: "codex/gpt-5.6-sol",
      provider: "openai",
      providerApi: "responses",
      externallyBilled: true,
      usage: { inputTokens: 100, totalTokens: 100 },
      sourceKey: "response-partial",
    });

    const attributes = ModelCallUsageAttributes.parse(callRows(rows)[0]?.attributes);
    expect(attributes.outputTokens).toBeNull();
    expect(attributes.estimatedProviderCostMicros).toBeNull();
    expect(attributes.pricingSource).toBeNull();
  });

  test("a gateway-reported call carries the gateway cost and endpoint provider, with no schedule", async () => {
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());
    const debitSpy = spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockResolvedValue({
      balance: {
        accountId: ACCOUNT,
        balanceMicros: 1_000_000,
        currency: "usd",
        updatedAt: new Date().toISOString(),
      },
      debitedMicros: 5,
    } as never);
    restores.push(() => debitSpy.mockRestore());

    await recordModelUsageAndDebitCredits(billedSettings(), db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-gateway",
      turnId: "turn-gateway",
      turnAttemptId: "attempt-gateway",
      model: OPENGENI_GATEWAY_MODELS.deepseek.productId,
      provider: "opengeni-gateway",
      providerApi: "responses",
      externallyBilled: false,
      gatewayBilling: { finalProvider: "baseten", inferenceCostUsd: "0.00000325" },
      usage: { inputTokens: 9, outputTokens: 8, totalTokens: 17 },
      sourceKey: "response-gateway",
    });

    const attributes = ModelCallUsageAttributes.parse(callRows(rows)[0]?.attributes);
    expect(attributes).toMatchObject({
      provider: "opengeni-gateway",
      upstreamProvider: "baseten",
      pricingSource: "gateway_reported",
      priceVersion: null,
      billingPath: "opengeni_credits",
      estimatedProviderCostMicros: 4,
    });
  });

  test("the row is durable, never soft-failed: a refused write fails the call's recording", async () => {
    const refusal = new Error("usage store unavailable");
    const spy = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async (_db, input) => {
      if (input.eventType === MODEL_CALL_USAGE_EVENT_TYPE) throw refusal;
      return undefined as never;
    });
    restores.push(() => spy.mockRestore());

    await expect(
      recordModelUsageAndDebitCredits(billedSettings(), db, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        sessionId: "sess-refused",
        turnId: "turn-refused",
        turnAttemptId: "attempt-refused",
        model: "codex/gpt-5.6-sol",
        provider: "openai",
        providerApi: "responses",
        externallyBilled: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        sourceKey: "response-refused",
      }),
    ).rejects.toBe(refusal);
  });

  test("an aggregate fallback with no usage at all records one unknown aggregate row", async () => {
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());

    await recordModelCallUsageEvent(db, {
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-agg",
      turnId: "turn-agg",
      turnAttemptId: "attempt-agg",
      sourceKey: "activity-agg:aggregate",
      callKind: "response",
      scope: "aggregate",
      provider: "openai",
      providerApi: "responses",
      upstreamProvider: null,
      model: "codex/gpt-5.6-sol",
      billingPath: "external",
      billing: null,
    });

    const [call] = callRows(rows);
    expect(call?.idempotencyKey).toBe("usage:model.call:turn-agg:activity-agg:aggregate");
    expect(ModelCallUsageAttributes.parse(call?.attributes)).toMatchObject({
      scope: "aggregate",
      usageReported: false,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      estimatedProviderCostMicros: null,
      pricingSource: null,
      priceVersion: null,
    });
  });

  test("a terminal response without usage commits its unknown call before stream settlement", async () => {
    const { rows, spy } = captureUsageRows();
    restores.push(() => spy.mockRestore());
    const state = createModelResponseEventState();
    const event = new RunRawModelStreamEvent({
      type: "response_done",
      response: { id: "resp-no-usage", output: [] },
    } as never);

    const input: Parameters<typeof processModelResponseTerminalEvent>[0] = {
      event,
      state,
      dispatchId: "activity-no-usage",
      settings: billedSettings(),
      db,
      observability: { info: () => undefined, warn: () => undefined } as never,
      publish: null,
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: "sess-no-usage",
      turnId: "turn-no-usage",
      turnAttemptId: "attempt-no-usage",
      provider: "openai",
      providerApi: "responses",
      model: "codex/gpt-5.6-sol",
      metricProvider: "openai",
      externallyBilled: true,
      servingCredentialId: null,
      priorSessionCredentialId: null,
      emittedSourceKeys: new Set<string>(),
      renewLease: async () => undefined,
      leaseLost: () => false,
      leaseLostMessage: "lease lost",
      setLastInputTokens: async () => undefined,
    };
    const result = await processModelResponseTerminalEvent(input);

    expect(result).toMatchObject({ status: "processed", usageReported: false });
    expect(callRows(rows)).toHaveLength(1);
    expect(ModelCallUsageAttributes.parse(callRows(rows)[0]?.attributes)).toMatchObject({
      sourceKey: "resp-no-usage", scope: "call", outcome: "completed", usageReported: false,
      inputTokens: null, outputTokens: null, totalTokens: null,
      estimatedProviderCostMicros: null, pricingSource: null, priceVersion: null,
    });
    const historic = { ...ModelCallUsageAttributes.parse(callRows(rows)[0]?.attributes), schema: MODEL_CALL_USAGE_ATTRIBUTES_SCHEMA_V1 };
    expect(ReadModelCallUsageAttributes.parse(historic)).toEqual(ModelCallUsageAttributesV1.parse(historic));
    expect(ModelCallUsageAttributesV1.safeParse({ ...historic, outcome: "failed" }).success).toBe(false);
    expect(ModelCallUsageAttributes.safeParse(historic).success).toBe(false);
    expect(state.unreportedSourceKeys).toEqual(["resp-no-usage"]);
    expect(await processModelResponseTerminalEvent(input)).toEqual({
      status: "duplicate", sourceKey: "resp-no-usage",
    });
    expect(callRows(rows)).toHaveLength(1);

    const refusedInput = { ...input, state: createModelResponseEventState() };
    spy.mockImplementationOnce(async () => { throw new Error("usage writer refused"); });
    await expect(processModelResponseTerminalEvent(refusedInput)).rejects.toThrow("usage writer refused");
    expect(refusedInput.state.responseCount).toBe(0);
    expect(refusedInput.state.claimedSourceKeys.size).toBe(0);
    expect(refusedInput.state.unreportedSourceKeys).toEqual([]);
    expect(await processModelResponseTerminalEvent(refusedInput)).toMatchObject({ status: "processed" });

    for (const outcome of ModelCallUsageAttributes.shape.outcome.options.filter(value => value !== "completed")) {
      const providerStatus = outcome === "indeterminate" ? "in_progress" : outcome;
      await processModelResponseTerminalEvent({ ...input,
        state: createModelResponseEventState(),
        event: new RunRawModelStreamEvent({ type: "response_done", response: { id: `resp-${outcome}`, status: providerStatus, output: [] } } as never),
      });
      const outcomeRows = rows.filter(row => row.eventType === (outcome === "indeterminate" ? MODEL_CALL_DISPATCH_EVENT_TYPE : MODEL_CALL_USAGE_EVENT_TYPE));
      expect(ModelCallUsageAttributes.parse(outcomeRows.at(-1)?.attributes)).toMatchObject({
        outcome, usageReported: false, estimatedProviderCostMicros: null, inputTokens: null,
      });
      await processCompactionModelUsageEvent({ ...input, usage: null, outcome,
        nativeSourceKey: `compaction-${outcome}`, state: createCompactionModelUsageEventState(),
      });
      expect(ModelCallUsageAttributes.parse(rows.filter(row => row.eventType === (outcome === "indeterminate" ? MODEL_CALL_DISPATCH_EVENT_TYPE : MODEL_CALL_USAGE_EVENT_TYPE)).at(-1)?.attributes).outcome).toBe(outcome);
    }

    const failure = responsesStreamingTerminalError({ type: "response.failed", response: { id: "provider-failed-usage", status: "failed",
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }, error: { code: "server_error" } } })!;
    const physical = { ...input, accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(), turnAttemptId: crypto.randomUUID(), state: createModelResponseEventState(),
      nativeSourceKey: () => "native-known-failure" };
    await processModelResponseTerminalEvent({ ...physical,
      event: new RunRawModelStreamEvent({ type: "response_done", response: { id: "provider-failed-usage", status: "in_progress", output: [] } } as never) });
    expect(physical.state.claimedSourceKeys.size).toBe(0);
    await processModelResponseTerminalEvent({ ...physical,
      event: { type: "raw_model_stream_event", source: OPENAI_RESPONSES_RAW_MODEL_EVENT_SOURCE,
        data: { type: "model", event: { type: "response.failed", response: failure.terminalResponse } } } as never });
    const physicalRows = rows.filter(row => row.turnId === physical.turnId && [MODEL_CALL_DISPATCH_EVENT_TYPE, MODEL_CALL_USAGE_EVENT_TYPE].includes(row.eventType as string));
    expect(physicalRows.map(row => row.eventType)).toEqual([MODEL_CALL_DISPATCH_EVENT_TYPE, MODEL_CALL_USAGE_EVENT_TYPE]);
    expect(physicalRows[1]!.attributes).toMatchObject({ outcome: "failed", usageReported: true, inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    expect(physical.state.claimedSourceKeys.has("native-known-failure")).toBeTrue();
    producedFailedFacts.push(...physicalRows);

    for (const callKind of ModelCallUsageAttributes.shape.callKind.options.filter(kind => kind === "compaction" || kind === "session_title")) {
      const compactInput: Parameters<typeof processCompactionModelUsageEvent>[0] = {
        ...input, usage: null, nativeSourceKey: `source-${callKind}`,
        state: createCompactionModelUsageEventState(),
        sourceKind: callKind === "session_title" ? "session-title" : "compaction",
      };
      await processCompactionModelUsageEvent(compactInput);
      const persisted = ModelCallUsageAttributes.parse(callRows(rows).at(-1)?.attributes);
      expect(persisted).toMatchObject({ callKind, usageReported: false, estimatedProviderCostMicros: null });
      expect(await processCompactionModelUsageEvent(compactInput)).toMatchObject({ status: "duplicate" });
      await expect(processCompactionModelUsageEvent({ ...compactInput, nativeSourceKey: undefined,
        state: createCompactionModelUsageEventState() })).rejects.toThrow("MODEL_SOURCE_RESPONSE_UNBOUND");
    }
  });
});
