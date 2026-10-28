import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Settings } from "@opengeni/config";
import type { AccessGrant } from "@opengeni/contracts";
import type { AppDependencies } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  enableCapabilityInstallation,
  installApiIntegration,
  integrationBindingKey,
  integrationRuntimeKey,
  upsertCapabilityCatalogItem,
  type DbClient,
  type InstallApiIntegrationInput,
} from "@opengeni/db";
import type { LocalMcpServerRegistration } from "@opengeni/runtime/workspace-tool-gateway";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { startApiWorkspaceToolServersOverride, type StartApiOptions } from "../src/index";
import { HOST_TOOL_SERVER_ID_CONFLICT } from "../src/workspace-tool-gateway";

setDefaultTimeout(60_000);

type WorkspaceToolServersPort = NonNullable<AppDependencies["workspaceToolServers"]>;
type ListedTool = { name: string; _meta?: Record<string, unknown> };
type JsonRpcBody = {
  result?: { tools?: ListedTool[]; content?: Array<{ text?: string }>; isError?: boolean };
  error?: { code?: number; message?: string };
};

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const remote = startTestMcpServer();

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-tool-gateway-host-servers");
  if (!shared) throw new Error("host tool-server tests require PostgreSQL");
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
  server: McpServer,
): Promise<LocalMcpServerRegistration> {
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

type HostCall = { tool: string; subjectId: string; workspaceId: string; sku: unknown };

/** A fake host server `id` whose tool handlers see the grant the port received. */
function acmeServer(
  id: string,
  grant: AccessGrant,
  calls: HostCall[],
  options: { visible?: boolean } = {},
): McpServer {
  const server = new McpServer({ name: `host-${id}`, version: "1.0.0" });
  for (const tool of ["lookup", "reserve"]) {
    const registered = server.registerTool(
      tool,
      { description: `${id} ${tool}`, inputSchema: { sku: z.string() } },
      async ({ sku }) => {
        calls.push({ tool, subjectId: grant.subjectId, workspaceId: grant.workspaceId, sku });
        return { content: [{ type: "text", text: `${id}:${tool}:${sku}` }] };
      },
    );
    // A host scopes its tools by grant inside its own tools/list.
    if (options.visible === false) registered.disable();
  }
  return server;
}

type World = {
  owner: AccessGrant;
  workspaceId: string;
  apiKeySubjectId: string;
  post: (body: unknown) => Promise<{ status: number; body: JsonRpcBody }>;
  cleanup: () => Promise<void>;
};

async function world(
  mcpServers: Settings["mcpServers"],
  workspaceToolServers?: WorkspaceToolServersPort,
): Promise<World> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "host-tool-servers",
    accountExternalId: suffix,
    accountName: "Host tool servers",
    workspaceExternalSource: "host-tool-servers",
    workspaceExternalId: suffix,
    workspaceName: "Host tool servers",
    subjectId: `human:${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const bearer = `ogk_host_${crypto.randomUUID().replaceAll("-", "")}`;
  const key = await createOrganizationApiKey(client!.db, {
    accountId: owner.accountId,
    name: "Host tool servers",
    prefix: bearer.slice(0, 12),
    keyHash: createHash("sha256").update(bearer).digest("hex"),
    permissions: ["workspace:read"],
  });
  const app = createApp({
    settings: settingsFor(mcpServers),
    db: client!.db,
    bus: {} as never,
    workflowClient: {} as never,
    objectStorage: null,
    ...(workspaceToolServers ? { workspaceToolServers } : {}),
  });
  let id = 0;
  const post = async (body: unknown) => {
    const response = await app.request(`http://localhost/v1/workspaces/${owner.workspaceId}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, ...(body as object) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as JsonRpcBody };
  };
  return {
    owner: owner as AccessGrant,
    workspaceId: owner.workspaceId,
    apiKeySubjectId: `api_key:${key.id}`,
    post,
    cleanup: async () => {
      await deleteWorkspace(client!.db, owner.workspaceId);
    },
  };
}

const encryptionKey = Buffer.alloc(32, 44).toString("base64");
const settingsFor = (mcpServers: Settings["mcpServers"]) =>
  testSettings({
    productAccessMode: "configured",
    environmentsEncryptionKey: encryptionKey,
    mcpServers,
  });

/** A workspace MCP capability that explicitly claims server id `mcpServerId`. */
async function claimingCapability(grant: AccessGrant, mcpServerId: string) {
  const capabilityId = `mcp:claims-${mcpServerId}`;
  await upsertCapabilityCatalogItem(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    id: capabilityId,
    kind: "mcp",
    source: "manual",
    name: capabilityId,
    endpointUrl: remote.url,
    category: "custom",
    tags: ["mcp"],
    metadata: { mcpServerId },
  });
  await enableCapabilityInstallation(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    capabilityId,
    kind: "mcp",
    metadata: { mcpConnectivity: { status: "ok" } },
  });
}

/** A workspace OpenAPI integration published under server id `serverId`. */
function integrationClaiming(grant: AccessGrant, serverId: string): InstallApiIntegrationInput {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    capabilityId: `api:claims-${serverId}`,
    pluginKey: `integration/claims-${serverId}`,
    serverId,
    name: `Claims ${serverId}`,
    description: "Read inventory.",
    category: "operations",
    tags: ["inventory", "openapi"],
    definitionId: `claims-${serverId}`,
    definitionProvenance: "workspace",
    providerDomain: "inventory.example.com",
    protocol: "openapi",
    baseUrl: "https://inventory.example.com/v1/",
    sourceUrl: "https://inventory.example.com/openapi.json",
    authScheme: { kind: "none" },
    requiredScopes: [],
    ownership: "workspace",
    revision: {
      id: "openapi:222222222222222222222222",
      protocol: "openapi",
      definitionId: `claims-${serverId}`,
      contentSha256: "2".repeat(64),
      source: { url: "https://inventory.example.com/openapi.json" },
      title: "Inventory API",
      tools: [
        {
          id: "list_items",
          operationKey: "listItems",
          name: "List items",
          description: "List inventory items.",
          inputSchema: { type: "object", properties: {} },
          safety: "read",
          approvalMode: "never",
          deprecated: false,
        },
      ],
      bindings: {
        list_items: {
          method: "get",
          pathTemplate: "/items",
          serverUrl: "https://inventory.example.com/v1/",
          parameters: [],
        },
      },
    },
  };
}

const listTools = { method: "tools/list", params: {} };
const callTool = (name: string, args: Record<string, unknown>) => ({
  method: "tools/call",
  params: { name, arguments: args },
});
const remoteServer = { id: "remote", url: remote.url, cacheToolsList: false };
const acmeEntry = { id: "acme", url: "https://host.invalid/acme/mcp", cacheToolsList: false };
const toolNames = (body: JsonRpcBody) => (body.result?.tools ?? []).map(({ name }) => name).sort();

describe("workspace tool-server host port", () => {
  test("stock: without a port, tools/list is today's catalog, and an empty port changes nothing", async () => {
    const stock = await world([remoteServer]);
    const empty = await world([remoteServer], async () => []);
    try {
      const listed = await stock.post(listTools);
      expect(listed.status).toBe(200);
      expect(toolNames(listed.body)).toEqual([
        "remote__fetch_document",
        "remote__search_documents",
      ]);
      const withEmptyPort = await empty.post(listTools);
      expect(withEmptyPort.status).toBe(200);
      // The catalog digest binds the workspace; everything else is identical.
      const withoutDigest = (body: JsonRpcBody) =>
        JSON.parse(JSON.stringify(body.result), (key, value: unknown) =>
          key === "opengeni/catalogDigest" ? undefined : value,
        ) as unknown;
      expect(withoutDigest(withEmptyPort.body)).toEqual(withoutDigest(listed.body));
    } finally {
      await Promise.all([stock.cleanup(), empty.cleanup()]);
    }
  });

  test("lists a host server's tools as MCP tools and calls them with the request's grant", async () => {
    const calls: HostCall[] = [];
    const inputs: Array<{ grant: AccessGrant; signal?: AbortSignal }> = [];
    const w = await world([remoteServer, acmeEntry], async (input) => {
      inputs.push(input);
      return [await hostRegistration("acme", acmeServer("acme", input.grant, calls))];
    });
    try {
      const listed = await w.post(listTools);
      expect(listed.status).toBe(200);
      expect(toolNames(listed.body)).toEqual([
        "acme__lookup",
        "acme__reserve",
        "remote__fetch_document",
        "remote__search_documents",
      ]);
      for (const tool of listed.body.result!.tools!.filter(({ name }) => name.startsWith("acme")))
        expect(tool._meta?.["opengeni/source"]).toBe("mcp");

      const called = await w.post(callTool("acme__lookup", { sku: "A-1" }));
      expect(called.status).toBe(200);
      expect(called.body.result?.isError).not.toBe(true);
      expect(JSON.stringify(called.body.result)).toContain("acme:lookup:A-1");
      expect(calls).toEqual([
        { tool: "lookup", subjectId: w.apiKeySubjectId, workspaceId: w.workspaceId, sku: "A-1" },
      ]);
      // Every request prepares its own catalog for its own grant.
      expect(inputs.length).toBeGreaterThanOrEqual(2);
      for (const input of inputs) {
        expect(input.grant.subjectId).toBe(w.apiKeySubjectId);
        expect(input.grant.workspaceId).toBe(w.workspaceId);
      }
    } finally {
      await w.cleanup();
    }
  });

  test("a registration whose id is not in settings is ignored", async () => {
    const calls: HostCall[] = [];
    const w = await world([remoteServer, acmeEntry], async ({ grant }) => [
      await hostRegistration("acme", acmeServer("acme", grant, calls)),
      await hostRegistration("stray", acmeServer("stray", grant, calls)),
    ]);
    try {
      const listed = await w.post(listTools);
      expect(listed.status).toBe(200);
      expect(toolNames(listed.body)).toEqual([
        "acme__lookup",
        "acme__reserve",
        "remote__fetch_document",
        "remote__search_documents",
      ]);
    } finally {
      await w.cleanup();
    }
  });

  test("a host server that publishes nothing for this grant leaves the rest of the catalog intact", async () => {
    const w = await world([remoteServer, acmeEntry], async ({ grant }) => [
      await hostRegistration("acme", acmeServer("acme", grant, [], { visible: false })),
    ]);
    try {
      const listed = await w.post(listTools);
      expect(listed.status).toBe(200);
      expect(toolNames(listed.body)).toEqual([
        "remote__fetch_document",
        "remote__search_documents",
      ]);
    } finally {
      await w.cleanup();
    }
  });

  test("a host server whose listing fails is left out; its tool's call is refused", async () => {
    const w = await world([remoteServer, acmeEntry], async ({ grant }) => {
      const registration = await hostRegistration("acme", acmeServer("acme", grant, []));
      return [
        {
          ...registration,
          server: {
            ...registration.server,
            listTools: async () => {
              throw new Error("acme listing unavailable");
            },
          },
        },
      ];
    });
    try {
      const listed = await w.post(listTools);
      expect(listed.status).toBe(200);
      expect(toolNames(listed.body)).toEqual([
        "remote__fetch_document",
        "remote__search_documents",
      ]);
      const called = await w.post(callTool("acme__lookup", { sku: "A-1" }));
      expect(JSON.stringify(called.body)).not.toContain("acme:lookup:A-1");
      expect(called.body.result?.isError === true || called.body.error !== undefined).toBe(true);
    } finally {
      await w.cleanup();
    }
  });

  test("a host tool its settings entry requires approval for is omitted from MCP listing", async () => {
    const w = await world(
      [remoteServer, { ...acmeEntry, requireApproval: ["reserve"] }],
      async ({ grant }) => [await hostRegistration("acme", acmeServer("acme", grant, []))],
    );
    try {
      const listed = await w.post(listTools);
      expect(listed.status).toBe(200);
      expect(toolNames(listed.body)).toEqual([
        "acme__lookup",
        "remote__fetch_document",
        "remote__search_documents",
      ]);
    } finally {
      await w.cleanup();
    }
  });

  test.each(["opengeni", "files", "docs"])(
    "a host registration with first-party id %s is refused and never shadows it",
    async (id) => {
      const shadow: HostCall[] = [];
      const w = await world(
        [remoteServer, { id, url: `https://host.invalid/${id}/mcp`, cacheToolsList: false }],
        async ({ grant }) => [await hostRegistration(id, acmeServer(id, grant, shadow))],
      );
      try {
        const listed = await w.post(listTools);
        expect(listed.status).toBeGreaterThanOrEqual(500);
        expect(JSON.stringify(listed.body)).not.toContain(`${id}__lookup`);
        expect(shadow).toHaveLength(0);
      } finally {
        await w.cleanup();
      }
    },
  );

  test("the refusal is the named HOST_TOOL_SERVER_ID_CONFLICT error", async () => {
    const { prepareWorkspaceToolGatewayForGrant } = await import("../src/workspace-tool-gateway");
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client!.db, {
      accountExternalSource: "host-tool-servers",
      accountExternalId: suffix,
      accountName: "Host tool servers",
      workspaceExternalSource: "host-tool-servers",
      workspaceExternalId: suffix,
      workspaceName: "Host tool servers",
      subjectId: `human:${suffix}`,
    });
    const grant = access.workspaceGrants[0]! as AccessGrant;
    const settings = settingsFor([remoteServer, acmeEntry]);
    const deps = (
      workspaceToolServers: WorkspaceToolServersPort,
    ): Parameters<typeof prepareWorkspaceToolGatewayForGrant>[0] =>
      ({ db: client!.db, settings, workspaceToolServers }) as Parameters<
        typeof prepareWorkspaceToolGatewayForGrant
      >[0];
    try {
      for (const ids of [["opengeni"], ["files"], ["docs"], ["codex_apps"], ["acme", "acme"]]) {
        const refused = prepareWorkspaceToolGatewayForGrant(
          deps(async ({ grant: caller }) =>
            Promise.all(ids.map((id) => hostRegistration(id, acmeServer(id, caller, [])))),
          ),
          grant,
        );
        await expect(refused).rejects.toMatchObject({ code: HOST_TOOL_SERVER_ID_CONFLICT });
      }
    } finally {
      await deleteWorkspace(client!.db, grant.workspaceId);
    }
  });

  test("a workspace capability claiming a static host id cannot adopt the host server", async () => {
    const calls: HostCall[] = [];
    const w = await world(
      [remoteServer, { ...acmeEntry, allowedTools: ["lookup"] }],
      async ({ grant }) => [await hostRegistration("acme", acmeServer("acme", grant, calls))],
    );
    try {
      await claimingCapability(w.owner, "acme");
      const listed = await w.post(listTools);
      expect(listed.status).toBe(200);
      // The static entry's configuration governs the host server, not the capability's.
      expect(toolNames(listed.body)).toEqual([
        "acme__lookup",
        "remote__fetch_document",
        "remote__search_documents",
      ]);
      const called = await w.post(callTool("acme__lookup", { sku: "B-2" }));
      expect(JSON.stringify(called.body.result)).toContain("acme:lookup:B-2");
      expect(calls).toHaveLength(1);
    } finally {
      await w.cleanup();
    }
  });

  test("a workspace API integration with a static host id is dropped, not a gateway-wide failure", async () => {
    // The integration's runtime server id is derived from its base id; a static
    // host entry with exactly that id is the collision.
    const hostId = integrationRuntimeKey("acme", integrationBindingKey(null));
    const calls: HostCall[] = [];
    const w = await world([remoteServer, { ...acmeEntry, id: hostId }], async ({ grant }) => [
      await hostRegistration(hostId, acmeServer(hostId, grant, calls)),
    ]);
    try {
      await installApiIntegration(client!.db, integrationClaiming(w.owner, "acme"));
      const listed = await w.post(listTools);
      expect(listed.status).toBe(200);
      expect(toolNames(listed.body)).toEqual([
        `${hostId}__lookup`,
        `${hostId}__reserve`,
        "remote__fetch_document",
        "remote__search_documents",
      ]);
      const called = await w.post(callTool(`${hostId}__lookup`, { sku: "C-3" }));
      expect(JSON.stringify(called.body.result)).toContain(`${hostId}:lookup:C-3`);
      expect(calls).toHaveLength(1);
    } finally {
      await w.cleanup();
    }
  });

  test("a host id that only a workspace-installed server claims is refused, never adopted", async () => {
    const { prepareWorkspaceToolGatewayForGrant } = await import("../src/workspace-tool-gateway");
    const adopted: HostCall[] = [];
    const betaId = {
      capability: "beta",
      integration: integrationRuntimeKey("beta", integrationBindingKey(null)),
    };
    for (const install of ["capability", "integration"] as const) {
      const w = await world([remoteServer], undefined);
      try {
        if (install === "capability") await claimingCapability(w.owner, "beta");
        else await installApiIntegration(client!.db, integrationClaiming(w.owner, "beta"));
        const deps = {
          db: client!.db,
          settings: settingsFor([remoteServer]),
          workspaceToolServers: async ({ grant }: { grant: AccessGrant }) => [
            await hostRegistration(betaId[install], acmeServer(betaId[install], grant, adopted)),
          ],
        } as unknown as Parameters<typeof prepareWorkspaceToolGatewayForGrant>[0];
        await expect(prepareWorkspaceToolGatewayForGrant(deps, w.owner)).rejects.toMatchObject({
          code: HOST_TOOL_SERVER_ID_CONFLICT,
        });
      } finally {
        await w.cleanup();
      }
    }
    expect(adopted).toHaveLength(0);
  });

  test("startApi forwards the port only when it is given", () => {
    const port: WorkspaceToolServersPort = async () => [];
    expect(startApiWorkspaceToolServersOverride({})).toEqual({});
    expect("workspaceToolServers" in startApiWorkspaceToolServersOverride({})).toBe(false);
    expect(startApiWorkspaceToolServersOverride({ workspaceToolServers: port })).toEqual({
      workspaceToolServers: port,
    });
    const options: StartApiOptions = { workspaceToolServers: port };
    expect(options.workspaceToolServers).toBe(port);
  });
});
