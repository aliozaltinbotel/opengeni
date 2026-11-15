import { describe, expect, test } from "bun:test";
import {
  Agent,
  Runner,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import OpenAI from "openai";
import { OpenGeniResponsesModel } from "../src/model-provider-routing";
import { modelResponseUsageFromResponse } from "../src/run-events";
import { runSingleModelCall } from "../src/single-model-call";
import { normalizeModelCallUsage } from "../src/usage-telemetry";

// The Responses API began returning a nested cache-write breakdown inside
// `usage.input_tokens_details` (openai@7.57.0 InputTokensDetails
// .CacheWriteTokensDetails). The pinned Agents SDK copied the provider details
// into Usage unchanged and its stream schema accepts numbers only, so every
// streamed turn failed after the model had already answered.
// `reasoning_tokens_details` is a hypothetical future nested member: the
// boundary keeps numeric members whatever the provider adds next.
const PROVIDER_USAGE = {
  input_tokens: 1200,
  output_tokens: 40,
  total_tokens: 1240,
  input_tokens_details: {
    cached_tokens: 800,
    cache_write_tokens: 250,
    cache_write_tokens_details: { ttl_12h_tokens: 0, ttl_30m_tokens: 250 },
  },
  output_tokens_details: {
    reasoning_tokens: 12,
    reasoning_tokens_details: { summary_tokens: 3 },
  },
} as const;
const NUMERIC_INPUT_DETAILS = { cached_tokens: 800, cache_write_tokens: 250 };
const NUMERIC_OUTPUT_DETAILS = { reasoning_tokens: 12 };

const ANSWER = "The harbor lights are on.";
const OUTPUT_ITEM = {
  type: "message",
  id: "msg_fixture",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text: ANSWER, annotations: [] }],
};

function completedResponse(): Record<string, unknown> {
  return {
    id: "resp_fixture",
    object: "response",
    created_at: 1_763_200_000,
    status: "completed",
    model: "fixture",
    output: [OUTPUT_ITEM],
    usage: structuredClone(PROVIDER_USAGE),
  };
}

function sse(events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** An OpenAI client whose transport answers like the live Responses API. */
function responsesClient(): OpenAI {
  return new OpenAI({
    apiKey: "fixture",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
      if (body.stream !== true) {
        return new Response(JSON.stringify(completedResponse()), {
          headers: { "content-type": "application/json" },
        });
      }
      const response = completedResponse();
      return sse([
        {
          type: "response.created",
          sequence_number: 0,
          response: { ...response, status: "in_progress", output: [], usage: null },
        },
        {
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: { ...OUTPUT_ITEM, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: OUTPUT_ITEM.id,
          output_index: 0,
          content_index: 0,
          delta: ANSWER,
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: OUTPUT_ITEM,
        },
        { type: "response.completed", sequence_number: 4, response },
      ]);
    },
  });
}

const OPENAI_PROVIDER = {
  id: "openai",
  label: "OpenAI",
  api: "responses",
  kind: "api-key",
  builtin: true,
} as ResolvedModelProvider;

function productionResponsesAgent(): Agent {
  return new Agent({
    name: "usage-shape",
    instructions: "Answer briefly.",
    model: new OpenGeniResponsesModel(responsesClient(), "fixture", OPENAI_PROVIDER),
  });
}

function expectNumericDetails(usage: Usage): void {
  expect(usage.inputTokens).toBe(1200);
  expect(usage.outputTokens).toBe(40);
  expect(usage.totalTokens).toBe(1240);
  expect(usage.inputTokensDetails).toEqual([NUMERIC_INPUT_DETAILS]);
  expect(usage.outputTokensDetails).toEqual([NUMERIC_OUTPUT_DETAILS]);
  expect(usage.requestUsageEntries).toHaveLength(1);
  expect(usage.requestUsageEntries![0]!.inputTokensDetails).toEqual(NUMERIC_INPUT_DETAILS);
  expect(usage.requestUsageEntries![0]!.outputTokensDetails).toEqual(NUMERIC_OUTPUT_DETAILS);
}

describe("nested provider usage details", () => {
  test("a streamed Responses turn completes and keeps its cached and cache-write counts", async () => {
    const result = await new Runner({ tracingDisabled: true }).run(
      productionResponsesAgent(),
      "Are the harbor lights on?",
      { stream: true },
    );
    for await (const _event of result) {
      // Drain the stream exactly as the turn worker does.
    }
    await result.completed;
    expect(result.error).toBeNull();
    expect(result.finalOutput).toBe(ANSWER);
    expect(result.rawResponses).toHaveLength(1);
    expectNumericDetails(result.rawResponses[0]!.usage);
    expectNumericDetails(result.state.usage);
  });

  test("a non-streamed Responses turn keeps only the numeric usage details", async () => {
    const result = await new Runner({ tracingDisabled: true }).run(
      productionResponsesAgent(),
      "Are the harbor lights on?",
    );
    expect(result.finalOutput).toBe(ANSWER);
    expect(result.rawResponses).toHaveLength(1);
    expectNumericDetails(result.rawResponses[0]!.usage);
    expectNumericDetails(result.state.usage);
  });

  test("the SDK stream boundary drops a nested member even from an unsanitized model", async () => {
    // Defence in depth: a model adapter that copies provider details verbatim
    // must not fail an answer the provider already completed.
    const verbatimUsage = {
      inputTokens: 1200,
      outputTokens: 40,
      totalTokens: 1240,
      inputTokensDetails: structuredClone(PROVIDER_USAGE.input_tokens_details),
      outputTokensDetails: structuredClone(PROVIDER_USAGE.output_tokens_details),
      requestUsageEntries: [
        {
          inputTokens: 1200,
          outputTokens: 40,
          totalTokens: 1240,
          inputTokensDetails: structuredClone(PROVIDER_USAGE.input_tokens_details),
          outputTokensDetails: structuredClone(PROVIDER_USAGE.output_tokens_details),
          endpoint: "responses.create",
        },
      ],
    };
    const output = [
      {
        type: "message",
        id: "msg_fixture",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: ANSWER }],
      },
    ] as ModelResponse["output"];
    const model: Model = {
      async getResponse(_request: ModelRequest): Promise<ModelResponse> {
        throw new Error("This regression drives the streamed path only.");
      },
      async *getStreamedResponse(_request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
        yield { type: "response_started" };
        yield {
          type: "response_done",
          response: { id: "resp_fixture", usage: verbatimUsage, output },
        } as unknown as ResponseStreamEvent;
      },
    };
    const result = await new Runner({ tracingDisabled: true }).run(
      new Agent({ name: "verbatim", model }),
      "Are the harbor lights on?",
      { stream: true },
    );
    for await (const _event of result) {
      // Drain.
    }
    await result.completed;
    expect(result.error).toBeNull();
    expect(result.finalOutput).toBe(ANSWER);
    expectNumericDetails(result.rawResponses[0]!.usage);
  });

  for (const streamed of [false, true]) {
    test(`a direct ${streamed ? "streamed" : "non-streamed"} Responses call (session titles) returns only numeric details`, async () => {
      const result = await runSingleModelCall(
        {
          client: responsesClient(),
          provider: { ...OPENAI_PROVIDER, wireProfile: "openai" } as ResolvedModelProvider,
          modelId: "fixture",
        },
        { messages: [{ role: "user", content: "Name this conversation." }] },
        streamed ? { onTextDelta: () => {} } : {},
      );
      expect(result.text).toBe(ANSWER);
      expect(result.usage?.usage).toEqual({
        inputTokens: 1200,
        outputTokens: 40,
        totalTokens: 1240,
        inputTokensDetails: NUMERIC_INPUT_DETAILS,
        outputTokensDetails: NUMERIC_OUTPUT_DETAILS,
      });
    });
  }

  test("raw provider usage normalizes to the same telemetry with or without the nested member", () => {
    const raw = modelResponseUsageFromResponse(completedResponse());
    expect(raw?.usage.inputTokensDetails).toEqual(NUMERIC_INPUT_DETAILS);
    expect(raw?.usage.outputTokensDetails).toEqual(NUMERIC_OUTPUT_DETAILS);
    const normalized = normalizeModelCallUsage(raw?.usage);
    expect(normalized.telemetry).toEqual({
      inputTokens: 1200,
      outputTokens: 40,
      cachedTokens: 800,
      cacheWriteTokens: 250,
      reasoningTokens: 12,
    });
    expect(normalized.rejectedFields).toEqual([]);
    // Malformed scalar members still reach the normalizer's field-path diagnostics.
    for (const malformedCount of [-1, "800"]) {
      const malformed = modelResponseUsageFromResponse({
        usage: {
          ...PROVIDER_USAGE,
          input_tokens_details: {
            ...PROVIDER_USAGE.input_tokens_details,
            cached_tokens: malformedCount,
          },
        },
      });
      expect(normalizeModelCallUsage(malformed?.usage).rejectedFields).toContain(
        "inputTokensDetails.cached_tokens",
      );
    }
  });
});
