import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  organizationAccessPresetPermissions,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import type { HostWebhookDeliveryRequest } from "@opengeni/contracts/organization-governance";
import type { AppDependencies, SessionWorkflowClient } from "@opengeni/core";
import {
  consumeMcpOAuthAuthorizationRequest,
  createDb,
  createManagedOrganization,
  createMcpOAuthAuthorizationRequest,
  exchangeMcpOAuthAuthorizationCode,
  type DbClient,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { HOST_WEBHOOK_DELIVERY_START_TIMEOUT_MS } from "../src/http/host-webhooks";

/*
 * With `hostWebhooks.mcpConnectionRevoked` configured, disconnecting an MCP
 * connection, or taking access away from one, starts exactly one durable
 * delivery before the change is written; a delivery that can't start is
 * counted and warned about (ids only in the protected diagnostic) and never
 * blocks the change. Without it nothing is started.
 */

const origin = "http://opengeni.test";
const hook = { url: "https://host.example.test/hooks", secret: "x".repeat(32) };
const mcpClientId = `ogmcp_client_${crypto.randomUUID()}`;
const redirectUri = "http://127.0.0.1:4567/callback";
const hash = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
const readOnlyEverywhere: OrganizationAccessPolicy = {
  preset: "read_only",
  permissions: organizationAccessPresetPermissions("read_only"),
  workspaceScope: { kind: "all" },
};

type App = ReturnType<typeof createApp>;
type Person = { cookie: string; subjectId: string; organizationId: string; workspaceId: string };

let shared: SharedTestDatabase;
let client: DbClient;
const started: HostWebhookDeliveryRequest[] = [];
const workflowClient = {
  startHostWebhookDelivery: async (request: HostWebhookDeliveryRequest) => {
    started.push(request);
  },
} as unknown as SessionWorkflowClient;

function appFor(hostWebhooks: boolean): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "host-mcp-connection-webhook-secret-32-bytes",
      publicBaseUrl: origin,
      ...(hostWebhooks ? { hostWebhooks: { mcpConnectionRevoked: hook } } : {}),
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    // Without the webhook the stock workflow client has no delivery method.
    workflowClient: hostWebhooks ? workflowClient : ({} as never),
  } as AppDependencies);
}

const DIAGNOSTICS = "https://diagnostics.example.test";

/** A real observability whose public lines and protected diagnostics the test reads. */
function capturingObservability() {
  const exported: unknown[] = [];
  const observability = createObservability(
    {
      observabilityStructuredLogs: true,
      observabilityMetricsEnabled: true,
      serviceName: "opengeni",
      environment: "test",
      observabilityDiagnosticsEndpoint: DIAGNOSTICS,
    } as never,
    {
      component: "api",
      exporter: async (url, body) => {
        if (url === `${DIAGNOSTICS}/v1/logs`) exported.push(body);
      },
    },
  );
  const diagnostics = () =>
    exported.map((body) => {
      const logs = body as {
        resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[];
      };
      return JSON.parse(
        logs.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.body.stringValue,
      ) as Record<string, unknown>;
    });
  return { observability, diagnostics };
}

/** Runs `work` with console output captured as parsed structured records. */
async function capturingConsole(work: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (line: string) => lines.push(String(line));
  console.warn = (line: string) => lines.push(String(line));
  console.error = (line: string) => lines.push(String(line));
  try {
    await work();
  } finally {
    Object.assign(console, original);
  }
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

let configured: App;
let unconfigured: App;
let person: Person;

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

async function signUp(app: App): Promise<Person> {
  const email = `${crypto.randomUUID()}@example.test`;
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Connected person", email, password: "password1234" }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const response = await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", rememberMe: true }),
  });
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Better Auth response did not set a session cookie");
  const [user] = await shared.admin<
    { id: string }[]
  >`select id from auth_users where email = ${email}`;
  const subjectId = `user:${user!.id}`;
  const created = await createManagedOrganization(client.db, {
    subjectId,
    subjectLabel: email,
    name: "Connected organization",
    operationId: crypto.randomUUID(),
  });
  return {
    cookie: cookie.split(";", 1)[0]!,
    subjectId,
    organizationId: created.organization.id,
    workspaceId: created.workspaceId,
  };
}

async function connect(): Promise<string> {
  const requestHash = hash();
  const resource = `${origin}/v1/mcp`;
  await createMcpOAuthAuthorizationRequest(client.db, {
    requestHash,
    clientId: mcpClientId,
    accountId: person.organizationId,
    workspaceId: null,
    subjectId: person.subjectId,
    resource,
    redirectUri,
    codeChallenge: "c".repeat(43),
    state: null,
    permissions: [],
    toolIdentities: [],
    organizationAccess: readOnlyEverywhere,
    expiresAt: inDays(1),
  });
  const codeHash = hash();
  await consumeMcpOAuthAuthorizationRequest(client.db, {
    requestHash,
    subjectId: person.subjectId,
    codeHash,
    codeExpiresAt: inDays(1),
  });
  const exchanged = await exchangeMcpOAuthAuthorizationCode(client.db, {
    codeHash,
    clientId: mcpClientId,
    redirectUri,
    resource,
    codeChallenge: "c".repeat(43),
    accessTokenHash: hash(),
    refreshTokenHash: hash(),
    accessExpiresAt: inDays(1),
    refreshExpiresAt: inDays(30),
  });
  return exchanged!.refreshFamilyId;
}

function connectionPath(connectionId: string): string {
  return `/v1/organizations/${person.organizationId}/mcp-connections/${connectionId}`;
}

async function disconnect(app: App, connectionId: string): Promise<void> {
  const response = await app.request(connectionPath(connectionId), {
    method: "DELETE",
    headers: browser(person.cookie),
  });
  expect(response.status).toBe(204);
}

async function changeAccess(connectionId: string, access: OrganizationAccessPolicy) {
  const response = await configured.request(connectionPath(connectionId), {
    method: "PATCH",
    headers: browser(person.cookie),
    body: JSON.stringify({ access }),
  });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-mcp-connection-webhook");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  configured = appFor(true);
  unconfigured = appFor(false);
  await shared.admin`insert into mcp_oauth_clients (
    client_id, redirect_uris, client_name, grant_types, response_types, registration_scope_hash
  ) values (
    ${mcpClientId}, ${shared.admin.json([redirectUri])}, 'Outside agent',
    ${shared.admin.json(["authorization_code", "refresh_token"])},
    ${shared.admin.json(["code"])}, ${"5".repeat(64)}
  )`;
  person = await signUp(configured);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("the mcp_connection.revoked delivery is started", () => {
  test("once for a disconnect, with one delivery id per connection", async () => {
    started.length = 0;
    const connectionId = await connect();
    await disconnect(configured, connectionId);
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({
      deliveryId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab]/u),
      event: {
        type: "mcp_connection.revoked",
        organizationId: person.organizationId,
        connectionId,
        change: "revoked",
      },
    });
    // A disconnected connection is gone from the list: nothing more to start.
    const again = await configured.request(connectionPath(connectionId), {
      method: "DELETE",
      headers: browser(person.cookie),
    });
    expect(again.status).toBe(404);
    expect(started).toHaveLength(1);
  }, 60_000);

  test("once for an access change that takes something away, never for one that only adds", async () => {
    started.length = 0;
    const connectionId = await connect();
    const narrowed: OrganizationAccessPolicy = {
      ...readOnlyEverywhere,
      workspaceScope: { kind: "selected", workspaceIds: [person.workspaceId] },
    };
    await changeAccess(connectionId, narrowed);
    expect(started).toHaveLength(1);
    expect(started[0]!.event).toMatchObject({
      change: "consent_downgraded",
      connectionId,
      previousConsentScope: readOnlyEverywhere,
      consentScope: narrowed,
    });
    // Widening back to every workspace takes nothing away.
    await changeAccess(connectionId, readOnlyEverywhere);
    expect(started).toHaveLength(1);
  }, 60_000);

  test("a delivery that can't be started never blocks the disconnect", async () => {
    started.length = 0;
    const connectionId = await connect();
    const { observability, diagnostics } = capturingObservability();
    const failing = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "host-mcp-connection-webhook-secret-32-bytes",
        publicBaseUrl: origin,
        hostWebhooks: { mcpConnectionRevoked: hook },
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      observability,
      workflowClient: {
        startHostWebhookDelivery: async () => {
          throw new TypeError("temporal unavailable");
        },
      } as unknown as SessionWorkflowClient,
    } as AppDependencies);
    const records = await capturingConsole(async () => {
      await disconnect(failing, connectionId);
      await observability.flush();
    });
    const warnings = records.filter(
      (record) => record.message === "host webhook delivery could not be started",
    );
    expect(warnings).toHaveLength(1);
    // Read before matching: an asymmetric matcher may stand in for it afterwards.
    const correlationId = warnings[0]!.correlationId;
    expect(warnings[0]).toMatchObject({
      level: "warn",
      errorCode: "host_webhook_delivery_start_failed",
      origin: "api",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // Organization, connection and delivery ids are identifiers: never public.
    const publicText = JSON.stringify(records);
    expect(publicText).not.toContain(person.organizationId);
    expect(publicText).not.toContain(connectionId);
    expect(publicText).not.toContain(hook.secret);
    const diagnostic = diagnostics().find((record) => record.diagnosticId === correlationId);
    expect(diagnostic).toMatchObject({
      code: "host_webhook_delivery_start_failed",
      stage: "host_webhook.delivery_start",
      organizationId: person.organizationId,
      connectionId,
      deliveryId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(diagnostic)).not.toContain(hook.secret);
    expect(await observability.prometheusMetrics()).toMatch(
      /^opengeni_host_webhook_delivery_start_failures_total\{change="revoked",event="mcp_connection\.revoked",[^}]*\} 1$/m,
    );
    expect(started).toHaveLength(0);
    const [row] = await shared.admin<{ revoked_at: Date | null }[]>`
      select revoked_at from mcp_oauth_refresh_tokens
      where family_id = ${connectionId} order by generation desc limit 1`;
    expect(row!.revoked_at).not.toBeNull();
  }, 60_000);

  test("a start its workflow client's deadline ends is reported, and the disconnect is written", async () => {
    const connectionId = await connect();
    let calls = 0;
    const { observability, diagnostics } = capturingObservability();
    // The workflow client bounds the start (the API's Temporal client gives it
    // HOST_WEBHOOK_DELIVERY_START_TIMEOUT_MS); this one ends it early, as that
    // deadline would.
    const deadline = 200;
    const hung = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "host-mcp-connection-webhook-secret-32-bytes",
        publicBaseUrl: origin,
        hostWebhooks: { mcpConnectionRevoked: hook },
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      observability,
      workflowClient: {
        startHostWebhookDelivery: () => {
          calls += 1;
          return new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("Deadline exceeded")), deadline),
          );
        },
      } as unknown as SessionWorkflowClient,
    } as AppDependencies);
    const startedAt = Date.now();
    await capturingConsole(async () => {
      await disconnect(hung, connectionId);
      await observability.flush();
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(deadline - 50);
    expect(elapsed).toBeLessThan(HOST_WEBHOOK_DELIVERY_START_TIMEOUT_MS);
    // The start was attempted once and never completed: no delivery is recorded as started.
    expect(calls).toBe(1);
    expect(diagnostics()).toEqual([
      expect.objectContaining({ code: "host_webhook_delivery_start_failed", connectionId }),
    ]);
    expect(started.filter(({ event }) => event.connectionId === connectionId)).toEqual([]);
    const [row] = await shared.admin<{ revoked_at: Date | null }[]>`
      select revoked_at from mcp_oauth_refresh_tokens
      where family_id = ${connectionId} order by generation desc limit 1`;
    expect(row!.revoked_at).not.toBeNull();
  }, 60_000);

  test("an API refuses a plain http webhook outside local/test, and accepts it in test", () => {
    const appIn = (environment: string, url: string) =>
      createApp({
        settings: testSettings({
          environment,
          databaseUrl: shared.adminUrl,
          productAccessMode: "managed",
          betterAuthSecret: "host-mcp-connection-webhook-secret-32-bytes",
          publicBaseUrl: origin,
          hostWebhooks: { mcpConnectionRevoked: { ...hook, url } },
        } as never),
        db: client.db,
        bus: new MemoryEventBus(),
        workflowClient,
      } as AppDependencies);
    expect(() => appIn("production", "http://host.internal/hooks")).toThrow(
      "HOST_WEBHOOK_URL_HTTPS_REQUIRED",
    );
    expect(() => appIn("test", "http://host.internal/hooks")).not.toThrow();
  });

  test("an API configured with the webhook refuses to start without a way to deliver it", () => {
    expect(() =>
      createApp({
        settings: testSettings({
          databaseUrl: shared.adminUrl,
          productAccessMode: "managed",
          betterAuthSecret: "host-mcp-connection-webhook-secret-32-bytes",
          publicBaseUrl: origin,
          hostWebhooks: { mcpConnectionRevoked: hook },
        }),
        db: client.db,
        bus: new MemoryEventBus(),
        workflowClient: {} as never,
      } as AppDependencies),
    ).toThrow("HOST_WEBHOOK_DELIVERY_UNAVAILABLE");
  });

  test("never without the configured webhook", async () => {
    started.length = 0;
    const connectionId = await connect();
    await disconnect(unconfigured, connectionId);
    expect(started).toHaveLength(0);
  }, 60_000);
});
