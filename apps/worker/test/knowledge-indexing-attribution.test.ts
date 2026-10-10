import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { StoredKnowledgeEntryContent } from "@opengeni/contracts";
import type { CreditDebitAttribution, KnowledgeIndexClaim, recordUsageEvent } from "@opengeni/db";
import { knowledgeIndexChunks } from "../../../packages/documents/src/knowledge-index";
const entry = StoredKnowledgeEntryContent.parse({ kind: "fact", title: "Test", content: "test" });
const chunks = [...knowledgeIndexChunks(entry)];
const bytes = chunks.reduce(
  (sum, chunk) => sum + Buffer.byteLength(chunk.embeddingInput, "utf8"),
  0,
);
const claim: KnowledgeIndexClaim = {
  accountId: crypto.randomUUID(),
  entryId: crypto.randomUUID(),
  revisionId: crypto.randomUUID(),
  leaseId: crypto.randomUUID(),
  generation: 1,
  nextIndex: 0,
  model: "embedding",
  dimensions: 3,
  billingAttribution: { kind: "service" },
};
const rootDb = {} as never,
  lockedDb = {} as never;
let lockActive = false;
let publication = "published";
let appendStatus = "running";
let appendFails = false;
let receiptFails = false;
const durableCalls = new Map<string, Parameters<typeof recordUsageEvent>[1]>();
const usage = mock(async (db: unknown, input: Parameters<typeof recordUsageEvent>[1]) => {
  if (input.eventType === "embedding.call") {
    expect(lockActive).toBe(false);
    if (receiptFails) throw new Error("call receipt unavailable");
    if (db === rootDb) durableCalls.set(input.idempotencyKey, input);
  }
});
const append = mock(async () => {
  if (appendFails) throw new Error("append unavailable");
  return { status: appendStatus };
});
import type { DocumentServices } from "@opengeni/documents";
import type { ControlActivityServices } from "../src/activities/types";

let attribution: CreditDebitAttribution = { kind: "service" };
let refusal: { message: string } | null = null;
const debit = mock(async (_db: unknown, _input: unknown) => undefined);
const preflight = mock(async (_db: unknown, _input: unknown) => refusal);
const defer = mock(async () => undefined);
let vectors = [[1, 0, 0]];
const embed = mock(async () => vectors);
const nativeDbExports = await import("@opengeni/db");
mock.module("@opengeni/db", () => ({
  ...nativeDbExports,
  claimKnowledgeIndexJobs: async () => [{ ...claim, billingAttribution: attribution }],
  readKnowledgeIndexSource: async () => ({ billingWorkspaceId: "workspace", nextIndex: 0, entry }),
  withWorkspaceUsageLock: async (
    _db: unknown,
    _workspace: string,
    fn: (db: unknown) => Promise<unknown>,
  ) => {
    lockActive = true;
    try {
      return await fn(lockedDb);
    } finally {
      lockActive = false;
    }
  },
  freezeKnowledgeIndexBillingMode: async () => ({
    mode: "credits",
    rateMicrosPerMillionBytes: 1_000_000,
  }),
  getSpendableCreditBalance: async () => ({ balanceMicros: 100 }),
  checkWorkspaceAllowance: preflight,
  guardPaidKnowledgeIndexPublication: async () => publication,
  appendKnowledgeIndexChunks: append,
  recordUsageEvent: usage,
  applyCreditDebitAfterUse: debit,
  completeKnowledgeIndexJob: async () => ({ status: "ready" }),
  continueKnowledgeIndexJob: async () => undefined,
  deferKnowledgeIndexJob: defer,
  waitKnowledgeIndexForFunding: async () => undefined,
  sumUsageQuantity: async () => 0,
  countScheduledTasksForWorkspace: async () => 0,
  countWorkspacesForAccount: async () => 0,
  countActiveApiKeysForWorkspace: async () => 0,
  countActiveOrganizationApiKeysForAccount: async () => 0,
  isCodexBilledTurn: async () => false,
  knowledgeIndexBillingActivationTime: async () => new Date(),
  creditDebitAttributionMetadata: (value: CreditDebitAttribution) =>
    value.kind === "turn"
      ? {
          turnId: value.turnId,
          ...(value.initiatingHumanSubjectId
            ? { initiatingHumanSubjectId: value.initiatingHumanSubjectId }
            : {}),
        }
      : value.kind === "human"
        ? { initiatingHumanSubjectId: value.initiatingHumanSubjectId }
        : {},
}));
const { paidDocumentEmbedding, documentEmbeddingCostMicros, embeddingCallUsageAttributes } =
  await import("../../../packages/core/src/billing/limits");
mock.module("@opengeni/core", () => ({
  paidDocumentEmbedding,
  documentEmbeddingCostMicros,
  embeddingCallUsageAttributes,
}));
const { createKnowledgeIndexingActivities } = await import("../src/activities/knowledge-indexing");
afterAll(() => mock.restore());

function worker(embedder?: DocumentServices["embedder"]) {
  return createKnowledgeIndexingActivities(
    async () =>
      ({
        db: rootDb,
        settings: {
          documentEmbeddingProvider: "openai",
          documentEmbeddingBillingMode: "credits",
          documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
          documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z",
          usageLimitsMode: "none",
        },
        observability: { warn: () => undefined },
      }) as unknown as ControlActivityServices,
    async () =>
      ({ embedder: embedder ?? { model: "embedding", dimensions: 3, embedMany: embed } }) as never,
  );
}

test("index debit/preflight reuse claimed frozen initiator, never the async worker or latest session", async () => {
  const turnId = crypto.randomUUID();
  for (const [value, human, metadata] of [
    [
      { kind: "turn", turnId, initiatingHumanSubjectId: "human:root" },
      "human:root",
      { turnId, initiatingHumanSubjectId: "human:root" },
    ],
    [
      { kind: "human", initiatingHumanSubjectId: "human:upload" },
      "human:upload",
      { initiatingHumanSubjectId: "human:upload" },
    ],
    [{ kind: "service" }, null, {}],
  ] as const) {
    attribution = value;
    expect((await worker().indexKnowledge()).completed).toBe(1);
    expect(preflight.mock.calls.at(-1)?.[1]).toMatchObject({ subjectId: human });
    expect(debit.mock.calls.at(-1)?.[1]).toMatchObject({
      metadata: { ...metadata, model: "embedding", bytes, chunks: chunks.length },
    });
  }
});

test("unknown attribution and exhausted allowance defer before paid provider use", async () => {
  const calls = embed.mock.calls.length;
  const debits = debit.mock.calls.length;
  attribution = { kind: "unknown" };
  expect((await worker().indexKnowledge()).deferred).toBe(1);
  attribution = { kind: "human", initiatingHumanSubjectId: "human:root" };
  refusal = { message: "Member allowance exhausted" };
  try {
    expect((await worker().indexKnowledge()).deferred).toBe(1);
    expect(embed.mock.calls.length).toBe(calls);
    expect(debit.mock.calls.length).toBe(debits);
    expect(defer).toHaveBeenCalled();
  } finally {
    refusal = null;
  }
});

test("completed index calls survive post-provider publication refusal without writes or debits", async () => {
  attribution = { kind: "service" };
  for (const state of ["obsolete", "awaiting_review"]) {
    publication = state;
    const before = durableCalls.size,
      writes = append.mock.calls.length,
      debits = debit.mock.calls.length;
    try {
      const result = await worker().indexKnowledge();
      expect(state === "obsolete" ? result.unavailable : result.deferred).toBe(1);
      expect(durableCalls.size).toBe(before + 1);
      expect(append.mock.calls.length).toBe(writes);
      expect(debit.mock.calls.length).toBe(debits);
      expect([...durableCalls.values()].at(-1)?.attributes).toMatchObject({
        provider: "openai",
        model: claim.model,
        inputBytes: bytes,
        inputItems: chunks.length,
        inputTokens: null,
        estimatedProviderCostMicros: bytes,
        outcome: "completed",
      });
    } finally {
      publication = "published";
    }
  }
});

test("index receipts survive append refusal and failures; repeated physical calls on the same lease are distinct", async () => {
  attribution = { kind: "service" };
  const before = durableCalls.size,
    debits = debit.mock.calls.length;
  appendStatus = "obsolete";
  try {
    expect((await worker().indexKnowledge()).unavailable).toBe(1);
  } finally {
    appendStatus = "running";
  }
  appendFails = true;
  try {
    expect((await worker().indexKnowledge()).deferred).toBe(1);
    expect((await worker().indexKnowledge()).deferred).toBe(1);
  } finally {
    appendFails = false;
  }
  expect(durableCalls.size).toBe(before + 3);
  expect(debit.mock.calls.length).toBe(debits);
  const calls = [...durableCalls.values()].slice(-3);
  for (const call of calls) expect(call.sourceResourceId).toBe(claim.revisionId);
  // The same authoritative event is idempotent; another physical provider call is not its replay.
  await usage(rootDb, calls[0]!);
  expect(durableCalls.size).toBe(before + 3);
});

test("index call receipt failure is not soft-failed after publication", async () => {
  attribution = { kind: "service" };
  receiptFails = true;
  try {
    await expect(worker().indexKnowledge()).rejects.toThrow("call receipt unavailable");
  } finally {
    receiptFails = false;
  }
});

test("incomplete returned index vectors preserve the completed call without publication or debit", async () => {
  attribution = { kind: "service" };
  const before = durableCalls.size,
    writes = append.mock.calls.length,
    debits = debit.mock.calls.length;
  vectors = [];
  try {
    expect((await worker().indexKnowledge()).deferred).toBe(1);
    expect(durableCalls.size).toBe(before + 1);
    expect(append.mock.calls.length).toBe(writes);
    expect(debit.mock.calls.length).toBe(debits);
  } finally {
    vectors = [[1, 0, 0]];
  }
});

test("real OpenAI index adapter validation failure preserves the completed response without publication or debit", async () => {
  const { OpenAIEmbeddingProvider } = await import("@opengeni/documents");
  let malformed = false;
  const preconnect = globalThis.fetch.preconnect;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        const response: import("openai").default.CreateEmbeddingResponse = {
          object: "list",
          model: claim.model,
          data: [{ object: "embedding", index: 0, embedding: [1, 0] }],
          usage: { prompt_tokens: 0, total_tokens: 0 },
        };
        const wire = malformed
          ? { ...response, data: response.data.map((item) => ({ ...item, embedding: null })) }
          : response;
        return new Response(JSON.stringify(wire), {
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect },
    ),
  );
  const provider = new OpenAIEmbeddingProvider({
    apiKey: "fixture-not-a-credential",
    baseURL: "https://embedding-fixture.invalid/v1",
    model: claim.model,
    dimensions: claim.dimensions,
  });
  attribution = { kind: "service" };
  const before = durableCalls.size,
    writes = append.mock.calls.length,
    debits = debit.mock.calls.length;
  try {
    expect((await worker(provider).indexKnowledge()).deferred).toBe(1);
    malformed = true;
    expect((await worker(provider).indexKnowledge()).deferred).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(durableCalls.size).toBe(before + 2);
    expect([...durableCalls.values()].at(-1)?.attributes).toMatchObject({
      provider: "openai",
      model: provider.model,
      outcome: "completed",
      inputBytes: bytes,
      inputItems: chunks.length,
      inputTokens: null,
      estimatedProviderCostMicros: bytes,
      pricingSource: "configured_byte_rate",
      rateMicrosPerMillionBytes: 1_000_000,
    });
    expect(append.mock.calls.length).toBe(writes);
    expect(debit.mock.calls.length).toBe(debits);
  } finally {
    fetch.mockRestore();
  }
});
