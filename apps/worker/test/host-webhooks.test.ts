import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  organizationAccessPresetPermissions,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import type { HostWebhookDeliveryRequest } from "@opengeni/contracts/organization-governance";
import {
  consumeMcpOAuthAuthorizationRequest,
  createDb,
  createMcpOAuthAuthorizationRequest,
  exchangeMcpOAuthAuthorizationCode,
  revokeOrganizationMcpConnection,
  updateOrganizationMcpConnectionAccess,
  type DbClient,
} from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createHostWebhookActivities } from "../src/activities/host-webhooks";
import type { ControlActivityServices } from "../src/activities/types";
import {
  HOST_WEBHOOK_CONFIRM_ATTEMPTS,
  HOST_WEBHOOK_DELIVERY_RETRY,
  runHostWebhookDelivery,
  type HostWebhookDeliveryActivities,
} from "../src/workflows/host-webhooks";

/*
 * A host that projects its members' MCP connections hears, once, when one is
 * disconnected or loses access. The worker sends the delivery only after the
 * change is committed, signs the exact body, and retries the same body under
 * the same delivery id until the host answers 2xx.
 */

const secret = "host-webhook-test-secret-at-least-32-bytes";
const accountId = crypto.randomUUID();
const subjectId = `user:${crypto.randomUUID()}`;
const clientId = `ogmcp_client_${crypto.randomUUID()}`;
const redirectUri = "http://127.0.0.1:4567/callback";
const resource = "https://api.example.test/v1/mcp";
const hash = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
const readOnly: OrganizationAccessPolicy = {
  preset: "read_only",
  permissions: organizationAccessPresetPermissions("read_only"),
  workspaceScope: { kind: "all" },
};

type Received = { delivery: string | null; signature: string | null; body: string };
const received: Received[] = [];
/** Statuses the receiver answers in turn; then 200. */
const answers: number[] = [];
let receiver: ReturnType<typeof Bun.serve>;
let shared: SharedTestDatabase;
let client: DbClient;
let activities: ReturnType<typeof createHostWebhookActivities>;

beforeAll(async () => {
  receiver = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({
        delivery: request.headers.get("x-host-delivery"),
        signature: request.headers.get("x-host-signature"),
        body: await request.text(),
      });
      return new Response(null, { status: answers.shift() ?? 200 });
    },
  });
  const acquired = await acquireSharedTestDatabase("worker-host-webhooks");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, 'Webhook fixture')`;
  await shared.admin`insert into mcp_oauth_clients (
    client_id, redirect_uris, client_name, grant_types, response_types, registration_scope_hash
  ) values (
    ${clientId}, ${shared.admin.json([redirectUri])}, 'Outside agent',
    ${shared.admin.json(["authorization_code", "refresh_token"])},
    ${shared.admin.json(["code"])}, ${"5".repeat(64)}
  )`;
  const settings = testSettings({
    hostWebhooks: {
      mcpConnectionRevoked: { url: `http://127.0.0.1:${receiver.port}/hooks`, secret },
    },
  });
  activities = createHostWebhookActivities(
    async () => ({ db: client.db, settings }) as unknown as ControlActivityServices,
  );
}, 180_000);

afterAll(async () => {
  receiver?.stop(true);
  await client?.close();
  await shared?.release();
}, 60_000);

async function connect(): Promise<string> {
  const requestHash = hash();
  await createMcpOAuthAuthorizationRequest(client.db, {
    requestHash,
    clientId,
    accountId,
    workspaceId: null,
    subjectId,
    resource,
    redirectUri,
    codeChallenge: "c".repeat(43),
    state: null,
    permissions: [],
    toolIdentities: [],
    organizationAccess: readOnly,
    expiresAt: inDays(1),
  });
  const codeHash = hash();
  await consumeMcpOAuthAuthorizationRequest(client.db, {
    requestHash,
    subjectId,
    codeHash,
    codeExpiresAt: inDays(1),
  });
  const exchanged = await exchangeMcpOAuthAuthorizationCode(client.db, {
    codeHash,
    clientId,
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

function revokeRequest(connectionId: string): HostWebhookDeliveryRequest {
  return {
    deliveryId: crypto.randomUUID(),
    event: {
      type: "mcp_connection.revoked",
      organizationId: accountId,
      connectionId,
      change: "revoked",
    },
  };
}

const noWait = async () => undefined;

function signatureOf(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("the mcp_connection.revoked host webhook", () => {
  test("a revoke is delivered once, signed, after it committed", async () => {
    received.length = 0;
    const connectionId = await connect();
    const request = revokeRequest(connectionId);
    // Before the revoke commits there is nothing to send.
    expect(await activities.confirmHostWebhookChange(request)).toEqual({ status: "pending" });
    let checks = 0;
    const outcome = await runHostWebhookDelivery(
      request,
      {
        confirmHostWebhookChange: async (input) => {
          checks += 1;
          // The API writes the change after starting the delivery.
          if (checks === 2)
            await revokeOrganizationMcpConnection(client.db, { accountId, connectionId });
          return await activities.confirmHostWebhookChange(input);
        },
        deliverHostWebhook: activities.deliverHostWebhook,
      },
      noWait,
    );
    expect(outcome).toBe("delivered");
    expect(received).toHaveLength(1);
    const [delivery] = received;
    expect(delivery!.delivery).toBe(request.deliveryId);
    expect(delivery!.signature).toBe(signatureOf(delivery!.body));
    const [row] = await shared.admin<{ revoked_at: Date }[]>`
      select revoked_at from mcp_oauth_refresh_tokens
      where family_id = ${connectionId} order by generation desc limit 1`;
    expect(JSON.parse(delivery!.body)).toEqual({
      type: "mcp_connection.revoked",
      change: "revoked",
      connectionId,
      organizationId: accountId,
      workspaceId: null,
      clientId,
      revokedAt: row!.revoked_at.toISOString(),
      consentScope: readOnly,
    });
  }, 60_000);

  test("a 500 from the host is retried with the same delivery id and body", async () => {
    received.length = 0;
    const connectionId = await connect();
    await revokeOrganizationMcpConnection(client.db, { accountId, connectionId });
    const request = revokeRequest(connectionId);
    const state = await activities.confirmHostWebhookChange(request);
    if (state.status !== "committed") throw new Error("the revoke is committed");
    answers.push(500);
    const input = { deliveryId: request.deliveryId, body: state.body };
    // Temporal runs the activity again under HOST_WEBHOOK_DELIVERY_RETRY.
    await expect(activities.deliverHostWebhook(input)).rejects.toMatchObject({
      type: "HOST_WEBHOOK_REJECTED",
      nonRetryable: false,
    });
    await activities.deliverHostWebhook(input);
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(received[1]!);
    expect(received[0]!.signature).toBe(signatureOf(state.body));
    expect(HOST_WEBHOOK_DELIVERY_RETRY.maximumAttempts).toBeGreaterThan(1);
    expect(HOST_WEBHOOK_DELIVERY_RETRY.backoffCoefficient).toBeGreaterThan(1);
  }, 60_000);

  test("a refusal the host will repeat ends the delivery", async () => {
    answers.push(400);
    await expect(
      activities.deliverHostWebhook({ deliveryId: crypto.randomUUID(), body: "{}" }),
    ).rejects.toMatchObject({ type: "HOST_WEBHOOK_REFUSED", nonRetryable: true });
  }, 60_000);

  test("a consent downgrade is delivered with the new scope; a later revoke supersedes it", async () => {
    received.length = 0;
    const connectionId = await connect();
    const narrowed: OrganizationAccessPolicy = {
      ...readOnly,
      workspaceScope: { kind: "selected", workspaceIds: [crypto.randomUUID()] },
    };
    const request: HostWebhookDeliveryRequest = {
      deliveryId: crypto.randomUUID(),
      event: {
        type: "mcp_connection.revoked",
        organizationId: accountId,
        connectionId,
        change: "consent_downgraded",
        consentScope: narrowed,
      },
    };
    expect(await activities.confirmHostWebhookChange(request)).toEqual({ status: "pending" });
    await updateOrganizationMcpConnectionAccess(client.db, {
      accountId,
      connectionId,
      organizationAccess: narrowed,
    });
    expect(await runHostWebhookDelivery(request, activities, noWait)).toBe("delivered");
    expect(JSON.parse(received[0]!.body)).toMatchObject({
      change: "consent_downgraded",
      revokedAt: null,
      consentScope: narrowed,
    });
    await revokeOrganizationMcpConnection(client.db, { accountId, connectionId });
    expect(await activities.confirmHostWebhookChange(request)).toEqual({ status: "superseded" });
  }, 60_000);

  test("a change that never commits sends nothing", async () => {
    received.length = 0;
    const deliver: HostWebhookDeliveryActivities["deliverHostWebhook"] = async () => {
      throw new Error("must not deliver");
    };
    let checks = 0;
    const outcome = await runHostWebhookDelivery(
      revokeRequest(await connect()),
      {
        confirmHostWebhookChange: async (input) => {
          checks += 1;
          return await activities.confirmHostWebhookChange(input);
        },
        deliverHostWebhook: deliver,
      },
      noWait,
    );
    expect(outcome).toBe("not_committed");
    expect(checks).toBe(HOST_WEBHOOK_CONFIRM_ATTEMPTS);
    expect(received).toHaveLength(0);
  }, 60_000);
});
