import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing/settings";
import { prepareAgentTools } from "../src";

describe("workspace tool gateway filtering", () => {
  test("forwards local provider preflight into the current-human gateway", async () => {
    const events: string[] = [];
    const signal = new AbortController().signal;
    const server: MCPServer = {
      name: "inventory",
      cacheToolsList: true,
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "write_item",
            inputSchema: {
              type: "object",
              properties: { sku: { type: "string" } },
              required: ["sku"],
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        events.push("execute");
        return { content: [{ type: "text", text: "ok" }] };
      },
      async invalidateToolsCache() {},
    };
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "inventory",
            url: "https://inventory.example.test/mcp",
            cacheToolsList: true,
            requireApproval: ["write_item"],
            connectionRef: {
              providerDomain: "inventory.example.test",
              kind: "oauth2",
              subjectScope: "workspace",
            },
          },
        ],
      }),
      [{ kind: "mcp", id: "inventory" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        localMcpServers: [
          {
            id: "inventory",
            server,
            preflightCall: async (toolName, args, options) => {
              events.push(`preflight:${toolName}:${String(args.sku)}`);
              expect(options?.signal).toBe(signal);
            },
          },
        ],
        workspaceToolGateway: {
          requireApproval: (_entry, _caller, context) =>
            context.transportMeta?.approvalConfirmed !== true,
        },
      },
    );
    try {
      const gateway = prepared.toolGateway!;
      const catalog = prepared.toolGatewayCatalog!;
      const call = await gateway.prepareCall(
        {
          operationId: "33333333-3333-4333-8333-333333333333",
          catalogDigest: catalog.digest,
          identity: { serverId: "inventory", toolName: "write_item" },
          arguments: { sku: "SKU-1" },
          caller: { kind: "http", subjectId: "human:test" },
        },
        { signal, transportMeta: { approvalConfirmed: true } },
      );
      expect(events).toEqual(["preflight:write_item:SKU-1"]);
      await call.execute();
      expect(events).toEqual(["preflight:write_item:SKU-1", "execute"]);
    } finally {
      await prepared.close();
    }
  });

  test("intersects the live catalog with an exact frozen tool identity set", async () => {
    const server: MCPServer = {
      name: "inventory",
      cacheToolsList: true,
      async connect() {},
      async close() {},
      async listTools() {
        return [
          {
            name: "read_item",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "delete_item",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: "text", text: "ok" }] };
      },
      async invalidateToolsCache() {},
    };
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "inventory",
            url: "https://inventory.example.test/mcp",
            cacheToolsList: true,
          },
        ],
      }),
      [{ kind: "mcp", id: "inventory" }],
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        localMcpServers: [{ id: "inventory", server }],
        workspaceToolGateway: {
          filterDefinition: (definition) =>
            definition.identity.serverId === "inventory" &&
            definition.identity.toolName === "read_item",
        },
      },
    );
    try {
      expect(prepared.toolGatewayCatalog?.entries.map((entry) => entry.identity)).toEqual([
        { serverId: "inventory", toolName: "read_item" },
      ]);
    } finally {
      await prepared.close();
    }
  });

  test("changes private approval authority when a local integration revision changes", async () => {
    const settings = testSettings({
      mcpServers: [
        {
          id: "inventory",
          url: "https://inventory.example.test/mcp",
          cacheToolsList: true,
          requireApproval: ["write_item"],
          connectionRef: {
            connectionId: "33333333-3333-4333-8333-333333333333",
            providerDomain: "inventory.example.test",
            kind: "oauth2",
            subjectScope: "workspace",
          },
        },
      ],
    });
    const prepare = async (instanceVersion: number) =>
      await prepareAgentTools(settings, [{ kind: "mcp", id: "inventory" }], {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        localMcpServers: [
          {
            id: "inventory",
            approvalAuthority: { kind: "api_integration", instanceVersion },
            preflightCall: async () => undefined,
            server: {
              name: `inventory-${instanceVersion}`,
              cacheToolsList: true,
              async connect() {},
              async close() {},
              async listTools() {
                return [{ name: "write_item", inputSchema: { type: "object" } }];
              },
              async callTool() {
                return { content: [{ type: "text", text: "ok" }] };
              },
              async invalidateToolsCache() {},
            },
          },
        ],
        workspaceToolGateway: {
          createdAt: new Date("2026-09-03T00:00:00.000Z"),
          requireApproval: (_entry, _caller, context) =>
            context.transportMeta?.approvalConfirmed !== true,
        },
      });
    const first = await prepare(1);
    const second = await prepare(2);
    try {
      expect(first.toolGatewayCatalog!.digest).toBe(second.toolGatewayCatalog!.digest);
      expect(first.toolGatewayCatalog!.entries[0]).not.toHaveProperty("approvalAuthorityDigest");
      const input = {
        operationId: "44444444-4444-4444-8444-444444444444",
        catalogDigest: first.toolGatewayCatalog!.digest,
        identity: { serverId: "inventory", toolName: "write_item" },
        arguments: {},
        caller: { kind: "http" as const, subjectId: "human:test" },
      };
      const firstCall = await first.toolGateway!.prepareCall(input, {
        transportMeta: { approvalConfirmed: true },
      });
      const secondCall = await second.toolGateway!.prepareCall(input, {
        transportMeta: { approvalConfirmed: true },
      });
      expect(firstCall.approvalAuthorityDigest).not.toBe(secondCall.approvalAuthorityDigest);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  describe("a registration that is best-effort for listing", () => {
    const scope = {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    };
    const settings = testSettings({
      mcpServers: [
        { id: "inventory", url: "https://inventory.example.test/mcp", cacheToolsList: true },
        { id: "host", url: "https://host.example.test/mcp", cacheToolsList: true },
      ],
    });
    const refs = [
      { kind: "mcp" as const, id: "inventory" },
      { kind: "mcp" as const, id: "host" },
    ];
    const tool = (name: string) => ({
      name,
      inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    });
    const listing = (
      name: string,
      tools: () => Promise<ReturnType<typeof tool>[]>,
      call: () => Promise<{ type: "text"; text: string }[]>,
    ): MCPServer => ({
      name,
      cacheToolsList: true,
      async connect() {},
      async close() {},
      listTools: tools,
      callTool: call,
      async invalidateToolsCache() {},
    });
    const ok = async () => [{ type: "text" as const, text: "ok" }];
    const inventory = () => listing("inventory", async () => [tool("read_item")], ok);
    const unlistable = () =>
      listing(
        "host",
        async () => {
          throw new Error("host listing unavailable");
        },
        ok,
      );
    const call = (catalogDigest: string, serverId: string, toolName: string) => ({
      operationId: crypto.randomUUID(),
      catalogDigest,
      identity: { serverId, toolName },
      arguments: {},
      caller: { kind: "http" as const, subjectId: "human:test" },
    });

    test("a failed listing leaves its tools out and records the server, and a call fails closed", async () => {
      const prepared = await prepareAgentTools(settings, refs, {
        ...scope,
        localMcpServers: [
          { id: "inventory", server: inventory() },
          { id: "host", server: unlistable(), listingBestEffort: true },
        ],
        workspaceToolGateway: {},
      });
      try {
        const catalog = prepared.toolGatewayCatalog!;
        expect(catalog.entries.map((entry) => entry.identity)).toEqual([
          { serverId: "inventory", toolName: "read_item" },
        ]);
        expect([...prepared.unavailableMcpServers.keys()]).toEqual(["host"]);
        await expect(
          prepared.toolGateway!.prepareCall(call(catalog.digest, "host", "write_item")),
        ).rejects.toMatchObject({ code: "tool_not_found" });
        const listed = await prepared.toolGateway!.prepareCall(
          call(catalog.digest, "inventory", "read_item"),
        );
        await listed.execute();
      } finally {
        await prepared.close();
      }
    });

    test("without the mark the same listing failure fails the catalog", async () => {
      await expect(
        prepareAgentTools(settings, refs, {
          ...scope,
          localMcpServers: [
            { id: "inventory", server: inventory() },
            { id: "host", server: unlistable() },
          ],
          workspaceToolGateway: {},
        }),
      ).rejects.toThrow();
    });

    test("a listed tool whose call throws still fails loud", async () => {
      const prepared = await prepareAgentTools(settings, refs, {
        ...scope,
        localMcpServers: [
          { id: "inventory", server: inventory() },
          {
            id: "host",
            server: listing(
              "host",
              async () => [tool("write_item")],
              async () => {
                throw new Error("host call failed");
              },
            ),
            listingBestEffort: true,
          },
        ],
        workspaceToolGateway: {},
      });
      try {
        const catalog = prepared.toolGatewayCatalog!;
        const hostCall = await prepared.toolGateway!.prepareCall(
          call(catalog.digest, "host", "write_item"),
        );
        await expect(hostCall.execute()).rejects.toThrow("host call failed");
        expect(prepared.unavailableMcpServers.size).toBe(0);
      } finally {
        await prepared.close();
      }
    });
  });
});
