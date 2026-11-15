import { expect, test } from "bun:test";
import type { ResolvedModelProvider } from "@opengeni/config";
import { generateSessionTitle } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import OpenAI from "openai";
import { SessionTitleResponse } from "../src/activities/session-title-route";

test("retained title usage preserves every billing field", () => {
  const value = {
    title: "Harbor lighting history",
    usage: {
      responseId: "response-fixture",
      serviceTier: "priority",
      webSearchRequests: 2,
      gatewayBilling: { finalProvider: "fixture", inferenceCostUsd: "0.00032" },
      usage: {
        inputTokens: 50,
        outputTokens: 12,
        totalTokens: 62,
        inputTokensDetails: [{ cached_tokens: 23 }],
        outputTokensDetails: { reasoning_tokens: 2 },
        requestUsageEntries: [
          {
            input_tokens: 50,
            output_tokens: 12,
            total_tokens: 62,
            input_tokens_details: { cached_tokens: 23 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        ],
      },
    },
  };
  expect(SessionTitleResponse.parse(value)).toEqual(value);
  expect(SessionTitleResponse.parse({ title: null, usage: null })).toEqual({
    title: null,
    usage: null,
  });
  expect(() =>
    SessionTitleResponse.parse({ ...value, usage: { usage: { inputTokens: Infinity } } }),
  ).toThrow();
});

test("a Responses title generated with nested cache-write usage is retained with its counts", async () => {
  // Live Responses shape since 2026-11-15 (openai@7.57.0 InputTokensDetails.CacheWriteTokensDetails).
  const usage = {
    input_tokens: 90,
    output_tokens: 6,
    total_tokens: 96,
    input_tokens_details: {
      cached_tokens: 64,
      cache_write_tokens: 26,
      cache_write_tokens_details: { ttl_12h_tokens: 0, ttl_30m_tokens: 26 },
    },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const client = new OpenAI({
    apiKey: "fixture",
    maxRetries: 0,
    fetch: async () =>
      new Response(
        JSON.stringify({
          id: "resp-title",
          object: "response",
          created_at: 1_763_200_000,
          status: "completed",
          model: "fixture",
          output: [
            {
              type: "message",
              id: "msg-title",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "Harbor lighting history", annotations: [] }],
            },
          ],
          usage,
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const provider = {
    id: "openai",
    label: "OpenAI",
    api: "responses",
    kind: "api-key",
    wireProfile: "openai",
    builtin: true,
  } as ResolvedModelProvider;
  const result = await generateSessionTitle(
    testSettings({ sandboxBackend: "none" }),
    "When did the harbor lights change?",
    { client, provider, modelName: "fixture" },
  );
  const retained = SessionTitleResponse.parse(result);
  expect(retained.title).toBe("Harbor lighting history");
  expect(retained.usage?.usage).toEqual({
    inputTokens: 90,
    outputTokens: 6,
    totalTokens: 96,
    inputTokensDetails: { cached_tokens: 64, cache_write_tokens: 26 },
    outputTokensDetails: { reasoning_tokens: 0 },
  });
});
