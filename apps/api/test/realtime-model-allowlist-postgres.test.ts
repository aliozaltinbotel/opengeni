import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  REALTIME_MODEL_NOT_ALLOWED,
  type OrganizationGovernancePort,
} from "@opengeni/contracts/organization-governance";
import type { AppDependencies } from "@opengeni/core";
import {
  bootstrapWorkspace,
  connectSubscriptionCoreCodexConnection,
  createDb,
  createSession,
  encryptEnvironmentValue,
  type DbClient,
} from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * `OrganizationGovernancePort.allowedRealtimeModels`: a governed
 * organization's realtime catalog lists only the allowed voice models, and the
 * server refuses a voice start with any other one. No allowlist, or an
 * organization the host does not govern, keeps the full stock catalog.
 */
const DELEGATION_SECRET = "realtime-model-allowlist-secret-with-32-bytes";
const encryptionKey = Buffer.alloc(32, 7);
const CODEX_LIVE = "gpt-live-1-boulder-alpha";
const SUPERGROK = "supergrok/grok-voice-think-fast-2.0";
const MANAGED_GATEWAY = "opengeni-gateway/openai/gpt-realtime-2.1";

setDefaultTimeout(60_000);

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("realtime-model-allowlist");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Fixture = { accountId: string; workspaceId: string; sessionId: string; headers: HeadersInit };

async function fixture(source: string): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const subjectId = `user:${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: source,
    accountExternalId: `realtime-allowlist-${suffix}`,
    accountName: "Realtime allowlist",
    workspaceExternalSource: "test",
    workspaceExternalId: `realtime-allowlist-${suffix}`,
    workspaceName: "Realtime allowlist",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared.admin`insert into workspaces(account_id, name)
    values (${grant.accountId}, 'Fixture owner Personal') returning id`;
  await shared.admin`insert into organization_memberships
    (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${subjectId}, 'owner', 'active', ${personal!.id})
    on conflict (account_id, subject_id) do nothing`;
  // A connected Codex account makes Codex Live startable for the allowed case.
  const credential = await connectSubscriptionCoreCodexConnection(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    credentialEncrypted: encryptEnvironmentValue(
      encryptionKey,
      JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }),
    ),
    providerAccountId: `realtime-allowlist-provider-${suffix}`,
    providerSubjectId: subjectId,
    accountEmail: null,
    label: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    lastRefreshAt: new Date(),
    subjectId,
  });
  if (credential.kind !== "connected") throw new Error(`fixture refused: ${credential.reason}`);
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
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
    workspaceId: grant.workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: ["sessions:read", "sessions:control", "workspace:read"],
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}

const HOST_SOURCE = "test-host:realtime-tenant";
function port(allowedRealtimeModels?: readonly string[]): OrganizationGovernancePort {
  return {
    governs: ({ externalSource }) => externalSource === HOST_SOURCE,
    decide: () => "refuse",
    ...(allowedRealtimeModels ? { allowedRealtimeModels } : {}),
  };
}

function api(organizationGovernance?: OrganizationGovernancePort) {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      environmentsEncryptionKey: encryptionKey.toString("base64"),
      codexSubscriptionEnabled: true,
      vercelAiGatewayApiKey: "gateway-test-key",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    managedAuth: null,
    objectStorage: null,
    ...(organizationGovernance ? { organizationGovernance } : {}),
  } as unknown as AppDependencies);
}

async function catalog(app: ReturnType<typeof api>, f: Fixture): Promise<string[]> {
  const response = await app.request(`/v1/workspaces/${f.workspaceId}/realtime-model-catalog`, {
    headers: f.headers,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { models: Array<{ id: string }> }).models.map((m) => m.id);
}

async function start(app: ReturnType<typeof api>, f: Fixture, model: string) {
  return await app.request(`/v1/workspaces/${f.workspaceId}/sessions/${f.sessionId}/realtime`, {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      browserInstanceId: `browser-${crypto.randomUUID()}`,
      ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      model,
    }),
  });
}

async function modes(f: Fixture): Promise<number> {
  const [row] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from session_realtime_modes where session_id = ${f.sessionId}`;
  return row!.count;
}

describe("realtime model allowlist", () => {
  test("a governed organization's catalog lists only the allowed models", async () => {
    const f = await fixture(HOST_SOURCE);
    const stock = await catalog(api(), f);
    expect(stock).toEqual(expect.arrayContaining([CODEX_LIVE, SUPERGROK, MANAGED_GATEWAY]));
    expect(await catalog(api(port([CODEX_LIVE, MANAGED_GATEWAY])), f)).toEqual(
      stock.filter((id) => id === CODEX_LIVE || id === MANAGED_GATEWAY),
    );
    expect(await catalog(api(port([CODEX_LIVE])), f)).toEqual([CODEX_LIVE]);
    expect(await catalog(api(port([])), f)).toEqual([]);
  });

  test("a voice start with a model outside the allowlist is refused before anything is written", async () => {
    const f = await fixture(HOST_SOURCE);
    const app = api(port([CODEX_LIVE]));
    const refused = await start(app, f, SUPERGROK);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: unknown }).error).toMatchObject({
      code: "forbidden",
      details: { code: REALTIME_MODEL_NOT_ALLOWED, model: SUPERGROK },
    });
    expect(await modes(f)).toBe(0);
    // The allowed model still starts.
    expect((await start(app, f, CODEX_LIVE)).status).toBe(201);
    expect(await modes(f)).toBe(1);
  });

  test("no allowlist, and an organization the host does not govern, keep the stock catalog", async () => {
    const governed = await fixture(HOST_SOURCE);
    const ungoverned = await fixture("test");
    const stock = await catalog(api(), governed);
    expect(stock).toEqual(expect.arrayContaining([CODEX_LIVE, SUPERGROK]));
    expect(stock.length).toBeGreaterThan(2);
    expect(await catalog(api(port()), governed)).toEqual(stock);
    expect(await catalog(api(port([CODEX_LIVE])), ungoverned)).toEqual(stock);
    // Ungoverned: a model off the host's list is not refused by it.
    expect((await start(api(port([CODEX_LIVE])), ungoverned, SUPERGROK)).status).not.toBe(403);
  });
});
