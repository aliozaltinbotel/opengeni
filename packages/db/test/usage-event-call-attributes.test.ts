import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  MODEL_CALL_USAGE_ATTRIBUTES_SCHEMA,
  ModelCallUsageAttributes,
  type HostUsageExportBatch,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimHostExportBatch,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  recordUsageEvent,
  registerHostExportConsumer,
} from "../src/index";

// MAINT-P09-430 (0668): the per-call usage facts are a durable, immutable part
// of the usage row and cross the host usage export unchanged.

let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
let exporter: ReturnType<typeof createDb>;

setDefaultTimeout(180_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("usage-event-call-attributes");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  app = createDb(shared.appUrl);
  exporter = createDb(shared.adminUrl, { max: 2 });
  await registerHostExportConsumer(exporter.db, {
    kind: "usage_event",
    consumerId: "call-usage-test",
  });
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([app?.close(), exporter?.close()]);
  await shared?.release();
});

async function startedTurn(label: string) {
  const subjectId = `subject:${label}:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "call-usage-test",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Call usage ${label}`,
    workspaceExternalSource: "call-usage-test",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Call usage ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: `initial ${label}`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId, label: `User ${label}` },
    createdByContext: { label: `User ${label}` },
  });
  const started = await initializeSessionStartAtomically(app.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  if (!started.turn) throw new Error("session did not create an initial turn");
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    turnId: started.turn.id,
  };
}

function callAttributes(
  overrides: Partial<ModelCallUsageAttributes> = {},
): ModelCallUsageAttributes {
  return ModelCallUsageAttributes.parse({
    schema: MODEL_CALL_USAGE_ATTRIBUTES_SCHEMA,
    callKind: "response",
    scope: "call",
    sourceKey: "resp-1",
    provider: "openai",
    providerApi: "responses",
    upstreamProvider: null,
    model: "gpt-5.6-sol",
    outcome: "completed",
    usageReported: true,
    inputTokens: 1000,
    outputTokens: 500,
    cachedTokens: 200,
    cacheWriteTokens: null,
    reasoningTokens: 64,
    totalTokens: 1500,
    estimatedProviderCostMicros: 14_000,
    pricingSource: "configured_list_price",
    priceVersion: `schedule-sha256:${"a".repeat(64)}`,
    billingPath: "external",
    ...overrides,
  });
}

function callInput(
  turn: Awaited<ReturnType<typeof startedTurn>>,
  attributes: ModelCallUsageAttributes,
) {
  return {
    accountId: turn.accountId,
    workspaceId: turn.workspaceId,
    eventType: "model.call",
    quantity: 1,
    unit: "call",
    sourceResourceType: "model_response",
    sourceResourceId: `${turn.turnId}:${attributes.sourceKey}`,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    idempotencyKey: `usage:model.call:${turn.turnId}:${attributes.sourceKey}`,
    attributes,
  };
}

describe("model.call usage attributes (real PostgreSQL)", () => {
  test("persist with the row, replay identically, and refuse a differing replay", async () => {
    const turn = await startedTurn("replay");
    const attributes = callAttributes();
    const first = await recordUsageEvent(app.db, callInput(turn, attributes));
    expect(first.attributes).toEqual(attributes);
    const replay = await recordUsageEvent(app.db, callInput(turn, attributes));
    expect(replay.id).toBe(first.id);
    await expect(
      recordUsageEvent(
        app.db,
        callInput(turn, callAttributes({ estimatedProviderCostMicros: 15_000 })),
      ),
    ).rejects.toThrow("idempotency key resolved to different attributes");
    const [stored] = await shared.admin<Array<{ attributes: unknown }>>`
      select attributes from usage_events where id = ${first.id}`;
    expect(stored?.attributes).toEqual(attributes);
  });

  test("the database holds the shape: required on a call row, bounded, immutable", async () => {
    const turn = await startedTurn("shape");
    const recorded = await recordUsageEvent(
      app.db,
      callInput(turn, callAttributes({ sourceKey: "resp-shape" })),
    );
    // postgres.js queries run only when awaited, so each refusal is awaited here (not handed to expect().rejects).
    const refusal = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
      } catch (error) {
        return String((error as Error).message);
      }
      return "NO_REFUSAL";
    };
    expect(
      await refusal(
        async () =>
          await shared.admin`update usage_events set attributes = '{"schema":"x"}'::jsonb where id = ${recorded.id}`,
      ),
    ).toContain("usage event attributes are immutable after insert");
    expect(
      await refusal(
        async () =>
          await shared.admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit, idempotency_key, occurred_at)
            values (${turn.accountId}, ${turn.workspaceId}, 'model.call', 1, 'call', ${`usage:model.call:bare:${crypto.randomUUID()}`}, now())`,
      ),
    ).toContain("usage_events_call_attributes_check");
    expect(
      await refusal(
        async () =>
          await shared.admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit, idempotency_key, occurred_at, attributes)
            values (${turn.accountId}, ${turn.workspaceId}, 'model.tokens', 1, 'tokens', ${`usage:oversized:${crypto.randomUUID()}`}, now(),
              ${shared.admin.json({ schema: "x", pad: "p".repeat(5000) })})`,
      ),
    ).toContain("usage_events_attributes_shape_check");
    // A non-attribute update of the same row (the export stamp) is untouched by the guard.
    expect(
      await refusal(
        async () =>
          await shared.admin`update usage_events set exported_to_billing_at = now() where id = ${recorded.id}`,
      ),
    ).toBe("NO_REFUSAL");
  });

  test("the host usage export carries the attributes exactly, and null for other usage", async () => {
    const turn = await startedTurn("export");
    const attributes = callAttributes({ sourceKey: "resp-export", upstreamProvider: null });
    await recordUsageEvent(app.db, callInput(turn, attributes));
    await recordUsageEvent(app.db, {
      accountId: turn.accountId,
      workspaceId: turn.workspaceId,
      eventType: "model.cost",
      quantity: 0,
      unit: "usd_micros",
      sourceResourceType: "model_response",
      sourceResourceId: `${turn.turnId}:resp-export`,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      idempotencyKey: `usage:model.cost:${turn.turnId}:resp-export`,
    });
    const batch = (await claimHostExportBatch(exporter.db, {
      kind: "usage_event",
      consumerId: "call-usage-test",
      leaseToken: crypto.randomUUID(),
      leaseHolderId: `test-${crypto.randomUUID()}`,
      leaseSeconds: 30,
      limit: 256,
      maxBytes: 4_194_304,
    })) as HostUsageExportBatch | null;
    const mine = (batch?.events ?? []).filter((event) => event.turnId === turn.turnId);
    const call = mine.find((event) => event.usage.eventType === "model.call");
    const cost = mine.find((event) => event.usage.eventType === "model.cost");
    expect(call?.usage.attributes).toEqual(attributes);
    expect(ModelCallUsageAttributes.parse(call?.usage.attributes)).toEqual(attributes);
    expect(cost?.usage.attributes ?? null).toBeNull();
  });
});
