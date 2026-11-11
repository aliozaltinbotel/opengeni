import { expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { prepareAgentTools } from "../src/index";

async function prepareCatalogs(
  concurrency?: number,
  failFirst = false,
  mode: "attempt" | "workspace" | "deferred" = "attempt",
) {
  let active = 0;
  let peak = 0;
  const listed: string[] = [];
  const closed: string[] = [];
  const ids = ["first", "second"];
  const localMcpServers = ids.map((id) => {
    const server: MCPServer = {
      name: id,
      cacheToolsList: false,
      async connect() {},
      async close() {
        closed.push(id);
      },
      async listTools() {
        active++;
        peak = Math.max(peak, active);
        listed.push(id);
        try {
          // Both catalog requests must retain their own current-authority read.
          // A microtask boundary exposes overlapping readers without a timer.
          await Promise.resolve();
          if (failFirst && id === "first") throw new Error("current authority refused");
          return [{ name: "lookup", inputSchema: { type: "object", properties: {} } }];
        } finally {
          active--;
        }
      },
      async callTool() {
        return [{ type: "text", text: "result" }];
      },
      async invalidateToolsCache() {},
    };
    return { id, server };
  });
  const settings = testSettings({
    sandboxBackend: "none",
    integrationsAllowPrivateNetworkTargets: true,
    mcpServers: ids.map((id) => ({ id, url: `https://${id}.invalid/mcp` })),
  });
  const preparation = prepareAgentTools(
    settings,
    ids.map((id) => ({ kind: "mcp", id, eager: true })),
    {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      ...(mode === "workspace"
        ? { workspaceToolGateway: {} }
        : {
            sessionId: "33333333-3333-4333-8333-333333333333",
            turnId: "44444444-4444-4444-8444-444444444444",
            attemptId: "55555555-5555-4555-8555-555555555555",
            executionGeneration: 1,
          }),
      ...(mode === "deferred"
        ? {
            deferNonEagerUntilToolDemand: true,
            deferredPreparationStart: "provider-dispatch" as const,
          }
        : {}),
      localMcpServers,
      ...(concurrency === undefined ? {} : { mcpCatalogConcurrency: concurrency }),
    },
  );
  return { preparation, observation: () => ({ peak, active, listed, closed }) };
}

test("host can serialize catalog reads without skipping either authority check", async () => {
  const fixture = await prepareCatalogs(1);
  const prepared = await fixture.preparation;
  try {
    expect(fixture.observation()).toMatchObject({
      peak: 1,
      active: 0,
      listed: ["first", "second"],
    });
    expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).toEqual([
      "first__lookup",
      "second__lookup",
    ]);
  } finally {
    await prepared.close();
  }
  expect(fixture.observation().closed.sort()).toEqual(["first", "second"]);
});

test("default catalog preparation remains concurrent", async () => {
  const fixture = await prepareCatalogs();
  const prepared = await fixture.preparation;
  try {
    expect(fixture.observation().peak).toBe(2);
  } finally {
    await prepared.close();
  }
});

test.each([0, -1, 1.5, 9, NaN, Infinity])(
  "invalid catalog concurrency %s fails before catalog reads",
  async (value) => {
    const fixture = await prepareCatalogs(value);
    await expect(fixture.preparation).rejects.toThrow(
      "mcpCatalogConcurrency must be an integer between 1 and 8",
    );
    expect(fixture.observation().listed).toEqual([]);
  },
);

test("serialized authority refusal preserves failure and closes connected servers", async () => {
  const fixture = await prepareCatalogs(1, true);
  await expect(fixture.preparation).rejects.toThrow("current authority refused");
  expect(fixture.observation().active).toBe(0);
  expect(fixture.observation().closed.sort()).toEqual(["first", "second"]);
});

test("serialized preparation includes local and HTTP first-party catalogs", async () => {
  const reads: string[] = [];
  const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });
  const local: MCPServer = {
    name: "local",
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async listTools() {
      reads.push("local current-authority");
      await Promise.resolve();
      reads.push("local complete");
      return [tool("lookup")];
    },
    async callTool() {
      return [];
    },
    async invalidateToolsCache() {},
  };
  const prepared = await prepareAgentTools(
    testSettings({
      sandboxBackend: "none",
      integrationsAllowPrivateNetworkTargets: true,
      mcpServers: [
        { id: "local", url: "https://local.invalid/mcp" },
        { id: "opengeni", url: "http://127.0.0.1:8000/v1/workspaces/{workspaceId}/mcp" },
      ],
    }),
    [
      { kind: "mcp", id: "local", eager: true },
      { kind: "mcp", id: "opengeni", eager: true },
    ],
    {
      mcpCatalogConcurrency: 1,
      localMcpServers: [{ id: "local", server: local }],
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
      firstPartyTools: ["goal_set"],
      mcpFetchImpl: async (_url, init) => {
        if (init?.method !== "POST") return new Response(null, { status: 405 });
        const request: unknown = JSON.parse(String(init.body));
        if (typeof request !== "object" || request === null) throw new Error("invalid MCP request");
        if (!("id" in request)) return new Response(null, { status: 202 });
        if (!("method" in request)) throw new Error("missing MCP method");
        if (request.method === "tools/list") {
          reads.push("HTTP current-authority");
          expect(reads).toEqual([
            "local current-authority",
            "local complete",
            "HTTP current-authority",
          ]);
        }
        const result =
          request.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "opengeni", version: "1" },
              }
            : request.method === "tools/list"
              ? { tools: [tool("goal_set")] }
              : {};
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      },
    },
  );
  try {
    expect(prepared.attemptToolCatalog?.entries.map((entry) => entry.modelName)).toEqual([
      "local__lookup",
      "opengeni__goal_set",
    ]);
    expect(reads).toEqual(["local current-authority", "local complete", "HTTP current-authority"]);
  } finally {
    await prepared.close();
  }
});

for (const mode of ["workspace", "deferred"] as const) {
  test(`${mode} catalog preparation honors the host concurrency limit`, async () => {
    const fixture = await prepareCatalogs(1, false, mode);
    const prepared = await fixture.preparation;
    try {
      prepared.startDeferredPreparation?.();
      if (prepared.ready) await prepared.ready;
      expect(fixture.observation()).toMatchObject({
        peak: 1,
        active: 0,
        listed: ["first", "second"],
      });
    } finally {
      await prepared.close();
    }
    expect(fixture.observation().closed.sort()).toEqual(["first", "second"]);
  });
}
