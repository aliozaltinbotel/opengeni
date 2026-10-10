import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { createRealtimeVoiceBilling } from "@opengeni/core";
import type { Settings } from "@opengeni/config";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  createSession,
  getBillingBalance,
  listUsageEvents,
  renewSessionRealtimeInTransaction,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";

import { registerSessionRoutes } from "../src/routes/sessions";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { createTemporalWorkflowClient } from "../src/index";
import { Client as TemporalClient, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createRealtimeUsageActivities } from "../../worker/src/activities/realtime-usage";
import type { ControlActivityServices } from "../../worker/src/activities/types";
import { InteractionFrameProxyTransport } from "../src/interaction-frame-proxy";
import { createRealtimeUsageProxyLifecycle } from "../src/realtime-usage-proxy";
import type { ApiWebSocketConnection } from "../src/api-websocket";
import * as gatewayProvider from "../src/gateway-realtime";

const DELEGATION_SECRET = "realtime-voice-billing-secret-with-32-bytes";
const AZURE_MODEL = "opengeni-azure/gpt-live-1";
// 50,000 micros/minute + 5% margin = 52,500 credit micros per started minute.
const MINUTE = 52_500;

const pricedSettings = testSettings({
  productAccessMode: "managed",
  billingMode: "stripe",
  delegationSecret: DELEGATION_SECRET,
  vercelAiGatewayApiKey: "gateway-test-key",
  azureLiveEndpoint: "https://voice.example.test",
  azureLiveApiKey: "synthetic-azure-key",
  azureLivePricingJson: JSON.stringify({ microsPerMinute: 50_000, marginBps: 500 }),
  aiGatewayRealtimePricingJson: JSON.stringify({
    "openai/gpt-realtime-2.1": { microsPerMinute: 50_000, marginBps: 500 },
  }),
  temporalHost: process.env.OPENGENI_TEST_TEMPORAL_ADDRESS,
  temporalNamespace: process.env.OPENGENI_TEST_TEMPORAL_NAMESPACE ?? "default",
  temporalTaskQueue: `realtime-voice-billing-${crypto.randomUUID()}`,
});

let shared: SharedTestDatabase;
let client: DbClient;
let providerCalls = 0;
let temporalOwner: Awaited<ReturnType<typeof createTemporalWorkflowClient>>;
let temporalConnection: Connection;
let temporal: TemporalClient;
let native: NativeConnection;
let worker: Worker;
let workerRun: Promise<void>;
const observedConnections = new Set<string>();
const appDeps = new WeakMap<Hono, ApiRouteDeps>();

setDefaultTimeout(60_000);

function appFor(settings: Settings): Hono {
  const noop = async () => undefined;
  const workflowClient = { ...temporalOwner.client,
    startRealtimeUsageObservation: async (input: Parameters<NonNullable<typeof temporalOwner.client.startRealtimeUsageObservation>>[0]) => {
      await temporalOwner.client.startRealtimeUsageObservation!(input);
      observedConnections.add(input.connectionId);
    } };
  const deps = {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    codexFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      providerCalls += 1;
      if (request.url === "https://voice.example.test/openai/v1/live/sessions") {
        return Response.json({
          session: { id: "live_session_fixture" },
          transport: {
            sdp: "v=0\r\na=answer:azure-fixture\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
          },
        });
      }
      if (request.url.endsWith("/v1/realtime/client-secrets")) {
        return Response.json({ token: "vcst_test_token", expiresAt: 2_000_000_000 });
      }
      throw new Error(`unexpected provider request ${request.url}`);
    },
  } as unknown as ApiRouteDeps;
  const app = new Hono();
  registerSessionRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  appDeps.set(app, deps);
  return app;
}

beforeAll(async () => {
  if (!process.env.OPENGENI_TEST_TEMPORAL_ADDRESS) throw new Error("Realtime billing requires the coordinated Temporal fixture");
  const acquired = await acquireSharedTestDatabase("api-realtime-voice-billing");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  native = await NativeConnection.connect({ address: pricedSettings.temporalHost });
  worker = await Worker.create({ connection: native, namespace: pricedSettings.temporalNamespace,
    taskQueue: pricedSettings.temporalTaskQueue,
    workflowBundle: { codePath: new URL("../../worker/dist/workflow-bundle.js", import.meta.url).pathname },
    activities: createRealtimeUsageActivities(async () => ({ db: client.db, settings: pricedSettings }) as ControlActivityServices),
    maxConcurrentActivityTaskExecutions: 2, maxConcurrentWorkflowTaskExecutions: 2 });
  workerRun = worker.run(); void workerRun.catch(() => undefined);
  temporalOwner = await createTemporalWorkflowClient(pricedSettings, client.db);
  temporalConnection = await Connection.connect({ address: pricedSettings.temporalHost });
  temporal = new TemporalClient({ connection: temporalConnection, namespace: pricedSettings.temporalNamespace });
}, 180_000);

afterAll(async () => {
  for (const id of observedConnections) {
    const handle = temporal.workflow.getHandle(`realtime-usage:${id}`);
    await handle.cancel(); await handle.result().catch(() => undefined);
  }
  await temporalOwner?.close(); await temporalConnection?.close();
  worker?.shutdown(); await workerRun; await native?.close();
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(credits = 0) {
  const suffix = crypto.randomUUID();
  const subjectId = `user:${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `realtime-billing-account-${suffix}`,
    accountName: "Realtime billing",
    workspaceExternalSource: "test",
    workspaceExternalId: `realtime-billing-workspace-${suffix}`,
    workspaceName: "Realtime billing",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  if (credits > 0) {
    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      amountMicros: credits,
      type: "grant",
      idempotencyKey: `grant:${suffix}`,
    });
  }
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId,
    principalKind: "human_session",
    permissions: ["sessions:read", "sessions:control", "workspace:read"],
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    subjectId,
    base: `http://x/v1/workspaces/${grant.workspaceId}/sessions/${session.id}/realtime`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}

function ownerProof(model: string) {
  return {
    operationId: crypto.randomUUID(),
    browserInstanceId: `browser-${crypto.randomUUID()}`,
    ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    model,
  };
}

async function begin(app: Hono, value: Awaited<ReturnType<typeof fixture>>, model: string) {
  const proof = ownerProof(model);
  const response = await app.request(value.base, {
    method: "POST",
    headers: value.headers,
    body: JSON.stringify(proof),
  });
  return { proof, response };
}

async function costEvents(value: Awaited<ReturnType<typeof fixture>>) {
  const rows = await listUsageEvents(client.db, {
    accountId: value.accountId,
    workspaceId: value.workspaceId,
    limit: 100,
  });
  return rows.filter(
    (row) => row.eventType === "model.cost" && row.sourceResourceType === "voice_realtime",
  );
}

describe("deployment-funded realtime voice credits (real PostgreSQL)", () => {
  test("refuses unfunded starts with the voice-input code; workspace-funded voice is not gated", async () => {
    const app = appFor(pricedSettings);
    const value = await fixture(0);
    const refused = await begin(app, value, AZURE_MODEL);
    expect(refused.response.status).toBe(402);
    expect(await refused.response.json()).toMatchObject({ code: "insufficient_credits" });
    const gateway = await begin(app, value, "opengeni-gateway/openai/gpt-realtime-2.1");
    expect(gateway.response.status).toBe(402);
    // A connected subscription is paid by the workspace: admission is not credit-gated.
    const codex = await begin(app, value, "gpt-live-1-boulder-alpha");
    expect(codex.response.status).toBe(201);

    const catalog = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`,
      { headers: value.headers },
    );
    expect(catalog.status).toBe(200);
    const models = ((await catalog.json()) as { models: Array<Record<string, unknown>> }).models;
    const hosted = models.filter((model) => model.provider === "OpenGeni");
    expect(hosted.map((model) => model.id)).toEqual([AZURE_MODEL]);
    expect(hosted[0]).toMatchObject({
      available: false,
      unavailableCode: "insufficient_credits",
    });
  });

  test("promotional chat-only credits are named instead of reported as no credits", async () => {
    const app = appFor(pricedSettings);
    const value = await fixture(0);
    await applyCreditLedgerEntry(client.db, {
      accountId: value.accountId,
      amountMicros: 10_000_000,
      type: "grant",
      eligibleModelIds: ["gpt-chat-only"],
      idempotencyKey: `promo:${value.accountId}`,
    });
    const refused = await begin(app, value, AZURE_MODEL);
    expect(refused.response.status).toBe(402);
    expect(await refused.response.json()).toMatchObject({
      code: "insufficient_credits",
      message: "Promotional credits don't cover live voice. Add credits to use it.",
    });
    const catalog = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`,
      { headers: value.headers },
    );
    const models = ((await catalog.json()) as { models: Array<Record<string, unknown>> }).models;
    expect(models.find((model) => model.provider === "OpenGeni")).toMatchObject({
      available: false,
      unavailableCode: "insufficient_credits",
      unavailableReason: "Promotional credits don't cover live voice. Add credits to use it.",
    });
  });

  test("signup trial credits make live voice available and pay for its minutes", async () => {
    const app = appFor(pricedSettings);
    const value = await fixture(0);
    // Signup credits stay scoped to chat models for model usage, yet pay for voice.
    await applyCreditLedgerEntry(client.db, {
      accountId: value.accountId,
      amountMicros: 2 * MINUTE,
      type: "grant",
      eligibleModelIds: ["gpt-chat-only"],
      sourceType: "verified_signup_trial",
      sourceId: value.subjectId,
      idempotencyKey: `verified-signup-trial:v1:${value.accountId}`,
      metadata: { campaign: "verified_signup_trial_v1", creditOfferLabel: "Signup credits" },
    });
    const catalog = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`,
      { headers: value.headers },
    );
    const models = ((await catalog.json()) as { models: Array<Record<string, unknown>> }).models;
    expect(models.find((model) => model.provider === "OpenGeni")).toMatchObject({
      id: AZURE_MODEL,
      available: true,
      unavailableReason: null,
      unavailableCode: null,
      recommended: true,
    });

    const started = await begin(app, value, AZURE_MODEL);
    expect(started.response.status).toBe(201);
    const mode = (
      (await started.response.json()) as {
        mode: { id: string; version: number; connectionEpoch: number };
      }
    ).mode;
    const negotiated = await app.request(`${value.base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify({
        realtimeId: mode.id,
        operationId: crypto.randomUUID(),
        browserInstanceId: started.proof.browserInstanceId,
        ownerKey: started.proof.ownerKey,
        expectedVersion: mode.version,
        expectedConnectionEpoch: mode.connectionEpoch,
        rotate: false,
        sdp: "v=0\r\na=offer:fixture\r\n",
        version: "v3",
      }),
    });
    expect(negotiated.status).toBe(200);
    // The first started minute is charged to the signup grant, not general credit.
    const balance = await getBillingBalance(client.db, value.accountId);
    expect(balance.balanceMicros).toBe(MINUTE);
    expect(balance.generalBalanceMicros).toBe(0);
    expect(balance.promotionalCredits).toEqual([
      expect.objectContaining({ remainingMicros: MINUTE, coversVoice: true }),
    ]);
    expect(await costEvents(value)).toHaveLength(1);
  });

  test("an enabled provider without pricing is neither offered nor startable", async () => {
    const app = appFor({ ...pricedSettings, azureLivePricingJson: undefined });
    const value = await fixture(1_000_000);
    const refused = await begin(app, value, AZURE_MODEL);
    expect(refused.response.status).toBe(409);
    expect(await refused.response.json()).toMatchObject({
      error: { code: "realtime_voice_unavailable", details: { reason: "pricing_unconfigured" } },
    });
    const catalog = await app.request(
      `http://x/v1/workspaces/${value.workspaceId}/realtime-model-catalog`,
      { headers: value.headers },
    );
    const models = ((await catalog.json()) as { models: Array<Record<string, unknown>> }).models;
    // Azure is unpriced, so the priced managed Gateway model is offered instead.
    expect(
      models.filter((model) => model.provider === "OpenGeni").map((model) => model.id),
    ).toEqual(["opengeni-gateway/openai/gpt-realtime-2.1"]);
    expect(models.find((model) => model.provider === "OpenGeni")).toMatchObject({
      available: true,
    });
  });

  test("bills each started minute once per connection and stops at a zero balance", async () => {
    const app = appFor(pricedSettings);
    const value = await fixture(3 * MINUTE);
    const started = await begin(app, value, AZURE_MODEL);
    expect(started.response.status).toBe(201);
    const mode = (
      (await started.response.json()) as {
        mode: { id: string; version: number; connectionEpoch: number };
      }
    ).mode;
    const proof = started.proof;
    const negotiated = await app.request(`${value.base}/webrtc`, {
      method: "POST",
      headers: value.headers,
      body: JSON.stringify({
        realtimeId: mode.id,
        operationId: crypto.randomUUID(),
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: mode.version,
        expectedConnectionEpoch: mode.connectionEpoch,
        rotate: false,
        sdp: "v=0\r\na=offer:fixture\r\n",
        version: "v3",
      }),
    });
    expect(negotiated.status).toBe(200);
    // The first started minute is billed when the provider connection is issued.
    expect((await getBillingBalance(client.db, value.accountId)).balanceMicros).toBe(2 * MINUTE);
    expect(await costEvents(value)).toHaveLength(1);

    // A heartbeat in the same minute bills nothing new and extends the lease.
    const heartbeat = await app.request(`${value.base}/${mode.id}/heartbeat`, {
      method: "PATCH",
      headers: value.headers,
      body: JSON.stringify({
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: mode.version,
      }),
    });
    expect(heartbeat.status).toBe(200);
    const renewed = (await heartbeat.json()) as {
      mode: { version: number };
      stop?: unknown;
    };
    expect(renewed.stop).toBeUndefined();
    expect(renewed.mode.version).toBe(mode.version + 1);
    expect(await costEvents(value)).toHaveLength(1);

    // Two more minutes observed through owner heartbeats (server clock).
    let version = renewed.mode.version;
    const base = Date.now();
    for (const offset of [25_000, 50_000, 75_000, 100_000, 125_000]) {
      const result = await withWorkspaceSessionActivityRls(client.db, value.workspaceId, (db) =>
        renewSessionRealtimeInTransaction(db, {
          workspaceId: value.workspaceId,
          sessionId: value.sessionId,
          realtimeId: mode.id,
          ownerSubjectId: value.subjectId,
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: version,
          now: new Date(base + offset),
        }),
      );
      version = result.mode.version;
    }
    const billing = createRealtimeVoiceBilling({ db: client.db, settings: pricedSettings });
    const settleInput = {
      workspaceId: value.workspaceId,
      sessionId: value.sessionId,
      realtimeId: mode.id,
      callerSubjectId: value.subjectId,
      attribution: { kind: "human" as const, initiatingHumanSubjectId: value.subjectId },
      now: new Date(base + 125_000),
    };
    const [first, second] = await Promise.all([
      billing.settle(settleInput),
      billing.settle(settleInput),
    ]);
    // Concurrent settlement charges each (connection, minute) exactly once.
    expect(first.debitedMicros + second.debitedMicros).toBe(2 * MINUTE);
    expect(await costEvents(value)).toHaveLength(3);
    expect((await getBillingBalance(client.db, value.accountId)).balanceMicros).toBe(0);
    expect(first.stop?.code ?? second.stop?.code).toBe("insufficient_credits");
  });

  test("a heartbeat at zero balance tells the client to stop, keeps the lease, and refuses re-mint", async () => {
    const app = appFor(pricedSettings);
    const value = await fixture(MINUTE);
    const started = await begin(app, value, "opengeni-gateway/openai/gpt-realtime-2.1");
    expect(started.response.status).toBe(201);
    const mode = (
      (await started.response.json()) as {
        mode: { id: string; version: number; connectionEpoch: number; leaseExpiresAt: string };
      }
    ).mode;
    const proof = started.proof;
    // Override only the installed broker's upstream test transport. Its real
    // mint, canonical request authority, sealed connection and relay stay live.
    const originalBroker = gatewayProvider.createGatewayRealtimeConnectionSecret;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch(request, server) { return server.upgrade(request, { headers: { "sec-websocket-protocol": "ai-gateway-realtime.v1" } })
        ? undefined : new Response(null, { status: 400 }); },
      websocket: { open(socket) { socket.send(JSON.stringify({ type: "session-started", sessionId: `gateway-session-${crypto.randomUUID()}` })); },
        message() {} } });
    const broker = spyOn(gatewayProvider, "createGatewayRealtimeConnectionSecret").mockImplementation(async input => ({
      ...await originalBroker(input), url: upstream.url.toString().replace(/^http/, "ws"),
    }));
    let relay: ApiWebSocketConnection | undefined;
    let providerObserved = false;
    const closedReceipt = Promise.withResolvers<void>();
    void closedReceipt.promise.catch(() => undefined);
    try {
      const minted = await app.request(`${value.base}/gateway`, {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          realtimeId: mode.id,
          operationId: crypto.randomUUID(),
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: mode.version,
          expectedConnectionEpoch: mode.connectionEpoch,
          rotate: false,
        }),
      });
      expect(minted.status).toBe(200);
      expect((await getBillingBalance(client.db, value.accountId)).balanceMicros).toBe(MINUTE);
      const attachment = await minted.json() as { url: string; token: string; connectionId: string };
      const deps = appDeps.get(app)!;
      const lifecycle = createRealtimeUsageProxyLifecycle(deps);
      const transport = new InteractionFrameProxyTransport(DELEGATION_SECRET, Date.now, { ...lifecycle,
        closed: async (...args) => { try { await lifecycle.closed(...args); closedReceipt.resolve(); }
          catch (error) { closedReceipt.reject(error); throw error; } },
      });
      let deliver!: () => void, reject!: (error: Error) => void;
      const delivered = new Promise<void>((resolve, fail) => { deliver = resolve; reject = fail; });
      expect(transport.upgrade(new Request(attachment.url.replace(/^ws/, "http"), {
        headers: { "sec-websocket-protocol": `opengeni-realtime.v1, opengeni-frame-proxy.${attachment.token}` },
      }), { upgrade(_request, options) { relay = options.data; return true; } })).toBeUndefined();
      if (!relay) throw new Error("Actual realtime relay was not admitted");
      relay.attach({ data: relay, send(data) {
        expect(typeof data).toBe("string");
        expect(JSON.parse(String(data)).type).toBe("session-started"); providerObserved = true; deliver(); return Buffer.byteLength(String(data));
      }, close(code) { reject(new Error(`Actual realtime relay closed before provider occurrence (${code})`)); } });
      await delivered;
      expect((await temporal.workflow.getHandle(`realtime-usage:${attachment.connectionId}`).describe()).status.name).toBe("RUNNING");

      const heartbeat = await app.request(`${value.base}/${mode.id}/heartbeat`, {
        method: "PATCH",
        headers: value.headers,
        body: JSON.stringify({
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: mode.version,
        }),
      });
      expect(heartbeat.status).toBe(200);
      const body = (await heartbeat.json()) as {
        mode: { version: number; leaseExpiresAt: string; state: string };
        stop?: { code: string; message: string };
      };
      expect(body.stop).toMatchObject({ code: "insufficient_credits" });
      expect(body.mode.state).toBe("active");
      expect(body.mode.version).toBe(mode.version);
      expect(body.mode.leaseExpiresAt).toBe(mode.leaseExpiresAt);
      expect((await getBillingBalance(client.db, value.accountId)).balanceMicros).toBe(0);

      const calls = providerCalls;
      const rotated = await app.request(`${value.base}/gateway`, {
        method: "POST",
        headers: value.headers,
        body: JSON.stringify({
          realtimeId: mode.id,
          operationId: crypto.randomUUID(),
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: mode.version,
          expectedConnectionEpoch: mode.connectionEpoch,
          rotate: true,
        }),
      });
      expect(rotated.status).toBe(402);
      expect(await rotated.json()).toMatchObject({ code: "insufficient_credits" });
      expect(providerCalls).toBe(calls);
    } finally {
      relay?.transportClosed(); broker.mockRestore(); upstream.stop(true);
      if (providerObserved) await closedReceipt.promise;
    }

    const ended = await app.request(`${value.base}/${mode.id}`, {
      method: "DELETE",
      headers: value.headers,
      body: JSON.stringify({
        browserInstanceId: proof.browserInstanceId,
        ownerKey: proof.ownerKey,
        expectedVersion: mode.version,
        reason: "user_stop",
      }),
    });
    expect(ended.status).toBe(200);
    // One connection, observed for under a minute: exactly one minute billed.
    expect(await costEvents(value)).toHaveLength(1);
  });
});
