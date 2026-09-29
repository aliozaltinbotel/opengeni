// F-2 (Cendra agent-ops): a turn's declared fallback route and budget, as the API accepts them and as the turn freezes
// them in its metadata.
import { describe, expect, test } from "bun:test";
import {
  ClientSessionEvent,
  metadataWithTurnRouteDeclarationV1,
  readTurnRouteDeclarationV1,
  SteerSessionMessageRequest,
  TurnBudgetV1,
  TurnExecutionPolicyV1,
  TurnFallbackRouteRequestV1,
  TurnRouteDeclarationV1,
  TURN_ROUTE_DECLARATION_METADATA_KEY,
  TURN_ROUTE_TERMINAL_REASONS,
} from "../src/index";

const policy = (model: string) =>
  TurnExecutionPolicyV1.parse({
    schemaVersion: 1,
    productModelId: model,
    requestedModelId: model,
    modelSource: "explicit",
    reasoningEffort: "low",
    reasoningSource: "explicit",
    latencyMode: "standard",
    latencyModeSource: "explicit",
    providerId: "openai",
    upstreamModelId: model,
    wireApi: "responses",
    credentialSource: { kind: "deployment", mechanism: "api_key" },
    billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    definitionVersion: `sha256:${"a".repeat(64)}`,
  });

describe("F-2 request fields", () => {
  test("a user message and a steer accept a fallback route and a turn budget", () => {
    const payload = {
      text: "hello",
      model: "gpt-6-sol",
      fallback: { model: "gpt-5.6-terra", reasoningEffort: "low" },
      turnBudget: { maxTotalTokens: 350_000, maxDurationMs: 60_000 },
    };
    const event = ClientSessionEvent.parse({ type: "user.message", payload });
    expect(event.type === "user.message" && event.payload.fallback?.model).toBe("gpt-5.6-terra");
    expect(SteerSessionMessageRequest.parse(payload).turnBudget?.maxDurationMs).toBe(60_000);
  });
  test("a budget names at least one limit, within bounds; a fallback names a model and nothing else", () => {
    expect(TurnBudgetV1.safeParse({}).success).toBe(false);
    expect(TurnBudgetV1.safeParse({ maxModelCalls: 0 }).success).toBe(false);
    expect(TurnBudgetV1.safeParse({ maxTotalTokens: 10 }).success).toBe(false);
    expect(TurnBudgetV1.safeParse({ maxModelCalls: 12 }).success).toBe(true);
    expect(TurnFallbackRouteRequestV1.safeParse({ model: "" }).success).toBe(false);
    expect(TurnFallbackRouteRequestV1.safeParse({ model: "x", provider: "y" }).success).toBe(false);
  });
});

describe("F-2 turn metadata", () => {
  test("absent is legacy; a valid declaration round-trips beside other metadata", () => {
    expect(readTurnRouteDeclarationV1(null)).toEqual({ kind: "absent" });
    expect(readTurnRouteDeclarationV1({ dispatchRevision: 2 })).toEqual({ kind: "absent" });
    const declaration = TurnRouteDeclarationV1.parse({
      schemaVersion: 1,
      fallbackPolicy: policy("gpt-5.6-terra"),
      turnBudget: { maxTotalTokens: 350_000 },
    });
    expect(declaration.executed).toBe("primary");
    const metadata = metadataWithTurnRouteDeclarationV1({ dispatchRevision: 2 }, declaration);
    expect(metadata.dispatchRevision).toBe(2);
    expect(readTurnRouteDeclarationV1(metadata)).toEqual({ kind: "valid", declaration });
  });
  test("a malformed present declaration fails closed and never echoes the value", () => {
    expect(() =>
      readTurnRouteDeclarationV1({ [TURN_ROUTE_DECLARATION_METADATA_KEY]: { schemaVersion: 2, secret: "sk-live" } }),
    ).toThrow(/^Malformed turn route declaration metadata at /u);
    try {
      readTurnRouteDeclarationV1({ [TURN_ROUTE_DECLARATION_METADATA_KEY]: { schemaVersion: 2, secret: "sk-live" } });
    } catch (error) {
      expect(String(error)).not.toContain("sk-live");
    }
  });
  test("a fallback run names its refusal and requires a declared fallback; a primary run carries none", () => {
    const base = { schemaVersion: 1, fallbackPolicy: policy("gpt-5.6-terra"), turnBudget: null };
    expect(TurnRouteDeclarationV1.safeParse({ ...base, executed: "fallback" }).success).toBe(false);
    expect(
      TurnRouteDeclarationV1.safeParse({ ...base, executed: "fallback", fallbackReason: "model_not_found" }).success,
    ).toBe(true);
    expect(
      TurnRouteDeclarationV1.safeParse({ ...base, fallbackPolicy: null, executed: "fallback", fallbackReason: "x" })
        .success,
    ).toBe(false);
    expect(TurnRouteDeclarationV1.safeParse({ ...base, fallbackReason: "x" }).success).toBe(false);
  });
  test("the terminal reasons are named", () => {
    expect([...TURN_ROUTE_TERMINAL_REASONS]).toEqual([
      "TURN_BUDGET_EXHAUSTED",
      "PRIMARY_REFUSED_FALLBACK_RAN",
      "PRIMARY_REFUSED_NO_FALLBACK",
      "PRIMARY_REFUSED_AFTER_OUTPUT",
      "FALLBACK_REFUSED",
    ]);
  });
});
