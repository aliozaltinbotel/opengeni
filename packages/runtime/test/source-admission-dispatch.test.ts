import { configuredProviders } from "@opengeni/config";
import { instrumentedModelFetch } from "../src/model-provider-client";
import { withModelCallSourceDispatch, type BeforeModelCallSourceReceipt } from "../src/model-request-capture";
import { expect, test } from "bun:test";
import OpenAI from "openai";
import type { Model, StreamEvent } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { generateSessionTitle, requestRemoteCompactionV2, summarizeForCompaction } from "../src/index";
import { ModelRequestCaptureModel, withModelRequestCapture, type ModelRequestCapture } from "../src/model-request-capture";

const refusal = new Error("HOST_SOURCE_ADMISSION_REFUSED");
const history = [{ type: "message" as const, role: "user" as const, content: "Synthetic source" }];
const preparedRequest = { systemInstructions: "Synthetic instructions", modelSettings: {}, tools: [], handoffs: [], outputType: "text" as const, tracing: false };

for (const api of ["chat", "responses", "remote-v2"] as const) {
  test(`${api} compaction admission failure prevents the literal provider call`, async () => {
    let dispatched = 0;
    const create = async () => { dispatched++; throw new Error("provider must remain uncalled"); };
    const client = { chat: { completions: { create } }, responses: { create } } as unknown as OpenAI;
    const settings = testSettings();
    const beforeModelCallSourceReceipt = async () => { throw refusal; };
    const result = api === "remote-v2"
      ? requestRemoteCompactionV2(settings, history, { client, model: "synthetic", preparedRequest, beforeModelCallSourceReceipt })
      : summarizeForCompaction(settings, history, { client, api, preparedRequest, beforeModelCallSourceReceipt });
    await expect(result).rejects.toBe(refusal);
    expect(dispatched).toBe(0);
  });
}

for (const stream of [false, true]) {
  test(`agent admission failure prevents ${stream ? "streaming" : "ordinary"} provider calls and retry bypass`, async () => {
    let dispatched = 0;
    const inner: Model = {
      async getResponse() { dispatched++; throw new Error("provider must remain uncalled"); },
      getStreamedResponse(): AsyncIterable<StreamEvent> { dispatched++; throw new Error("provider must remain uncalled"); },
    };
    let admissions = 0;
    const capture: ModelRequestCapture = () => {};
    capture.beforeCall = async () => { admissions++; throw refusal; };
    await withModelRequestCapture(capture, async () => {
      const model = new ModelRequestCaptureModel(inner);
      for (let retry = 0; retry < 2; retry++) {
        const result = stream ? (async () => { for await (const _ of model.getStreamedResponse({ ...preparedRequest, input: history })) {} })() : model.getResponse({ ...preparedRequest, input: history });
        await expect(result).rejects.toBe(refusal);
      }
    });
    expect(admissions).toBe(2); expect(dispatched).toBe(0);
  });
}

for (const eagerAt of ["getStreamedResponse", "Symbol.asyncIterator"] as const) {
  test(`eager ${eagerAt} dispatch refusal prevents the underlying fetch`, async () => {
    let dispatched = 0;
    let persisted = 0;
    let closed = false;
    const admitted: string[] = [];
    const producer: BeforeModelCallSourceReceipt = async () => { persisted++; return "exact-eager-source"; };
    producer.beforeProviderDispatch = async sourceKey => { admitted.push(sourceKey); throw refusal; };
    const fetch = instrumentedModelFetch("synthetic", Object.assign(async () => {
      dispatched++;
      return Response.json({});
    }, { preconnect: globalThis.fetch.preconnect }));
    const makeIterator = async function* (pending: Promise<Response>): AsyncGenerator<StreamEvent> {
      try {
        await pending;
        yield { type: "response_started" };
      } finally {
        closed = true;
      }
    };
    const inner: Model = {
      async getResponse() { throw new Error("unused"); },
      getStreamedResponse(): AsyncIterable<StreamEvent> {
        if (eagerAt === "getStreamedResponse") {
          const pending = fetch("https://source.invalid/v1/responses");
          return makeIterator(pending);
        }
        return {
          [Symbol.asyncIterator]() {
            const pending = fetch("https://source.invalid/v1/responses");
            return makeIterator(pending);
          },
        };
      },
    };
    const capture: ModelRequestCapture = () => {}; capture.beforeCall = producer;
    const call = withModelRequestCapture(capture, async () => {
      for await (const _ of new ModelRequestCaptureModel(inner).getStreamedResponse({ ...preparedRequest, input: history })) {}
    });
    await expect(call).rejects.toBe(refusal);
    expect(persisted).toBe(1);
    expect(admitted).toEqual(["exact-eager-source"]);
    expect(dispatched).toBe(0);
    expect(closed).toBe(true);
  });
}

test("concurrent streams retain their exact source through eager construction, lazy next and cancellation return", async () => {
  const dispatched: string[] = [];
  const closed: string[] = [];
  const admitted = new Map<string, string[]>();
  const fetch = instrumentedModelFetch("synthetic", Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    dispatched.push(String(init?.body));
    return Response.json({});
  }, { preconnect: globalThis.fetch.preconnect }));
  const inner: Model = {
    async getResponse() { throw new Error("unused"); },
    getStreamedResponse(request): AsyncIterable<StreamEvent> {
      if (typeof request.systemInstructions !== "string") throw new Error("Fixture source missing");
      const key = request.systemInstructions;
      const dispatch = (phase: string) => fetch("https://source.invalid/v1/responses", { method: "POST", body: `${key}:${phase}` });
      const constructed = dispatch("construct");
      return {
        [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
          const iterated = dispatch("iterate");
          return {
            async next() {
              await Promise.all([constructed, iterated]);
              await dispatch("next");
              return { done: false, value: { type: "response_started" } };
            },
            async return() {
              await dispatch("return");
              closed.push(key);
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
  const keys = ["first-stream", "second-stream"];
  await Promise.all(keys.map(key => {
    const observed: string[] = []; admitted.set(key, observed);
    const producer: BeforeModelCallSourceReceipt = async () => key;
    producer.beforeProviderDispatch = async sourceKey => { await Promise.resolve(); observed.push(sourceKey); };
    const capture: ModelRequestCapture = () => {}; capture.beforeCall = producer;
    return withModelRequestCapture(capture, async () => {
      for await (const _ of new ModelRequestCaptureModel(inner).getStreamedResponse({ ...preparedRequest, systemInstructions: key, input: history })) break;
    });
  }));
  const phases = ["construct", "iterate", "next", "return"];
  for (const key of keys) expect(admitted.get(key)).toEqual(phases.map(() => key));
  expect(dispatched.sort()).toEqual(keys.flatMap(key => phases.map(phase => `${key}:${phase}`)).sort());
  expect(closed.sort()).toEqual([...keys].sort());
  await fetch("https://source.invalid/v1/responses");
  for (const key of keys) expect(admitted.get(key)).toHaveLength(phases.length);
});


for (const kind of ["agent", "chat-compaction", "responses-compaction", "remote-v2", "title"] as const) {
  test(`${kind} reauthorizes the same exact source before an SDK HTTP retry`, async () => {
    let dispatched = 0;
    const admitted: string[] = [];
    const producer: BeforeModelCallSourceReceipt = async () => "exact-source-key";
    producer.beforeProviderDispatch = async sourceKey => {
      admitted.push(sourceKey);
      if (admitted.length > 1) throw refusal;
    };
    const fetch = instrumentedModelFetch("synthetic", Object.assign(async () => {
      dispatched++;
      return Response.json({ error: { message: "Synthetic capacity", type: "rate_limit_error" } }, { status: 429, headers: { "retry-after-ms": "1" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    const client = new OpenAI({ apiKey: "synthetic", baseURL: "https://source.invalid/v1", maxRetries: 1, fetch });
    const settings = testSettings();
    const provider = configuredProviders(settings)[0];
    if (!provider) throw new Error("Fixture model provider missing");
    let call: Promise<unknown>;
    if (kind === "agent") {
      const capture: ModelRequestCapture = () => {}; capture.beforeCall = producer;
      const inner: Model = {
        async getResponse() { await client.responses.create({ model: "synthetic", input: "Synthetic input" }); throw new Error("unexpected provider success"); },
        getStreamedResponse(): AsyncIterable<StreamEvent> { throw new Error("unused"); },
      };
      call = withModelRequestCapture(capture, () => new ModelRequestCaptureModel(inner).getResponse({ ...preparedRequest, input: history }));
    } else if (kind === "title") {
      call = generateSessionTitle(settings, "Synthetic input", { client, provider, modelName: "synthetic", beforeModelCallSourceReceipt: producer });
    } else if (kind === "remote-v2") {
      call = requestRemoteCompactionV2(settings, history, { client, provider, model: "synthetic", preparedRequest, beforeModelCallSourceReceipt: producer });
    } else {
      call = summarizeForCompaction(settings, history, { client, provider, api: kind === "chat-compaction" ? "chat" : "responses", model: "synthetic", preparedRequest, beforeModelCallSourceReceipt: producer });
    }
    await expect(call).rejects.toThrow();
    expect(admitted).toEqual(["exact-source-key", "exact-source-key"]);
    expect(dispatched).toBe(1);
  });
}

test("dispatch scope refuses an absent exact key and never leaks a prior call into another scope", async () => {
  const keys: string[] = [];
  const producer: BeforeModelCallSourceReceipt = async () => "unused";
  producer.beforeProviderDispatch = async key => { keys.push(key); };
  const fetch = instrumentedModelFetch("synthetic", Object.assign(async () => Response.json({}), { preconnect: globalThis.fetch.preconnect }));
  await expect(Promise.resolve().then(() => withModelCallSourceDispatch(producer, undefined, () => fetch("https://source.invalid/v1/responses")))).rejects.toThrow("MODEL_SOURCE_RECEIPT_UNAVAILABLE");
  await Promise.all(["first", "second"].map(key => withModelCallSourceDispatch(producer, key, async () => { await Promise.resolve(); await fetch("https://source.invalid/v1/responses"); })));
  expect(keys.sort()).toEqual(["first", "second"]);
  await fetch("https://source.invalid/v1/responses"); expect(keys).toHaveLength(2);
});
