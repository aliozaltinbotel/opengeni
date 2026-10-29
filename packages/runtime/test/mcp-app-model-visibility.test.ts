import { describe, expect, test } from "bun:test";
import { Agent, RunContext } from "@openai/agents";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { testSettings } from "@opengeni/testing/settings";
import {
  prepareAgentTools,
  PrefixedMcpServer,
  type LocalMcpServerRegistration,
  type PrepareToolsOptions,
} from "../src";

type HostToolsOptions = Pick<PrepareToolsOptions, "attemptToolDescription"> & {
  appOnlyResourceUri?: string;
};

async function hostTools({ appOnlyResourceUri, ...options }: HostToolsOptions = {}) {
  const calls: string[] = [];
  const host = new McpServer({ name: "host-inventory", version: "1" });
  for (const [name, visibility] of [
    ["app_refresh", ["app"]],
    ["read_item", undefined],
    ["model_read", ["model"]],
    ["shared_read", ["model", "app"]],
    ["malformed_read", ["everyone"]],
  ] as const) {
    host.registerTool(
      name,
      {
        description: name,
        ...(visibility
          ? {
              _meta: {
                ui: {
                  visibility: [...visibility],
                  ...(name === "app_refresh" && appOnlyResourceUri
                    ? { resourceUri: appOnlyResourceUri }
                    : {}),
                },
              },
            }
          : {}),
      },
      async () => {
        calls.push(name);
        return { content: [{ type: "text", text: name }] };
      },
    );
  }
  const client = new Client({ name: "host-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  type RuntimeServer = LocalMcpServerRegistration["server"];
  const call = async (name: string, args: Record<string, unknown> | null) =>
    (await client.callTool({ name, arguments: args ?? {} })) as CallToolResult;
  const registration: LocalMcpServerRegistration = {
    id: "inventory",
    server: {
      name: "host-inventory",
      cacheToolsList: false,
      async connect() {
        await host.connect(serverTransport);
        await client.connect(clientTransport);
      },
      async close() {
        await Promise.allSettled([client.close(), host.close()]);
      },
      async listTools() {
        return (await client.listTools()).tools as Awaited<ReturnType<RuntimeServer["listTools"]>>;
      },
      async callTool(name, args) {
        return (await call(name, args)).content;
      },
      async callToolResult(name, args) {
        return await call(name, args);
      },
      async invalidateToolsCache() {},
    },
  };
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: [{ id: "inventory", url: "https://host.invalid/mcp", cacheToolsList: false }],
  });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "inventory" }], {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 1,
    localMcpServers: [registration],
    workspaceToolGateway: {},
    ...options,
  });
  return { prepared, calls };
}

describe("MCP Apps model visibility", () => {
  test("an app-only host tool is not offered to a model turn", async () => {
    const { prepared } = await hostTools();
    try {
      const agent = new Agent({ name: "inventory", mcpServers: prepared.mcpServers });
      const offered = await agent.getAllTools(new RunContext());
      expect(offered.map((tool) => tool.name)).not.toContain("inventory__app_refresh");
      expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).not.toContain(
        "inventory__app_refresh",
      );
      expect(prepared.toolGatewayCatalog?.entries.map((entry) => entry.modelName)).toContain(
        "inventory__app_refresh",
      );
    } finally {
      await prepared.close();
    }
  });

  test("attempt descriptions project only model-visible tools while retaining the full human snapshot", async () => {
    const described: string[] = [];
    const { prepared } = await hostTools({
      attemptToolDescription: ({ modelName }) => {
        described.push(modelName);
        return modelName === "inventory__model_read" ? undefined : `Projected ${modelName}`;
      },
    });
    try {
      const server = prepared.mcpServers[0];
      if (!(server instanceof PrefixedMcpServer))
        throw new Error("Expected the native MCP adapter");
      const fullSnapshot = await server.freezeTools();
      expect(fullSnapshot.find((tool) => tool.name === "inventory__app_refresh")).toMatchObject({
        description: "app_refresh",
        _meta: { ui: { visibility: ["app"] } },
      });
      expect(prepared.toolGatewayCatalog?.entries.map((entry) => entry.modelName)).toContain(
        "inventory__app_refresh",
      );
      const agent = new Agent({ name: "inventory", mcpServers: prepared.mcpServers });
      const offered = await agent.getAllTools(new RunContext());
      expect(offered.map((tool) => tool.name)).not.toContain("inventory__app_refresh");
      expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).not.toContain(
        "inventory__app_refresh",
      );
      expect(described).toEqual([
        "inventory__read_item",
        "inventory__model_read",
        "inventory__shared_read",
        "inventory__malformed_read",
      ]);
      expect(
        (await server.listTools()).find((tool) => tool.name === "inventory__read_item")
          ?.description,
      ).toBe("Projected inventory__read_item");
      expect(
        (await server.listTools()).find((tool) => tool.name === "inventory__model_read")
          ?.description,
      ).toBe("model_read");
    } finally {
      await prepared.close();
    }
  });

  test("a model call to an app-only tool is refused by name", async () => {
    const { prepared, calls } = await hostTools();
    try {
      await expect(
        prepared.mcpServers[0]!.callTool(
          "inventory__app_refresh",
          {},
          {
            ui: { visibility: ["app"] },
            caller: "app",
          },
        ),
      ).rejects.toMatchObject({
        code: -32602,
        data: { code: "TOOL_NOT_MODEL_VISIBLE", name: "inventory__app_refresh" },
      });
      expect(calls).toEqual([]);
    } finally {
      await prepared.close();
    }
  });

  test("a malformed view never restores model access to an app-only tool", async () => {
    const { prepared, calls } = await hostTools({
      appOnlyResourceUri: "https://host.invalid/view.html",
    });
    try {
      await expect(
        prepared.mcpServers[0]!.callTool("inventory__app_refresh", {}),
      ).rejects.toMatchObject({
        code: -32602,
        data: { code: "TOOL_NOT_MODEL_VISIBLE", name: "inventory__app_refresh" },
      });
      expect(calls).toEqual([]);
      const agent = new Agent({ name: "inventory", mcpServers: prepared.mcpServers });
      expect((await agent.getAllTools(new RunContext())).map((tool) => tool.name)).not.toContain(
        "inventory__app_refresh",
      );
      expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).not.toContain(
        "inventory__app_refresh",
      );
      expect(prepared.toolGatewayCatalog?.entries.map((entry) => entry.modelName)).toContain(
        "inventory__app_refresh",
      );
    } finally {
      await prepared.close();
    }
  });

  test("tools without app-only visibility are unchanged", async () => {
    const { prepared, calls } = await hostTools();
    try {
      const agent = new Agent({ name: "inventory", mcpServers: prepared.mcpServers });
      const offered = await agent.getAllTools(new RunContext());
      for (const name of ["read_item", "model_read", "shared_read", "malformed_read"]) {
        expect(offered.map((tool) => tool.name)).toContain(`inventory__${name}`);
        await prepared.mcpServers[0]!.callTool(`inventory__${name}`, {});
      }
      expect(calls).toEqual(["read_item", "model_read", "shared_read", "malformed_read"]);
    } finally {
      await prepared.close();
    }
  });

  test("stock console without an extension is unchanged", async () => {
    const prepared = await prepareAgentTools(
      testSettings({ sandboxBackend: "none", mcpServers: [] }),
      [],
    );
    try {
      const agent = new Agent({ name: "stock", mcpServers: prepared.mcpServers });
      expect(await agent.getAllTools(new RunContext())).toEqual([]);
      expect(prepared.toolGatewayCatalog).toBeNull();
    } finally {
      await prepared.close();
    }
  });
});
