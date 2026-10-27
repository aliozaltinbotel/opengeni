import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Settings } from "@opengeni/config";
import type { AppDependencies } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  type DbClient,
} from "@opengeni/db";
import type {
  LocalMcpServerRegistration,
  McpResource,
} from "@opengeni/runtime/workspace-tool-gateway";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import {
  buildWorkspaceToolGatewayMcpServer,
  type PreparedWorkspaceToolGateway,
} from "../src/workspace-tool-gateway";

setDefaultTimeout(60_000);

type WorkspaceToolServersPort = NonNullable<AppDependencies["workspaceToolServers"]>;
type ListedTool = { name: string; _meta?: Record<string, unknown> };
type JsonRpcBody = {
  result?: {
    tools?: ListedTool[];
    resources?: Array<{ uri: string; name?: string; mimeType?: string }>;
    contents?: Array<{ uri: string; mimeType?: string; text?: string }>;
    capabilities?: Record<string, unknown>;
  };
  error?: { code?: number; message?: string };
};

const MCP_APP_MIME = "text/html;profile=mcp-app";
const STATUS_VIEW = "ui://acme/views/status.html";
const RESERVE_VIEW = "ui://acme/views/reserve.html";
const ORPHAN_VIEW = "ui://acme/views/orphan.html";
const MALFORMED_VIEW = "https://acme.example/views/legacy.html";
const STATUS_HTML = "<!doctype html><title>Status</title><p>acme status</p>";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const remote = startTestMcpServer();

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-mcp-apps");
  if (!shared) throw new Error("workspace MCP Apps tests require PostgreSQL");
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  remote.close();
  await client?.close();
  await shared?.release();
}, 60_000);

type HostResources = Pick<LocalMcpServerRegistration, "listResources" | "readResource">;

/** A host's in-process MCP server, adapted to the runtime's local registration. */
async function hostRegistration(
  id: string,
  server: McpServer,
  resources: HostResources = {},
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
    ...resources,
  };
}

/** Host tools: `get_status` with a view, `get_legacy` with a malformed view, `reserve` with a view. */
function acmeAppsServer(): McpServer {
  const server = new McpServer({ name: "host-acme", version: "1.0.0" });
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
  server.registerTool(
    "get_status",
    { description: "Current status.", _meta: { ui: { resourceUri: STATUS_VIEW } } },
    async () => text("ok"),
  );
  server.registerTool(
    "get_legacy",
    { description: "Legacy view.", _meta: { ui: { resourceUri: MALFORMED_VIEW } } },
    async () => text("legacy"),
  );
  server.registerTool(
    "reserve",
    { description: "Reserve.", _meta: { ui: { resourceUri: RESERVE_VIEW } } },
    async () => text("reserved"),
  );
  return server;
}

/** Host resources for every view, including one no tool references. */
function acmeResources(reads: string[]): HostResources {
  const listed: McpResource[] = [STATUS_VIEW, RESERVE_VIEW, ORPHAN_VIEW, MALFORMED_VIEW].map(
    (uri) => ({ uri, name: uri.split("/").pop()!, mimeType: MCP_APP_MIME }),
  );
  return {
    listResources: async () => listed,
    readResource: async (uri) => {
      reads.push(uri);
      return { mimeType: MCP_APP_MIME, text: uri === STATUS_VIEW ? STATUS_HTML : `<p>${uri}</p>` };
    },
  };
}

type World = {
  post: (body: unknown) => Promise<{ status: number; body: JsonRpcBody }>;
  cleanup: () => Promise<void>;
};

async function world(
  mcpServers: Settings["mcpServers"],
  workspaceToolServers?: WorkspaceToolServersPort,
): Promise<World> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "workspace-mcp-apps",
    accountExternalId: suffix,
    accountName: "Workspace MCP Apps",
    workspaceExternalSource: "workspace-mcp-apps",
    workspaceExternalId: suffix,
    workspaceName: "Workspace MCP Apps",
    subjectId: `human:${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const bearer = `ogk_apps_${crypto.randomUUID().replaceAll("-", "")}`;
  await createOrganizationApiKey(client!.db, {
    accountId: owner.accountId,
    name: "Workspace MCP Apps",
    prefix: bearer.slice(0, 12),
    keyHash: createHash("sha256").update(bearer).digest("hex"),
    permissions: ["workspace:read"],
  });
  const app = createApp({
    settings: testSettings({
      productAccessMode: "configured",
      environmentsEncryptionKey: Buffer.alloc(32, 45).toString("base64"),
      mcpServers,
    }),
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
  return { post, cleanup: async () => void (await deleteWorkspace(client!.db, owner.workspaceId)) };
}

const initialize = {
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "workspace-mcp-apps-test", version: "1.0.0" },
  },
};
const listTools = { method: "tools/list", params: {} };
const listResources = { method: "resources/list", params: {} };
const readResource = (uri: string) => ({ method: "resources/read", params: { uri } });
const remoteServer = { id: "remote", url: remote.url, cacheToolsList: false };
const acmeEntry = { id: "acme", url: "https://host.invalid/acme/mcp", cacheToolsList: false };
const tool = (body: JsonRpcBody, name: string) =>
  body.result?.tools?.find((candidate) => candidate.name === name);

describe("MCP Apps metadata and resources on the workspace MCP", () => {
  test("stock: no resources capability and no tool carries _meta.ui", async () => {
    const stock = await world([remoteServer]);
    // A host server that offers neither views nor resources stays inert too.
    const plain = await world([remoteServer, acmeEntry], async () => {
      const server = new McpServer({ name: "host-acme", version: "1.0.0" });
      server.registerTool("get_status", { description: "Current status." }, async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
      return [await hostRegistration("acme", server)];
    });
    try {
      for (const w of [stock, plain]) {
        const init = await w.post(initialize);
        expect(init.status).toBe(200);
        expect(init.body.result?.capabilities?.tools).toBeDefined();
        expect(init.body.result?.capabilities?.resources).toBeUndefined();
        const listed = await w.post(listTools);
        expect(listed.status).toBe(200);
        expect(listed.body.result?.tools?.length).toBeGreaterThan(0);
        for (const entry of listed.body.result!.tools!) expect(entry._meta?.ui).toBeUndefined();
      }
      expect(tool((await plain.post(listTools)).body, "acme__get_status")).toBeDefined();
    } finally {
      await Promise.all([stock.cleanup(), plain.cleanup()]);
    }
  });

  test("a host view is listed on its tool, in resources/list, and read with the host bytes", async () => {
    const reads: string[] = [];
    const w = await world(
      [remoteServer, { ...acmeEntry, requireApproval: ["reserve"] }],
      async () => [await hostRegistration("acme", acmeAppsServer(), acmeResources(reads))],
    );
    try {
      const init = await w.post(initialize);
      expect(init.body.result?.capabilities?.resources).toEqual({ listChanged: false });

      const listed = await w.post(listTools);
      expect(listed.status).toBe(200);
      expect(tool(listed.body, "acme__get_status")?._meta?.ui).toEqual({
        resourceUri: STATUS_VIEW,
      });
      // First-party and remote tools never carry a view.
      for (const entry of listed.body.result!.tools!.filter(
        ({ name }) => !name.startsWith("acme__"),
      ))
        expect(entry._meta?.ui).toBeUndefined();

      const resources = await w.post(listResources);
      expect(resources.status).toBe(200);
      expect(resources.body.result?.resources).toEqual([
        { uri: STATUS_VIEW, name: "status.html", mimeType: MCP_APP_MIME },
      ]);

      const read = await w.post(readResource(STATUS_VIEW));
      expect(read.status).toBe(200);
      expect(read.body.result?.contents).toEqual([
        { uri: STATUS_VIEW, mimeType: MCP_APP_MIME, text: STATUS_HTML },
      ]);
      expect(reads).toEqual([STATUS_VIEW]);
    } finally {
      await w.cleanup();
    }
  });

  test("a malformed view URI is dropped from the tool and is not readable", async () => {
    const reads: string[] = [];
    const w = await world([remoteServer, acmeEntry], async () => [
      await hostRegistration("acme", acmeAppsServer(), acmeResources(reads)),
    ]);
    try {
      const listed = await w.post(listTools);
      expect(listed.status).toBe(200);
      const legacy = tool(listed.body, "acme__get_legacy");
      expect(legacy).toBeDefined();
      expect(legacy?._meta?.ui).toBeUndefined();
      const resources = await w.post(listResources);
      expect(resources.body.result?.resources?.map(({ uri }) => uri)).not.toContain(MALFORMED_VIEW);
      const read = await w.post(readResource(MALFORMED_VIEW));
      expect(read.body.error?.code).toBe(-32002);
      expect(reads).toEqual([]);
    } finally {
      await w.cleanup();
    }
  });

  test("reading an unknown URI answers MCP error -32002", async () => {
    const reads: string[] = [];
    const w = await world([remoteServer, acmeEntry], async () => [
      await hostRegistration("acme", acmeAppsServer(), acmeResources(reads)),
    ]);
    try {
      const read = await w.post(readResource("ui://acme/views/missing.html"));
      expect(read.status).toBe(200);
      expect(read.body.error?.code).toBe(-32002);
      expect(read.body.result).toBeUndefined();
      expect(reads).toEqual([]);
    } finally {
      await w.cleanup();
    }
  });

  test("a view is readable only through a tool in the caller's MCP catalog", async () => {
    const reads: string[] = [];
    // `reserve` requires approval, so this caller's MCP catalog does not list it.
    const w = await world(
      [remoteServer, { ...acmeEntry, requireApproval: ["reserve"] }],
      async () => [await hostRegistration("acme", acmeAppsServer(), acmeResources(reads))],
    );
    try {
      const listed = await w.post(listTools);
      expect(tool(listed.body, "acme__reserve")).toBeUndefined();
      const resources = await w.post(listResources);
      const uris = resources.body.result?.resources?.map(({ uri }) => uri) ?? [];
      expect(uris).not.toContain(RESERVE_VIEW);
      expect(uris).not.toContain(ORPHAN_VIEW);
      for (const uri of [RESERVE_VIEW, ORPHAN_VIEW]) {
        const read = await w.post(readResource(uri));
        expect(read.body.error?.code).toBe(-32002);
      }
      expect(reads).toEqual([]);
    } finally {
      await w.cleanup();
    }
  });

  test("a host view whose bytes are not an MCP App is not served", async () => {
    const w = await world([remoteServer, acmeEntry], async () => [
      await hostRegistration("acme", acmeAppsServer(), {
        listResources: async () => [{ uri: STATUS_VIEW, name: "status.html" }],
        readResource: async () =>
          ({ mimeType: "text/html", text: STATUS_HTML }) as unknown as Awaited<
            ReturnType<NonNullable<LocalMcpServerRegistration["readResource"]>>
          >,
      }),
    ]);
    try {
      const read = await w.post(readResource(STATUS_VIEW));
      expect(read.body.error?.code).toBe(-32002);
      expect(JSON.stringify(read.body)).not.toContain("acme status");
    } finally {
      await w.cleanup();
    }
  });
});

describe("MCP Apps resources after the caller's authority is revoked", () => {
  /** A prepared gateway whose one host tool has a view, served on an in-process client. */
  async function revocableGateway(reads: string[]) {
    let revoked = false;
    const prepared = {
      toolGateway: {},
      toolGatewayCatalog: {
        digest: "test-digest",
        entries: [
          {
            identity: { serverId: "acme", toolName: "get_status" },
            modelName: "acme__get_status",
            codemodePath: "acme.get_status",
            source: "mcp",
            approval: "none",
            inputSchema: { type: "object" },
            meta: { ui: { resourceUri: STATUS_VIEW } },
          },
        ],
      },
      close: async () => undefined,
      reauthorize: async () => {
        if (revoked) throw new Error("caller authority changed");
      },
      hostViewServers: [{ serverId: "acme", ...acmeResources(reads) }],
    } as unknown as PreparedWorkspaceToolGateway;
    const server = buildWorkspaceToolGatewayMcpServer(prepared, {} as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "revoked-reader", version: "1.0.0" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const read = async (uri: string) =>
      await mcpClient.readResource({ uri }).then(
        (result) => ({ result, error: undefined }),
        (error: { code?: number; message?: string }) => ({
          result: undefined,
          error: { code: error.code, message: error.message },
        }),
      );
    return {
      read,
      revoke: () => void (revoked = true),
      close: async () => await Promise.allSettled([mcpClient.close(), server.close()]),
    };
  }

  test("a revoked caller gets the same refusal for a known and an unknown URI", async () => {
    const reads: string[] = [];
    const gateway = await revocableGateway(reads);
    try {
      expect((await gateway.read(STATUS_VIEW)).result?.contents[0]?.text).toBe(STATUS_HTML);
      expect((await gateway.read("ui://acme/views/missing.html")).error?.code).toBe(-32002);
      reads.length = 0;
      gateway.revoke();
      const known = await gateway.read(STATUS_VIEW);
      const unknown = await gateway.read("ui://acme/views/missing.html");
      expect(known.result).toBeUndefined();
      expect(known.error).toBeDefined();
      expect(known.error?.code).not.toBe(-32002);
      expect(unknown).toEqual(known);
      expect(reads).toEqual([]);
    } finally {
      await gateway.close();
    }
  });
});
