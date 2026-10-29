import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isReadOnlyPermissionSet, type Permission } from "@opengeni/contracts";
import type { AppDependencies } from "@opengeni/core";
import {
  createDb,
  createManagedOrganization,
  getMcpOAuthConnectionRecord,
  mcpOAuthConnectionConsentScope,
  type DbClient,
} from "@opengeni/db";
import type { LocalMcpServerRegistration } from "@opengeni/runtime/workspace-tool-gateway";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * The workspace MCP OAuth consent offers an access level (Full, Read only,
 * Custom) as the organization sign-in does: the level narrows the grant's
 * permissions, freezes only the tools that level allows, and is recorded on
 * the grant. A form without a level keeps the behaviour from before the
 * choice existed (Full).
 */

setDefaultTimeout(60_000);

const origin = "http://opengeni.test";
const redirectUri = "http://127.0.0.1:4567/callback";

let shared: SharedTestDatabase;
let client: DbClient;
let app: ReturnType<typeof createApp>;
let person: { cookie: string; subjectId: string };
let workspaceId: string;
let organizationId: string;

/** The tool-set version the host server publishes now; undefined publishes none. */
let publishedToolSetVersion: string | undefined;

/** A host tool server with a read tool, a write tool and a tool that says nothing. */
async function hostRegistration(): Promise<LocalMcpServerRegistration> {
  const server = new McpServer({ name: "host-acme", version: "1.0.0" });
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
  server.registerTool(
    "get_status",
    { description: "Read the status.", annotations: { readOnlyHint: true } },
    async () => text("status ok"),
  );
  server.registerTool(
    "reserve",
    { description: "Make a reservation.", annotations: { readOnlyHint: false } },
    async () => text("reserved"),
  );
  server.registerTool("note", { description: "Unannotated." }, async () => text("noted"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "host-acme", version: "1.0.0" });
  type RuntimeServer = LocalMcpServerRegistration["server"];
  let connected = false;
  const call = async (toolName: string, args: Record<string, unknown> | null) =>
    (await mcpClient.callTool({ name: toolName, arguments: args ?? {} })) as CallToolResult;
  return {
    id: "acme",
    ...(publishedToolSetVersion ? { toolSetVersion: publishedToolSetVersion } : {}),
    server: {
      name: "host:acme",
      cacheToolsList: false,
      connect: async () => {
        if (connected) return;
        await server.connect(serverTransport);
        await mcpClient.connect(clientTransport);
        connected = true;
      },
      close: async () => {
        await Promise.allSettled([mcpClient.close(), server.close()]);
      },
      listTools: async () =>
        (await mcpClient.listTools()).tools as unknown as Awaited<
          ReturnType<RuntimeServer["listTools"]>
        >,
      callTool: async (toolName, args) => (await call(toolName, args)).content,
      callToolResult: async (toolName, args) =>
        (await call(toolName, args)) as unknown as Awaited<
          ReturnType<NonNullable<RuntimeServer["callToolResult"]>>
        >,
      invalidateToolsCache: async () => undefined,
    },
  };
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-mcp-consent");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  app = createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "workspace-mcp-consent-test-secret-32-bytes",
      publicBaseUrl: origin,
      mcpOauthEnabled: true,
      environmentsEncryptionKey: Buffer.alloc(32, 46).toString("base64"),
      mcpServers: [{ id: "acme", url: "https://host.invalid/acme/mcp", cacheToolsList: false }],
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    workspaceToolServers: async () => [await hostRegistration()],
  } as AppDependencies);
  const email = `consent-${crypto.randomUUID()}@example.test`;
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Consent Person", email, password: "password1234" }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const signedIn = await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", rememberMe: true }),
  });
  const cookie = signedIn.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="))!
    .split(";", 1)[0]!;
  const [user] = await shared.admin<{ id: string }[]>`
    select id from auth_users where email = ${email}`;
  person = { cookie, subjectId: `user:${user!.id}` };
  const created = await createManagedOrganization(client.db, {
    subjectId: person.subjectId,
    subjectLabel: email,
    name: "Consent organization",
    operationId: crypto.randomUUID(),
  });
  organizationId = created.organization.id;
  workspaceId = created.workspaceId;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const resource = () => `${origin}/v1/workspaces/${workspaceId}/mcp`;

async function registerClient() {
  const registered = await app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Consent agent",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { clientId, verifier, challenge };
}

/** Open the consent page; returns its HTML and request token. */
async function openConsent(mcpClient: Awaited<ReturnType<typeof registerClient>>) {
  const authorize = new URL("/oauth/authorize", origin);
  for (const [key, value] of Object.entries({
    response_type: "code",
    scope: "mcp:access",
    client_id: mcpClient.clientId,
    redirect_uri: redirectUri,
    code_challenge: mcpClient.challenge,
    code_challenge_method: "S256",
    resource: resource(),
    state: "consent-state",
  }))
    authorize.searchParams.set(key, value);
  const page = await app.request(authorize.pathname + authorize.search, {
    headers: { cookie: person.cookie },
  });
  expect(page.status).toBe(200);
  const html = await page.text();
  const requestToken = /ogmcp_req_[A-Za-z0-9_-]+/u.exec(html)![0];
  return { html, requestToken };
}

/** Consent with `fields` (no level field: the form from before the choice), exchange, return a token. */
async function connect(fields: Array<[string, string]>) {
  const mcpClient = await registerClient();
  const { requestToken } = await openConsent(mcpClient);
  const approved = await app.request("/oauth/authorize", {
    method: "POST",
    headers: {
      cookie: person.cookie,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams([
      ["request", requestToken],
      ["decision", "approve"],
      ["workspace_id", workspaceId],
      ...fields,
    ]).toString(),
  });
  const refresh = approved.headers.get("refresh") ?? "";
  if (!refresh.includes("code=")) return { refused: approved };
  const code = new URL(refresh.slice(refresh.indexOf("url=") + 4)).searchParams.get("code")!;
  const exchanged = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: mcpClient.clientId,
      code,
      code_verifier: mcpClient.verifier,
      redirect_uri: redirectUri,
      resource: resource(),
    }).toString(),
  });
  expect(exchanged.status).toBe(200);
  const { access_token: accessToken } = (await exchanged.json()) as { access_token: string };
  return { accessToken };
}

async function mcp(
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {},
  credential: Record<string, string> = { authorization: `Bearer ${accessToken}` },
) {
  const response = await app.request(`/v1/workspaces/${workspaceId}/mcp`, {
    method: "POST",
    headers: {
      ...credential,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result?: {
      tools?: Array<{ name: string }>;
      content?: Array<{ text?: string }>;
      _meta?: Record<string, unknown>;
    };
    error?: { code: number; data?: { code?: string } };
  };
}

async function acmeTools(accessToken: string): Promise<string[]> {
  const listed = await mcp(accessToken, "tools/list");
  return (listed.result?.tools ?? [])
    .map(({ name }) => name)
    .filter((name) => name.startsWith("acme__"))
    .sort();
}

/** The connection's recorded grant, read the way a host's connection read does. */
async function recordedGrant(accessToken: string) {
  const hash = createHash("sha256").update(accessToken).digest("hex");
  const [row] = await shared.admin<{ refresh_family_id: string; consent_preset: string | null }[]>`
    select refresh_family_id, consent_preset from mcp_oauth_access_tokens where token_hash = ${hash}`;
  const record = await getMcpOAuthConnectionRecord(client.db, {
    accountId: organizationId,
    connectionId: row!.refresh_family_id,
  });
  return { consentPreset: row!.consent_preset, scope: mcpOAuthConnectionConsentScope(record!) };
}

/** The person's live permissions in the workspace. */
async function memberPermissions(): Promise<Permission[]> {
  const access = (await (
    await app.request("/v1/access/me", { headers: { cookie: person.cookie } })
  ).json()) as { workspaceGrants: Array<{ workspaceId: string; permissions: Permission[] }> };
  return access.workspaceGrants.find((grant) => grant.workspaceId === workspaceId)!.permissions;
}

describe("workspace MCP OAuth consent levels", () => {
  test("the consent page offers Full, Read only and Custom with the person's permissions", async () => {
    const { html } = await openConsent(await registerClient());
    expect(html).toContain('name="access_preset" value="full" checked');
    expect(html).toContain('name="access_preset" value="read_only"');
    expect(html).toContain('name="access_preset" value="custom"');
    expect(html).toContain('name="permission" value="sessions:read"');
    expect(html).not.toContain('name="permission" value="workspace:read"');
  });

  test("a form without a level is Full: every tool, the member's permissions, recorded as full", async () => {
    const { accessToken } = await connect([]);
    expect(await acmeTools(accessToken!)).toEqual([
      "acme__get_status",
      "acme__note",
      "acme__reserve",
    ]);
    const reserved = await mcp(accessToken!, "tools/call", {
      name: "acme__reserve",
      arguments: {},
    });
    expect(reserved.result?.content?.[0]?.text).toBe("reserved");
    const recorded = await recordedGrant(accessToken!);
    expect(recorded.consentPreset).toBe("full");
    expect(recorded.scope.preset).toBe("full");
    expect([...recorded.scope.permissions].sort()).toEqual([...(await memberPermissions())].sort());
  });

  test("Read only freezes only read tools and read permissions", async () => {
    const { accessToken } = await connect([["access_preset", "read_only"]]);
    expect(await acmeTools(accessToken!)).toEqual(["acme__get_status"]);
    const refused = await mcp(accessToken!, "tools/call", { name: "acme__reserve", arguments: {} });
    expect(refused.error).toMatchObject({ code: -32602, data: { code: "TOOL_NOT_CONSENTED" } });
    const recorded = await recordedGrant(accessToken!);
    expect(recorded.scope.preset).toBe("read_only");
    expect(recorded.scope.permissions).toContain("workspace:read");
    expect(isReadOnlyPermissionSet(recorded.scope.permissions as Permission[])).toBe(true);
    expect(recorded.scope.permissions.length).toBeLessThan((await memberPermissions()).length);
  });

  test("Custom keeps only the chosen permissions the person holds", async () => {
    const readOnly = await connect([
      ["access_preset", "custom"],
      ["permission", "sessions:read"],
      ["permission", "billing:manage-everything"],
    ]);
    expect(await acmeTools(readOnly.accessToken!)).toEqual(["acme__get_status"]);
    const reading = await recordedGrant(readOnly.accessToken!);
    expect(reading.scope.preset).toBe("custom");
    expect([...reading.scope.permissions].sort()).toEqual(["sessions:read", "workspace:read"]);

    const writing = await connect([
      ["access_preset", "custom"],
      ["permission", "sessions:read"],
      ["permission", "sessions:create"],
    ]);
    expect(await acmeTools(writing.accessToken!)).toEqual([
      "acme__get_status",
      "acme__note",
      "acme__reserve",
    ]);
    expect([...(await recordedGrant(writing.accessToken!)).scope.permissions].sort()).toEqual([
      "sessions:create",
      "sessions:read",
      "workspace:read",
    ]);
  });

  test("an unknown level is refused before a code is issued", async () => {
    const { refused } = await connect([["access_preset", "everything"]]);
    expect(refused).toBeDefined();
    expect(refused!.status).toBe(400);
    expect(await refused!.text()).toContain("Choose an access level");
  });
});

describe("workspace MCP tool-set versions for re-consent", () => {
  const toolSets = async (accessToken: string, credential?: Record<string, string>) =>
    (await mcp(accessToken, "tools/list", {}, credential)).result?._meta?.["opengeni/toolSets"];

  test("tools/list shows the consented and current version, and a changed set shows the difference", async () => {
    publishedToolSetVersion = "sha256:v1";
    try {
      const first = await connect([]);
      expect(await toolSets(first.accessToken!)).toEqual({
        acme: { version: "sha256:v1", consentedVersion: "sha256:v1" },
      });
      // The host publishes a changed tool set: the old connection sees it.
      publishedToolSetVersion = "sha256:v2";
      expect(await toolSets(first.accessToken!)).toEqual({
        acme: { version: "sha256:v2", consentedVersion: "sha256:v1" },
      });
      // Consenting again records the current version.
      const second = await connect([]);
      expect(await toolSets(second.accessToken!)).toEqual({
        acme: { version: "sha256:v2", consentedVersion: "sha256:v2" },
      });
      // A consent recorded before versions existed has no consented version.
      const hash = createHash("sha256").update(first.accessToken!).digest("hex");
      await shared.admin`
        update mcp_oauth_access_tokens set tool_set_versions = null where token_hash = ${hash}`;
      expect(await toolSets(first.accessToken!)).toEqual({
        acme: { version: "sha256:v2", consentedVersion: null },
      });
      // A caller without a consent sees the current version only.
      expect(await toolSets("", { cookie: person.cookie })).toEqual({
        acme: { version: "sha256:v2" },
      });
    } finally {
      publishedToolSetVersion = undefined;
    }
  });

  test("without a published version tools/list carries no tool-set metadata", async () => {
    const { accessToken } = await connect([]);
    const listed = await mcp(accessToken!, "tools/list");
    expect(listed.result?.tools?.length).toBeGreaterThan(0);
    expect(listed.result?._meta).toBeUndefined();
  });
});
