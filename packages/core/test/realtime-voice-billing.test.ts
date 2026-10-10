import { expect, spyOn, test } from "bun:test";
import {
  parseRealtimeVoicePricingJson,
  parseRealtimeVoicePricingTableJson,
  realtimeVoiceMinuteCreditMicros,
  realtimeVoiceStartedMinutes,
} from "@opengeni/config";
import { spendableCreditMicros, VOICE_CREDIT_USAGE } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  createRealtimeVoiceBilling,
  deploymentRealtimeVoice,
  realtimeVoiceOfferProblem,
  voiceCreditStanding,
  voiceInsufficientCreditsMessage,
} from "../src";

test("live voice pricing: strict JSON, margin rounds up, every started minute", () => {
  expect(parseRealtimeVoicePricingJson(undefined)).toBeNull();
  expect(() => parseRealtimeVoicePricingJson("{")).toThrow("must be valid JSON");
  expect(() => parseRealtimeVoicePricingJson('{"microsPerMinute":0}')).toThrow("invalid");
  expect(() => parseRealtimeVoicePricingJson('{"microsPerMinute":1,"extra":1}')).toThrow();
  expect(() => parseRealtimeVoicePricingTableJson('{"m":{"microsPerMinute":-1}}')).toThrow();
  expect(realtimeVoiceMinuteCreditMicros({ microsPerMinute: 50_000, marginBps: 500 })).toEqual({
    providerCostMicros: 50_000,
    creditCostMicros: 52_500,
  });
  expect(realtimeVoiceMinuteCreditMicros({ microsPerMinute: 3, marginBps: 1 })).toEqual({
    providerCostMicros: 3,
    creditCostMicros: 4,
  });
  const start = new Date("2026-10-05T07:00:00.000Z");
  const at = (ms: number) => new Date(start.getTime() + ms);
  expect(realtimeVoiceStartedMinutes(start, start)).toBe(1);
  expect(realtimeVoiceStartedMinutes(start, at(60_000))).toBe(1);
  expect(realtimeVoiceStartedMinutes(start, at(60_001))).toBe(2);
  expect(realtimeVoiceStartedMinutes(start, at(-5_000))).toBe(1);
});

test("only deployment-funded voice is gated; enabled without pricing is unavailable", () => {
  const settings = testSettings({
    billingMode: "stripe",
    vercelAiGatewayApiKey: "key",
    azureLiveEndpoint: "https://voice.example.test",
    azureLiveApiKey: "key",
    azureLivePricingJson: '{"microsPerMinute":50000}',
  });
  for (const model of [
    "gpt-live-1-boulder-alpha",
    "supergrok/grok-voice-think-fast-2.0",
    "workspace-gateway/openai/gpt-realtime-2.1",
  ]) {
    expect(deploymentRealtimeVoice(settings, model)).toBeNull();
  }
  const azure = deploymentRealtimeVoice(settings, "opengeni-azure/gpt-live-1")!;
  expect(azure).toMatchObject({ provider: "azure-live", configured: true });
  expect(realtimeVoiceOfferProblem(settings, azure)).toBeNull();
  const gateway = deploymentRealtimeVoice(settings, "opengeni-gateway/openai/gpt-realtime-mini")!;
  expect(gateway).toMatchObject({ provider: "ai-gateway", configured: true, pricing: null });
  expect(realtimeVoiceOfferProblem(settings, gateway)?.code).toBe("pricing_unconfigured");
  // Without credit billing (self-hosted), a configured provider needs no price.
  const selfHosted = {
    ...settings,
    billingMode: "disabled" as const,
    usageLimitsMode: "none" as const,
  };
  expect(realtimeVoiceOfferProblem(selfHosted, gateway)).toBeNull();
  const unconfigured = deploymentRealtimeVoice(
    { ...settings, azureLiveApiKey: undefined },
    "opengeni-azure/gpt-live-1",
  )!;
  expect(realtimeVoiceOfferProblem(settings, unconfigured)?.code).toBe("not_configured");
  // Malformed pricing withholds the model rather than throwing (no boot failure).
  const malformed = deploymentRealtimeVoice(
    { ...settings, azureLivePricingJson: "{not json" },
    "opengeni-azure/gpt-live-1",
  )!;
  expect(malformed.pricing).toBeNull();
  expect(realtimeVoiceOfferProblem(settings, malformed)?.code).toBe("pricing_unconfigured");
});

test("promotional chat-only credits are named, not reported as no credits", () => {
  expect(voiceCreditStanding({ balanceMicros: 1 })).toBe("spendable");
  expect(voiceCreditStanding({ balanceMicros: 0, promotionalCredits: [] })).toBe("none");
  expect(
    voiceCreditStanding({
      balanceMicros: 0,
      promotionalCredits: [{ remainingMicros: 10_000_000 }],
    }),
  ).toBe("promotional_only");
  expect(voiceInsufficientCreditsMessage("Live voice", "promotional_only")).toBe(
    "Promotional credits don't cover live voice. Add credits to use it.",
  );
  expect(voiceInsufficientCreditsMessage("Voice input", "none")).toBe(
    "Voice input needs Opengeni credits. Add credits to continue.",
  );
});

test("signup credits are spendable for voice; other scoped grants are not", () => {
  const grant = (remainingMicros: number, coversVoice: boolean) => ({
    grantId: crypto.randomUUID(),
    label: coversVoice ? "Signup credits" : "Coupon credits",
    eligibleModelIds: ["gpt-chat-only"],
    remainingMicros,
    coversVoice,
  });
  const balance = {
    accountId: crypto.randomUUID(),
    balanceMicros: 7_000,
    generalBalanceMicros: 0,
    promotionalCredits: [grant(4_000, false), grant(3_000, true)],
    currency: "usd" as const,
    updatedAt: new Date(0).toISOString(),
  };
  expect(spendableCreditMicros(balance, VOICE_CREDIT_USAGE)).toBe(3_000);
  expect(spendableCreditMicros(balance, "gpt-chat-only")).toBe(7_000);
  expect(spendableCreditMicros(balance)).toBe(0);
  expect(
    voiceCreditStanding({
      ...balance,
      balanceMicros: spendableCreditMicros(balance, VOICE_CREDIT_USAGE),
    }),
  ).toBe("spendable");
  const couponOnly = { ...balance, promotionalCredits: [grant(4_000, false)] };
  expect(
    voiceCreditStanding({
      ...couponOnly,
      balanceMicros: spendableCreditMicros(couponOnly, VOICE_CREDIT_USAGE),
    }),
  ).toBe("promotional_only");
});

test("native occurrence is separate from immutable final accounting and remains mandatory with external billing", async () => {
  const database = await import("@opengeni/db");
  const rows: Array<Parameters<typeof database.recordUsageEvent>[1]> = [];
  const writer = spyOn(database, "recordUsageEvent").mockImplementation(async (_db, input) => { rows.push(input); return undefined as never; });
  const sourceReader = spyOn(database, "loadRealtimeSessionUsageSource");
  try {
    const source = {
      connectionId: crypto.randomUUID(), connectionEpoch: 1, provider: "codex-subscription" as const,
      providerSessionId: "rtc_exact_provider_session", providerCredentialId: crypto.randomUUID(),
      model: "gpt-live-1-boulder-alpha", upstreamModel: "gpt-live-1-codex",
    };
    const billing = createRealtimeVoiceBilling({ db: {} as never, settings: testSettings({ billingMode: "disabled", usageLimitsMode: "none" }) });
    await billing.recordProviderSessionOccurrence({ accountId: "account", workspaceId: "workspace", sessionId: "session", source });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "model.realtime.session.observed", unit: "session", attributes: {
      schema: "opengeni.realtime-session-source/v1", providerSessionId: source.providerSessionId, billingPath: "external",
    } });
    expect(rows.some(row => row.eventType === "model.call")).toBe(false);
    const occurredAt = new Date("2026-10-09T23:59:00.000Z");
    sourceReader.mockResolvedValue({ source: { ...source, schema: "opengeni.realtime-session-source/v1", billingPath: "external" }, occurredAt });
    await billing.recordProviderSessionFinal({ accountId: "account", workspaceId: "workspace", sessionId: "session",
      source: { ...source, schema: "opengeni.realtime-session-source/v1", billingPath: "external" }, outcome: "indeterminate" });
    expect(rows[1]).toMatchObject({ eventType: "model.call", occurredAt, attributes: {
      schema: "opengeni.model-call-usage/v2", callKind: "realtime_session", outcome: "indeterminate",
      usageReported: false, totalTokens: null, estimatedProviderCostMicros: null, pricingSource: null,
    } });
    sourceReader.mockResolvedValueOnce(null);
    await expect(billing.recordProviderSessionFinal({ accountId: "account", workspaceId: "workspace", sessionId: "session",
      source: { ...source, schema: "opengeni.realtime-session-source/v1", billingPath: "external" }, outcome: "completed" }))
      .rejects.toThrow("REALTIME_PROVIDER_SOURCE_UNBOUND");
    expect(rows).toHaveLength(2);
    writer.mockImplementationOnce(async () => { throw new Error("receipt unavailable"); });
    await expect(billing.recordProviderSessionOccurrence({ accountId: "account", workspaceId: "workspace", sessionId: "session", source }))
      .rejects.toThrow("receipt unavailable");
  } finally { writer.mockRestore(); sourceReader.mockRestore(); }
});
