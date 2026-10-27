import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Settings } from "@opengeni/config";
import type { AccessGrant } from "@opengeni/contracts";
import type { AppDependencies } from "@opengeni/core";
import {
  bootstrapWorkspace,
  consumeMcpOAuthAuthorizationRequest,
  createDb,
  createMcpOAuthAuthorizationRequest,
  createOrganizationApiKey,
  deleteWorkspace,
  exchangeMcpOAuthAuthorizationCode,
  registerMcpOAuthClient,
  revokeOrganizationApiKey,
  rotateMcpOAuthRefreshToken,
  type DbClient,
} from "@opengeni/db";
import type { LocalMcpServerRegistration } from "@opengeni/runtime/workspace-tool-gateway";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { HTTPException } from "hono/http-exception";
import { createApp } from "../src/app";
import {
  buildWorkspaceToolGatewayMcpServer,
  HOST_MCP_METHOD_CONFLICT,
  prepareWorkspaceToolGatewayForGrant,
  type HostMcpMethodConflictReason,
  type PreparedWorkspaceToolGateway,
} from "../src/workspace-tool-gateway";

setDefaultTimeout(60_000);

type WorkspaceToolServersPort = NonNullable<AppDependencies["workspaceToolServers"]>;
type ExtensionMethods = NonNullable<LocalMcpServerRegistration["extensionMethods"]>;
type JsonRpcBody = {
  result?: Record<string, unknown> & { capabilities?: Record<string, unknown> };
  error?: { code?: number; message?: string; data?: unknown };
};
type HandlerCall = { method: string; params: unknown; grant: AccessGrant; signal: unknown };

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const remote = startTestMcpServer();

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-mcp-extension-methods");
  if (!shared) throw new Error("workspace MCP extension-method tests require PostgreSQL");
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  remote.close();
  await client?.close();
  await shared?.release();
}, 60_000);

/** A host's in-process MCP server, adapted to the runtime's local registration. */
async function hostRegistration(
  id: string,
  extensionMethods?: ExtensionMethods,
  closed?: string[],
): Promise<LocalMcpServerRegistration> {
  const server = new McpServer({ name: `host-${id}`, version: "1.0.0" });
  server.registerTool("get_status", { description: "Current status." }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: `host-${id}`, version: "1.0.0" });
  type RuntimeServer = LocalMcpServerRegistration["server"];
  let connected = false;
  const call = async (toolName: string, args: Record<string, unknown> | null) =>
    (await mcpClient.callTool({ name: toolName, arguments: args ?? {} })) as CallToolResult;
  return {
    id,
    server: {
      name: `host:${id}`,
      cacheToolsList: false,
      connect: async () => {
        if (connected) return;
        await server.connect(serverTransport);
        await mcpClient.connect(clientTransport);
        connected = true;
      },
      close: async () => {
        closed?.push(id);
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
    ...(extensionMethods ? { extensionMethods } : {}),
  };
}

/** Host event methods that record each call and answer with the caller's workspace. */
function eventMethods(calls: HandlerCall[]): ExtensionMethods {
  const recording =
    (method: string, result: (grant: AccessGrant) => Record<string, unknown>) =>
    async (params: unknown, ctx: { grant: AccessGrant; signal?: AbortSignal }) => {
      calls.push({ method, params, grant: ctx.grant, signal: ctx.signal });
      return result(ctx.grant);
    };
  return {
    "events/list": recording("events/list", (grant) => ({
      events: [{ name: "reservation.created", workspace: grant.workspaceId }],
    })),
    "events/subscribe": recording("events/subscribe", () => ({ subscriptionId: "sub-1" })),
  };
}

type ToolIdentity = { serverId: string; toolName: string };
/** A workspace-bound MCP OAuth connection: its access token and a real revocation. */
type OAuthConnection = { bearer: string; revokeByRefreshReuse: () => Promise<void> };
type World = {
  owner: AccessGrant;
  post: (body: unknown, bearer?: string) => Promise<{ status: number; body: JsonRpcBody }>;
  revokeKey: () => Promise<void>;
  connectOAuth: (toolIdentities: ToolIdentity[]) => Promise<OAuthConnection>;
  cleanup: () => Promise<void>;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const randomToken = () => crypto.randomUUID().replaceAll("-", "").repeat(2);
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const OAUTH_REDIRECT = "http://127.0.0.1:4567/callback";
const OAUTH_CHALLENGE = "c".repeat(43);

async function world(
  mcpServers: Settings["mcpServers"],
  workspaceToolServers?: WorkspaceToolServersPort,
): Promise<World> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "workspace-mcp-extension-methods",
    accountExternalId: suffix,
    accountName: "Workspace MCP extension methods",
    workspaceExternalSource: "workspace-mcp-extension-methods",
    workspaceExternalId: suffix,
    workspaceName: "Workspace MCP extension methods",
    subjectId: `human:${suffix}`,
  });
  const owner = access.workspaceGrants[0]! as AccessGrant;
  const bearer = `ogk_ext_${crypto.randomUUID().replaceAll("-", "")}`;
  const key = await createOrganizationApiKey(client!.db, {
    accountId: owner.accountId,
    name: "Workspace MCP extension methods",
    prefix: bearer.slice(0, 12),
    keyHash: createHash("sha256").update(bearer).digest("hex"),
    permissions: ["workspace:read"],
  });
  const settings = settingsFor(mcpServers);
  const app = createApp({
    settings,
    db: client!.db,
    bus: {} as never,
    workflowClient: {} as never,
    objectStorage: null,
    ...(workspaceToolServers ? { workspaceToolServers } : {}),
  });
  let id = 0;
  const post = async (body: unknown, as = bearer) => {
    const response = await app.request(`http://localhost/v1/workspaces/${owner.workspaceId}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${as}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, ...(body as object) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as JsonRpcBody };
  };
  return {
    owner,
    post,
    revokeKey: async () =>
      void (await revokeOrganizationApiKey(client!.db, owner.accountId, key.id)),
    connectOAuth: async (toolIdentities) =>
      await connectOAuth(owner, new URL(settings.publicBaseUrl!).origin, toolIdentities),
    cleanup: async () => void (await deleteWorkspace(client!.db, owner.workspaceId)),
  };
}

const settingsFor = (mcpServers: Settings["mcpServers"]) =>
  testSettings({
    productAccessMode: "configured",
    environmentsEncryptionKey: Buffer.alloc(32, 46).toString("base64"),
    mcpOauthEnabled: true,
    mcpServers,
  });

/**
 * Connects an MCP OAuth client to the owner's workspace MCP through the real
 * authorization-request, code and token rows, consenting to `toolIdentities`.
 */
async function connectOAuth(
  owner: AccessGrant,
  issuer: string,
  toolIdentities: ToolIdentity[],
): Promise<OAuthConnection> {
  const db = client!.db;
  const clientId = `extension-methods-${crypto.randomUUID()}`;
  const resource = `${issuer}/v1/workspaces/${owner.workspaceId}/mcp`;
  await registerMcpOAuthClient(db, {
    clientId,
    redirectUris: [OAUTH_REDIRECT],
    clientName: "Extension methods test",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    registrationScopeHash: sha256(clientId),
  });
  const requestHash = sha256(randomToken());
  await createMcpOAuthAuthorizationRequest(db, {
    requestHash,
    clientId,
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.subjectId,
    resource,
    redirectUri: OAUTH_REDIRECT,
    codeChallenge: OAUTH_CHALLENGE,
    state: null,
    permissions: ["workspace:read"],
    toolIdentities,
    organizationAccess: null,
    expiresAt: inMinutes(10),
  });
  const codeHash = sha256(randomToken());
  await consumeMcpOAuthAuthorizationRequest(db, {
    requestHash,
    subjectId: owner.subjectId,
    codeHash,
    codeExpiresAt: inMinutes(10),
  });
  const bearer = `ogmcp_at_${randomToken()}`;
  const refreshToken = `ogmcp_rt_${randomToken()}`;
  const exchanged = await exchangeMcpOAuthAuthorizationCode(db, {
    codeHash,
    clientId,
    redirectUri: OAUTH_REDIRECT,
    resource,
    codeChallenge: OAUTH_CHALLENGE,
    accessTokenHash: sha256(bearer),
    refreshTokenHash: sha256(refreshToken),
    accessExpiresAt: inMinutes(60),
    refreshExpiresAt: inMinutes(600),
  });
  if (!exchanged) throw new Error("MCP OAuth code exchange failed");
  const rotate = async () =>
    await rotateMcpOAuthRefreshToken(db, {
      refreshTokenHash: sha256(refreshToken),
      clientId,
      resource,
      accessTokenHash: sha256(randomToken()),
      nextRefreshTokenHash: sha256(randomToken()),
      accessExpiresAt: inMinutes(60),
      refreshExpiresAt: inMinutes(600),
    });
  return {
    bearer,
    // Reusing a rotated refresh token revokes its whole family, access tokens included.
    revokeByRefreshReuse: async () => {
      if (!(await rotate())) throw new Error("MCP OAuth refresh rotation failed");
      if (await rotate()) throw new Error("MCP OAuth refresh reuse was not refused");
    },
  };
}

const initialize = {
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "workspace-mcp-extension-methods-test", version: "1.0.0" },
  },
};
const listEvents = { method: "events/list", params: { cursor: "c-1" } };
const remoteServer = { id: "remote", url: remote.url, cacheToolsList: false };
const acmeEntry = { id: "acme", url: "https://host.invalid/acme/mcp", cacheToolsList: false };

describe("host MCP extension methods on the workspace MCP", () => {
  test("stock: an events/list call answers -32601 and no experimental capability is declared", async () => {
    const stock = await world([remoteServer]);
    // A host server that declares no extension methods stays inert too.
    const plain = await world([remoteServer, acmeEntry], async () => [
      await hostRegistration("acme"),
    ]);
    try {
      for (const w of [stock, plain]) {
        const init = await w.post(initialize);
        expect(init.status).toBe(200);
        expect(init.body.result?.capabilities?.tools).toBeDefined();
        expect(init.body.result?.capabilities?.experimental).toBeUndefined();
        const listed = await w.post(listEvents);
        expect(listed.status).toBe(200);
        expect(listed.body.error?.code).toBe(-32601);
        expect(listed.body.result).toBeUndefined();
      }
    } finally {
      await Promise.all([stock.cleanup(), plain.cleanup()]);
    }
  });

  test("a host-declared events/list returns the host result and its handler sees the caller's grant", async () => {
    const calls: HandlerCall[] = [];
    const portGrants: AccessGrant[] = [];
    const w = await world([remoteServer, acmeEntry], async ({ grant }) => {
      portGrants.push(grant);
      return [await hostRegistration("acme", eventMethods(calls))];
    });
    try {
      const init = await w.post(initialize);
      expect(init.status).toBe(200);
      expect(init.body.result?.capabilities?.experimental).toEqual({
        acme: { methods: ["events/list", "events/subscribe"] },
      });

      const listed = await w.post(listEvents);
      expect(listed.status).toBe(200);
      expect(listed.body.error).toBeUndefined();
      expect(listed.body.result).toEqual({
        events: [{ name: "reservation.created", workspace: w.owner.workspaceId }],
      });
      const subscribed = await w.post({ method: "events/subscribe", params: { name: "x" } });
      expect(subscribed.body.result).toEqual({ subscriptionId: "sub-1" });

      expect(calls.map(({ method }) => method)).toEqual(["events/list", "events/subscribe"]);
      const [listCall] = calls;
      expect(listCall!.params).toEqual({ cursor: "c-1" });
      expect(listCall!.signal).toBeInstanceOf(AbortSignal);
      // The handler sees the grant this request was authorized with.
      expect(listCall!.grant).toEqual(portGrants.at(-1)!);
      expect(listCall!.grant.workspaceId).toBe(w.owner.workspaceId);
      expect(listCall!.grant.accountId).toBe(w.owner.accountId);
      expect(listCall!.grant.subjectId.startsWith("api_key:")).toBe(true);
      // Methods the host did not declare are still unknown.
      expect((await w.post({ method: "events/unsubscribe", params: {} })).body.error?.code).toBe(
        -32601,
      );
    } finally {
      await w.cleanup();
    }
  });

  test("a registration whose id is not in settings serves no extension methods", async () => {
    const calls: HandlerCall[] = [];
    const w = await world([remoteServer], async () => [
      await hostRegistration("acme", eventMethods(calls)),
    ]);
    try {
      const init = await w.post(initialize);
      expect(init.body.result?.capabilities?.experimental).toBeUndefined();
      expect((await w.post(listEvents)).body.error?.code).toBe(-32601);
      expect(calls).toHaveLength(0);
    } finally {
      await w.cleanup();
    }
  });

  test("a declared core, core-namespace, malformed or duplicate method is refused with HOST_MCP_METHOD_CONFLICT", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client!.db, {
      accountExternalSource: "workspace-mcp-extension-methods",
      accountExternalId: suffix,
      accountName: "Workspace MCP extension methods",
      workspaceExternalSource: "workspace-mcp-extension-methods",
      workspaceExternalId: suffix,
      workspaceName: "Workspace MCP extension methods",
      subjectId: `human:${suffix}`,
    });
    const grant = access.workspaceGrants[0]! as AccessGrant;
    const settings = settingsFor([remoteServer, acmeEntry, { ...acmeEntry, id: "beta" }]);
    const handler = async () => ({});
    const single = (
      method: string,
      reason: HostMcpMethodConflictReason,
    ): { name: string; reason: HostMcpMethodConflictReason; registrations: Registrations } => ({
      name: method,
      reason,
      registrations: [["acme", { [method]: handler }]],
    });
    type Registrations = Array<[string, ExtensionMethods]>;
    const cases = [
      single("tools/list", "core_method"),
      single("resources/read", "core_method"),
      single("ping", "invalid_name"),
      single("notifications/initialized", "core_method"),
      // Every namespace of a core method is reserved whole, notifications included.
      single("notifications/events", "core_namespace"),
      single("tools/search", "core_namespace"),
      single("resources/watch", "core_namespace"),
      single("prompts/render", "core_namespace"),
      single("tasks/retry", "core_namespace"),
      single("sampling/stop", "core_namespace"),
      single("Events/List", "invalid_name"),
      single("events/list/all", "invalid_name"),
      single("events", "invalid_name"),
      {
        name: "duplicate events/list",
        reason: "duplicate" as const,
        registrations: [
          ["acme", { "events/list": handler }],
          ["beta", { "events/list": handler }],
        ] as Registrations,
      },
    ];
    try {
      for (const { name, reason, registrations } of cases) {
        const closed: string[] = [];
        const deps = {
          db: client!.db,
          settings,
          workspaceToolServers: async () =>
            await Promise.all(
              registrations.map(([id, methods]) => hostRegistration(id, methods, closed)),
            ),
        } as unknown as Parameters<typeof prepareWorkspaceToolGatewayForGrant>[0];
        const refused = prepareWorkspaceToolGatewayForGrant(deps, grant);
        await expect(refused, name).rejects.toMatchObject({
          code: HOST_MCP_METHOD_CONFLICT,
          reason,
        });
        // Every registration is closed on refusal.
        expect(closed.sort(), name).toEqual(registrations.map(([id]) => id).sort());
      }
    } finally {
      await deleteWorkspace(client!.db, grant.workspaceId);
    }
  });

  test("a host handler error answers a generic MCP error without its message", async () => {
    const w = await world([remoteServer, acmeEntry], async () => [
      await hostRegistration("acme", {
        "events/list": async () => {
          throw new Error("connection to db-internal.acme:5432 refused");
        },
        "events/subscribe": async () => {
          throw new McpError(ErrorCode.InvalidParams, "unknown event name");
        },
        "events/unsubscribe": async () => "not an object",
        // An MCP error from another copy of the SDK: same name and code, another prototype.
        "events/describe": async () => {
          throw Object.assign(new Error("MCP error -32602: unknown cursor"), {
            name: "McpError",
            code: ErrorCode.InvalidParams,
            data: { field: "cursor" },
          });
        },
        // An SDK v2 ProtocolError: its own class, that name, no message prefix.
        "events/acknowledge": async () => {
          throw new ForeignProtocolError(ErrorCode.InvalidParams, "Subscription not found: sub-9", {
            subscriptionId: "sub-9",
          });
        },
        // That name without an integer code is not an MCP error.
        "events/replay": async () => {
          throw new ForeignProtocolError("broken" as unknown as number, "replay store at 10.0.0.7");
        },
      }),
    ]);
    try {
      const failed = await w.post(listEvents);
      expect(failed.status).toBe(200);
      expect(failed.body.error?.code).toBe(ErrorCode.InternalError);
      expect(JSON.stringify(failed.body)).not.toContain("db-internal");
      // An McpError the host raised is meant for the client and passes through.
      const invalid = await w.post({ method: "events/subscribe", params: { name: "x" } });
      expect(invalid.body.error?.code).toBe(ErrorCode.InvalidParams);
      expect(invalid.body.error?.message).toContain("unknown event name");
      // A result that is not an object is refused the same generic way.
      const malformed = await w.post({ method: "events/unsubscribe", params: {} });
      expect(malformed.body.error?.code).toBe(ErrorCode.InternalError);
      expect(JSON.stringify(malformed.body)).not.toContain("not an object");
      const foreign = await w.post({ method: "events/describe", params: {} });
      expect(foreign.body.error).toEqual({
        code: ErrorCode.InvalidParams,
        message: "MCP error -32602: unknown cursor",
        data: { field: "cursor" },
      });
      const protocol = await w.post({ method: "events/acknowledge", params: {} });
      expect(protocol.body.error).toEqual({
        code: ErrorCode.InvalidParams,
        message: "MCP error -32602: Subscription not found: sub-9",
        data: { subscriptionId: "sub-9" },
      });
      const unnumbered = await w.post({ method: "events/replay", params: {} });
      expect(unnumbered.body.error?.code).toBe(ErrorCode.InternalError);
      expect(JSON.stringify(unnumbered.body)).not.toContain("10.0.0.7");
    } finally {
      await w.cleanup();
    }
  });

  test("a revoked organization API key's request is refused before the handler runs", async () => {
    const calls: HandlerCall[] = [];
    const w = await world([remoteServer, acmeEntry], async () => [
      await hostRegistration("acme", eventMethods(calls)),
    ]);
    try {
      expect((await w.post(listEvents)).body.result).toBeDefined();
      expect(calls).toHaveLength(1);
      await w.revokeKey();
      const refused = await w.post(listEvents);
      expect(refused.status).toBe(401);
      expect(refused.body.result).toBeUndefined();
      expect(calls).toHaveLength(1);
    } finally {
      await w.cleanup();
    }
  });

  test("a revoked MCP OAuth connection's request is refused before the handler runs", async () => {
    const calls: HandlerCall[] = [];
    const w = await world([remoteServer, acmeEntry], async () => [
      await hostRegistration("acme", eventMethods(calls)),
    ]);
    try {
      const connection = await w.connectOAuth([{ serverId: "acme", toolName: "get_status" }]);
      const listed = await w.post(listEvents, connection.bearer);
      expect(listed.status).toBe(200);
      expect(listed.body.result).toEqual({
        events: [{ name: "reservation.created", workspace: w.owner.workspaceId }],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.grant.principalKind).toBe("human_session");
      expect(calls[0]!.grant.subjectId).toBe(w.owner.subjectId);

      await connection.revokeByRefreshReuse();
      const refused = await w.post(listEvents, connection.bearer);
      expect(refused.status).toBe(401);
      expect(refused.body.result).toBeUndefined();
      expect(calls).toHaveLength(1);
    } finally {
      await w.cleanup();
    }
  });

  test("MCP OAuth consent scopes extension methods per host server", async () => {
    const calls: HandlerCall[] = [];
    const w = await world([remoteServer, acmeEntry], async () => [
      await hostRegistration("acme", eventMethods(calls)),
    ]);
    try {
      // Consent to another server's tool only: the host server is not in this connection.
      const elsewhere = await w.connectOAuth([
        { serverId: "remote", toolName: "search_documents" },
      ]);
      const init = await w.post(initialize, elsewhere.bearer);
      expect(init.status).toBe(200);
      expect(init.body.result?.capabilities?.experimental).toBeUndefined();
      expect((await w.post(listEvents, elsewhere.bearer)).body.error?.code).toBe(-32601);
      expect(calls).toHaveLength(0);
    } finally {
      await w.cleanup();
    }
  });

  test("each extension call runs the tools/list reauthorize step first", async () => {
    const calls: HandlerCall[] = [];
    let revoked = false;
    let reauthorized = 0;
    const access = grantStub();
    const prepared: PreparedWorkspaceToolGateway = {
      toolGateway: {} as PreparedWorkspaceToolGateway["toolGateway"],
      toolGatewayCatalog: {
        digest: "digest",
        entries: [],
      } as unknown as PreparedWorkspaceToolGateway["toolGatewayCatalog"],
      close: async () => undefined,
      reauthorize: async () => {
        reauthorized += 1;
        if (revoked) throw new HTTPException(403, { message: "authority revoked" });
      },
      hostExtensionMethods: Object.entries(eventMethods(calls)).map(([method, handler]) => ({
        serverId: "acme",
        method,
        handler,
      })),
    };
    const server = buildWorkspaceToolGatewayMcpServer(prepared, access);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "extension-reauthorize", version: "1.0.0" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      expect(mcpClient.getServerCapabilities()?.experimental).toEqual({
        acme: { methods: ["events/list", "events/subscribe"] },
      });
      const request = { method: "events/list", params: { cursor: "c-1" } };
      const passthrough = z.looseObject({});
      await mcpClient.request(request, passthrough);
      expect(reauthorized).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.grant).toBe(access);

      revoked = true;
      await expect(mcpClient.request(request, passthrough)).rejects.toThrow("authority revoked");
      expect(reauthorized).toBe(2);
      expect(calls).toHaveLength(1);
    } finally {
      await Promise.allSettled([mcpClient.close(), server.close()]);
    }
  });
});

/** Shaped like SDK v2's ProtocolError, on a prototype unrelated to this SDK copy. */
class ForeignProtocolError extends Error {
  static readonly mcpBrand = "mcp.ProtocolError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

function grantStub(): AccessGrant {
  return {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    subjectId: "user:extension-methods-test",
    principalKind: "human_session",
    permissions: ["workspace:read"],
  } as AccessGrant;
}
