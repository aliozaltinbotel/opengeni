import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as database from "@opengeni/db";
import { ReadRealtimeSessionUsageSource, type AccessGrant } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { accessGrantAuthorizationFromContext, type ApiRouteDeps } from "@opengeni/core";
import { createRealtimeUsageProxyAttachment, createRealtimeUsageProxyLifecycle } from "../src/realtime-usage-proxy";
import type {
  ApiWebSocketConnection,
  ApiWebSocketLike,
  ApiWebSocketUpgradeServer,
} from "../src/api-websocket";
import {
  createInteractionFrameProxyAttachment,
  InteractionFrameProxyTransport,
  placementUsesInteractionFrameProxy,
} from "../src/interaction-frame-proxy";

const rootSecret = "test-root-secret-with-enough-entropy-for-proxy-tests";
const publicOrigin = "https://opengeni.example";
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const relaySpies: Array<{ mockRestore(): void }> = [];
const producedRelayFacts: Array<{ provider: string; final: boolean; events: Array<Parameters<typeof database.recordUsageEvent>[1]> }> = [];
// Explicit fixture regeneration captures the actual native writer, not a
// manually recreated receipt shape. Normal tests never write an artifact.
afterAll(async () => {
  const file = process.env.OPENGENI_TEST_NATIVE_VOICE_FIXTURE_FILE;
  if (file) await Bun.write(file, JSON.stringify({ producer: "native core voice writer through actual API relay", cases: producedRelayFacts }, null, 2) + "\n");
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const spy of relaySpies.splice(0)) spy.mockRestore();
});

describe("interaction frame proxy", () => {
  test("proxies Docker and unsigned OpenSandbox, not native or signed tunnels", () => {
    expect(placementUsesInteractionFrameProxy("docker")).toBe(true);
    expect(placementUsesInteractionFrameProxy("opensandbox")).toBe(true);
    expect(
      placementUsesInteractionFrameProxy("opensandbox", { openSandboxSignedEndpoints: true }),
    ).toBe(false);
    expect(
      placementUsesInteractionFrameProxy("opensandbox", {
        openSandboxSignedEndpoints: true,
        openSandboxInteractionFrameProxy: true,
      }),
    ).toBe(true);
    expect(placementUsesInteractionFrameProxy("modal")).toBe(false);
    expect(placementUsesInteractionFrameProxy("blaxel")).toBe(false);
    expect(placementUsesInteractionFrameProxy(null)).toBe(false);
  });

  test("collapses computer RFB grants to the two viewer protocols the proxy exposes", () => {
    const attachment = createInteractionFrameProxyAttachment({
      requestUrl: `${publicOrigin}/v1/workspaces/workspace/computer-sessions/session/attachments`,
      rootSecret,
      upstreamUrl:
        "ws://127.0.0.1:18090/v1/sandboxes/box/proxy/7682/v1/computer-sessions/cs/targets/screen%3A0/rfb",
      upstreamProtocols: [
        "binary",
        "opengeni.computer.rfb.v1",
        "opengeni.auth.super-secret-view-grant",
      ],
      origin: publicOrigin,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(attachment.protocols).toHaveLength(2);
    expect(attachment.protocols[0]).toBe("binary");
    expect(attachment.protocols[1]?.startsWith("opengeni-frame-proxy.")).toBe(true);
    expect(JSON.stringify(attachment)).not.toContain("opengeni.computer.rfb.v1");
    expect(JSON.stringify(attachment)).not.toContain("opengeni.auth.super-secret-view-grant");
  });

  test("hides and relays a Docker-only controller URL through the public API", async () => {
    let upstreamOrigin: string | null = null;
    const upstream = Bun.serve<{ kind: "upstream" }>({
      port: 0,
      fetch(request, server) {
        upstreamOrigin = request.headers.get("origin");
        const upgraded = server.upgrade(request, {
          data: { kind: "upstream" },
          headers: { "sec-websocket-protocol": "binary" },
        });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message(socket, message) {
          socket.send(message);
        },
      },
    });
    servers.push(upstream);
    const internalUrl = `ws://127.0.0.1:${upstream.port}/frames`;
    const attachment = createInteractionFrameProxyAttachment({
      requestUrl: `${publicOrigin}/v1/workspaces/workspace/attachments`,
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: publicOrigin,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(attachment.url).toBe("wss://opengeni.example/v1/interaction/frame-proxy");
    expect(JSON.stringify(attachment)).not.toContain(internalUrl);
    expect(JSON.stringify(attachment)).not.toContain("secret-view-grant");

    const behindTlsTerminator = createInteractionFrameProxyAttachment({
      requestUrl: "http://127.0.0.1:8000/v1/workspaces/workspace/attachments",
      publicBaseUrl: publicOrigin,
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: publicOrigin,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(behindTlsTerminator.url).toBe("wss://opengeni.example/v1/interaction/frame-proxy");

    const webBaseHttps = createInteractionFrameProxyAttachment({
      requestUrl: "http://127.0.0.1:8000/v1/workspaces/workspace/attachments",
      webBaseUrl: "https://console.example",
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: "https://console.example",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(webBaseHttps.url).toBe("wss://console.example/v1/interaction/frame-proxy");

    const forwardedHttps = createInteractionFrameProxyAttachment({
      requestUrl: "http://127.0.0.1:8000/v1/workspaces/workspace/attachments",
      forwardedProto: "https, http",
      forwardedHost: "console.example",
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: "https://console.example",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(forwardedHttps.url).toBe("wss://console.example/v1/interaction/frame-proxy");

    const localHttp = createInteractionFrameProxyAttachment({
      requestUrl: "http://127.0.0.1:8000/v1/workspaces/workspace/attachments",
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: "http://127.0.0.1:3000",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(localHttp.url).toBe("ws://127.0.0.1:8000/v1/interaction/frame-proxy");

    let connection: ApiWebSocketConnection | null = null;
    const upgradeServer: ApiWebSocketUpgradeServer = {
      upgrade(_request, options) {
        connection = options.data;
        expect(new Headers(options.headers).get("sec-websocket-protocol")).toBe("binary");
        return true;
      },
    };
    const request = proxyRequest(attachment, publicOrigin);
    expect(new InteractionFrameProxyTransport(rootSecret).upgrade(request, upgradeServer)).toBe(
      undefined,
    );
    expect(connection).not.toBeNull();

    const socket = new TestSocket(connection!);
    connection!.attach(socket);
    connection!.receive(Uint8Array.of(1, 3, 3, 7));
    await eventually(() => socket.messages.length === 1);
    expect([...socket.messages[0]!]).toEqual([1, 3, 3, 7]);
    expect(upstreamOrigin).toBe(publicOrigin);
    connection!.transportClosed();
  });

  test("rejects another browser origin", () => {
    const attachment = attachmentExpiringIn(60_000);
    const response = new InteractionFrameProxyTransport(rootSecret).upgrade(
      proxyRequest(attachment, "https://evil.example"),
      rejectingUpgradeServer(),
    );
    expect(response?.status).toBe(403);
  });

  test("rejects expired and tampered grants", () => {
    const expired = attachmentExpiringIn(-1_000);
    expect(
      new InteractionFrameProxyTransport(rootSecret).upgrade(
        proxyRequest(expired, publicOrigin),
        rejectingUpgradeServer(),
      )?.status,
    ).toBe(401);

    const current = attachmentExpiringIn(60_000);
    const tampered = {
      ...current,
      protocols: [current.protocols[0]!, `${current.protocols[1]!}x`],
    };
    expect(
      new InteractionFrameProxyTransport(rootSecret).upgrade(
        proxyRequest(tampered, publicOrigin),
        rejectingUpgradeServer(),
      )?.status,
    ).toBe(401);
  });
});

class TestSocket implements ApiWebSocketLike {
  readonly messages: Uint8Array[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  constructor(readonly data: ApiWebSocketConnection) {}

  send(data: Uint8Array): number {
    this.messages.push(Uint8Array.from(data));
    return data.byteLength;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

function attachmentExpiringIn(milliseconds: number) {
  return createInteractionFrameProxyAttachment({
    requestUrl: `${publicOrigin}/v1/workspaces/workspace/attachments`,
    rootSecret,
    upstreamUrl: "ws://browser-sandbox:7682/frames",
    upstreamProtocols: ["opengeni-browser-v1", "secret-view-grant"],
    origin: publicOrigin,
    expiresAt: new Date(Date.now() + milliseconds).toISOString(),
  });
}

function proxyRequest(
  attachment: ReturnType<typeof createInteractionFrameProxyAttachment>,
  origin: string,
): Request {
  return new Request(attachment.url, {
    headers: {
      origin,
      "sec-websocket-protocol": attachment.protocols.join(", "),
    },
  });
}

function rejectingUpgradeServer(): ApiWebSocketUpgradeServer {
  return {
    upgrade() {
      throw new Error("unexpected upgrade");
    },
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met");
    await Bun.sleep(10);
  }
}


class NativeTextSocket implements ApiWebSocketLike {
  readonly messages: string[] = [];
  readonly closes: number[] = [];
  constructor(readonly data: ApiWebSocketConnection) {}
  send(data: string | Uint8Array): number { if (typeof data !== "string") throw new Error("native provider must remain text"); this.messages.push(data); return Buffer.byteLength(data); }
  close(code = 1000): void { this.closes.push(code); }
}

test.each([
  { provider: "ai-gateway" as const, final: false },
  { provider: "ai-gateway" as const, final: true },
  { provider: "xai-subscription" as const, final: false },
])("native voice proxy commits one durable owner: $provider final=$final", async ({ provider, final }) => {
  const accountId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID(), keyId = crypto.randomUUID();
  const grant: AccessGrant = { accountId, workspaceId, subjectId: `api_key:${keyId}`, principalKind: "api_key", permissions: ["sessions:control"] };
  const authorization = accessGrantAuthorizationFromContext({ mode: "configured", subjectId: grant.subjectId,
    accountGrants: [{ accountId, subjectId: grant.subjectId, permissions: grant.permissions }], workspaceGrants: [grant],
    defaultAccountId: accountId, defaultWorkspaceId: workspaceId }, grant);
  const root = {} as database.Database, tx = {} as database.Database;
  const rows = new Map<string, Parameters<typeof database.recordUsageEvent>[1]>();
  let providerConnections = 0, inTransaction = false;
  relaySpies.push(spyOn(database, "withRlsContext").mockImplementation(async (_db, _scope, fn) => { inTransaction = true; try { return await fn(tx); } finally { inTransaction = false; } }));
  relaySpies.push(spyOn(database, "findActiveWorkspaceApiKeyById").mockResolvedValue({ permissions: ["sessions:control"], permissionMode: "explicit" } as never));
  relaySpies.push(spyOn(database, "recordUsageEvent").mockImplementation(async (db, row) => {
    if (row.eventType === "model.realtime.session.dispatched") { expect(db).toBe(tx); if (!rows.has(row.idempotencyKey)) expect(providerConnections).toBe(0); }
    else expect(db).toBe(root);
    const previous = rows.get(row.idempotencyKey);
    if (previous && JSON.stringify(previous.attributes) !== JSON.stringify(row.attributes)) throw new Error("immutable dispatch owner conflict");
    rows.set(row.idempotencyKey, previous ?? row); return {} as never;
  }));
  relaySpies.push(spyOn(database, "loadRealtimeSessionUsageSource").mockImplementation(async (_db, ref) => {
    const row = rows.get(`usage:model.realtime.session.observed:${ref.connectionId}`);
    return row ? { source: ReadRealtimeSessionUsageSource.parse(row.attributes), occurredAt: new Date("2026-10-10T00:00:00Z") } : null;
  }));
  relaySpies.push(spyOn(database, "loadRealtimeSessionDispatch").mockImplementation(async (_db, ref) => {
    const row = rows.get(`usage:model.realtime.session.dispatched:${ref.connectionId}`);
    return row ? { attributes: row.attributes!, occurredAt: new Date() } : null;
  }));
  const upstream = Bun.serve({ port: 0, fetch(request, server) {
    expect(inTransaction).toBeFalse(); expect(rows.size).toBe(1);
    return server.upgrade(request, { headers: { "sec-websocket-protocol": provider === "ai-gateway" ? "ai-gateway-realtime.v1" : "xai-client-secret.provider-ephemeral-fixture" } }) ? undefined : new Response("failed", { status: 400 });
  }, websocket: { open(socket) { providerConnections++; socket.send(JSON.stringify(provider === "ai-gateway"
      ? { type: "session-started", sessionId: "provider-session-fixture" }
      : { type: "session.created", session: { object: "realtime.session" } })); },
    message(socket) { socket.send(JSON.stringify(final
      ? { type: "session-closed", sessionId: "provider-session-fixture", reason: "closed", usage: { seconds: 12 } }
      : { type: provider === "ai-gateway" ? "response-done" : "response.done", responseId: "turn-only", status: "completed" })); } } });
  servers.push(upstream);
  const settings = testSettings({ productAccessMode: "configured", delegationSecret: rootSecret, billingMode: "disabled", usageLimitsMode: "none" });
  const deps = { db: root, settings, workflowClient: { startRealtimeUsageObservation: async () => {} } } as ApiRouteDeps;
  const connectionId = crypto.randomUUID();
  const sealed = await createRealtimeUsageProxyAttachment({ deps, authorization, request: new Request(publicOrigin, { headers: { origin: publicOrigin } }),
    sessionId, connectionId, connectionEpoch: 1, provider, model: "fixture-realtime-model",
    secret: { url: `ws://127.0.0.1:${upstream.port}`, token: "provider-ephemeral-fixture", upstreamModelId: "fixture-upstream", expiresAt: null } });
  expect(JSON.stringify(sealed)).not.toContain("provider-ephemeral-fixture");
  const attachment = { url: sealed.url, protocols: ["opengeni-realtime.v1", `opengeni-frame-proxy.${sealed.token}`] };
  let connection: ApiWebSocketConnection | null = null;
  const transport = new InteractionFrameProxyTransport(rootSecret, Date.now, createRealtimeUsageProxyLifecycle(deps));
  expect(transport.upgrade(proxyRequest(attachment, publicOrigin), { upgrade(_request, options) { connection = options.data; return true; } })).toBeUndefined();
  const socket = new NativeTextSocket(connection!); connection!.attach(socket);
  // A browser claiming a final event remains just outbound data.
  connection!.receive(JSON.stringify({ type: "session-closed", usage: { seconds: 100000 } }));
  try { await eventually(() => socket.messages.length === 2); } catch { throw new Error(JSON.stringify({ providerConnections, rowTypes: [...rows.values()].map(row => row.eventType), received: socket.messages.length, closes: socket.closes })); }
  expect(rows.has(`usage:model.call:realtime:${connectionId}`)).toBe(final);
  if (final) {
    const receipt = rows.get(`usage:model.call:realtime:${connectionId}`)!;
    expect(receipt.occurredAt).toEqual(new Date("2026-10-10T00:00:00Z"));
    expect(receipt.attributes).toMatchObject({ outcome: "indeterminate", usageReported: false, totalTokens: null, estimatedProviderCostMicros: null, pricingSource: null, priceVersion: null });
  }
  const occurrence = rows.get(`usage:model.realtime.session.observed:${connectionId}`)!;
  expect(occurrence.attributes).toMatchObject({ providerSessionId: provider === "ai-gateway" ? "provider-session-fixture" : null, schema: "opengeni.realtime-session-source/v2" });
  connection!.transportClosed();
  await eventually(() => rows.has(`usage:model.realtime.session.connection_closed:${connectionId}`));
  expect(rows.has(`usage:model.call:realtime:${connectionId}`)).toBe(final);
  expect(rows.get(`usage:model.realtime.session.dispatched:${connectionId}`)!.attributes).toMatchObject({ providerSessionId: null, outcome: "indeterminate", totalTokens: null, estimatedProviderCostMicros: null });
  const replaySocket = { upgrade(_request: Request, options: { data: ApiWebSocketConnection }) { const duplicate = options.data; duplicate.attach(new NativeTextSocket(duplicate)); return true; } };
  transport.upgrade(proxyRequest(attachment, publicOrigin), replaySocket as ApiWebSocketUpgradeServer);
  await Bun.sleep(30); expect(providerConnections).toBe(1);
  producedRelayFacts.push({ provider, final, events: [...rows.values()] });
});
