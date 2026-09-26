import { expect, test } from "bun:test";
import { RunContext, type MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, prepareAgentTools, prefixedMcpToolName } from "../src/index";
import { lazyToolRuntimeForAgent } from "../src/lazy-tool-transport";

// deferModelSchemasForEagerMcpServerIds: an eager MCP server is still prepared before the first
// model request, but only the preparation-independent names (plus the base set and the
// discovery tools) are disclosed; everything else is discoverable and keeps its authority.
const SERVER = "cendra-pms";
const RAW = Array.from({ length: 12 }, (_, index) => `tool_${String(index).padStart(2, "0")}`);
const NAMES = RAW.map((name) => prefixedMcpToolName(SERVER, name));
const INITIAL = NAMES.slice(0, 7);
const APPROVAL_RAW = RAW[9]!;
const DISCOVERY = new Set(["tool_search", "tool_list", "tool_invoke"]);

async function build(
  transport: "openai_native" | "generic_dispatch" | "codex_native",
  optIn: boolean,
) {
  const calls = { connect: 0, listTools: 0 };
  const config = { id: SERVER, url: "https://example.test/mcp", requireApproval: [APPROVAL_RAW] };
  const settings = testSettings({
    sandboxBackend: "none",
    codexToolSearchEnabled: true,
    lazyToolSearchEnabled: true,
    mcpServers: [config],
  });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: SERVER, eager: true }], {
    deferNonEagerUntilToolDemand: true,
    localMcpServers: [
      {
        id: SERVER,
        server: {
          name: SERVER,
          cacheToolsList: false,
          connect: async () => {
            calls.connect += 1;
          },
          close: async () => {},
          listTools: async () => {
            calls.listTools += 1;
            return RAW.map((name) => ({
              name,
              description: `Cendra ${name.replace("_", " ")}`,
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
              },
            }));
          },
          callTool: async () => [],
        } as MCPServer,
      },
    ],
  });
  // Eager preparation (the server connected by prepareAgentTools itself, not deferred to tool
  // demand) happened before the agent, and so before any model request, exists.
  const preparedBeforeAgent = { ...calls };
  await prepared.ready;
  const agent = buildOpenGeniAgent(settings, [], {
    mcpServers: prepared.mcpServers,
    lazyToolTransport: transport,
    toolPreparationReady: Promise.resolve(),
    preparationIndependentToolNames: INITIAL,
    ...(optIn ? { deferModelSchemasForEagerMcpServerIds: [SERVER] } : {}),
  });
  await Promise.resolve();
  const visible = (await agent.getAllTools(new RunContext()))
    .filter((tool) => tool.type === "function")
    .map((tool) => tool.name);
  const runtime = lazyToolRuntimeForAgent(agent)!;
  const hidden = NAMES.filter((name) =>
    runtime.shouldHideSerializedTool({
      type: "function",
      name,
      description: "",
      parameters: {},
      strict: false,
    }),
  );
  return { prepared, preparedBeforeAgent, visible, runtime, hidden };
}

async function approvalMap(runtime: NonNullable<ReturnType<typeof lazyToolRuntimeForAgent>>) {
  const map: Record<string, boolean> = {};
  for (const name of NAMES) {
    const tool = await runtime.resolveAuthorizedFunctionTool(name);
    expect(tool?.name).toBe(name);
    map[name] = Boolean(
      await (
        tool as unknown as {
          needsApproval: (rc: unknown, input: unknown, details: unknown) => Promise<boolean>;
        }
      ).needsApproval(new RunContext(), "{}", {}),
    );
  }
  return map;
}

test("default (option omitted): an eager server discloses every tool, as before", async () => {
  const { prepared, preparedBeforeAgent, visible, hidden } = await build("openai_native", false);
  try {
    expect(preparedBeforeAgent.connect).toBe(1);
    expect(hidden).toEqual([]);
    for (const name of NAMES) expect(visible).toContain(name);
  } finally {
    await prepared.close();
  }
});

for (const transport of ["openai_native", "generic_dispatch", "codex_native"] as const) {
  test(`${transport}: opted in, preparation stays eager and only the initial set plus discovery is disclosed`, async () => {
    const baseline = await build(transport, false);
    const { prepared, preparedBeforeAgent, visible, hidden } = await build(transport, true);
    try {
      expect(preparedBeforeAgent.connect).toBe(1);
      expect(hidden).toEqual(NAMES.slice(7));
      // MCP tools in the first request: exactly the preparation-independent ones.
      expect(visible.filter((name) => name.startsWith("mcp_"))).toEqual(INITIAL);
      // Everything else in the first request is the runtime's own always-visible base set (the
      // same as without the option) or a discovery tool; tool_search is hosted on native
      // transports and a function tool on generic_dispatch.
      const baseSet = new Set(baseline.visible.filter((name) => !name.startsWith("mcp_")));
      for (const name of visible.filter((value) => !value.startsWith("mcp_"))) {
        expect(baseSet.has(name) || DISCOVERY.has(name)).toBe(true);
      }
      expect(visible).toContain("tool_list");
      if (transport === "generic_dispatch") expect(visible).toContain("tool_search");
    } finally {
      await baseline.prepared.close();
      await prepared.close();
    }
  });
}

test("opted in: deferred tools are discoverable by name and by query", async () => {
  const { prepared, runtime } = await build("openai_native", true);
  try {
    const deferred = NAMES.slice(7);
    const byName = runtime
      .search({ names: deferred })
      .map((tool) => (tool as { name: string }).name);
    expect(new Set(byName)).toEqual(new Set(deferred));
    const byQuery = runtime
      .search({ query: "tool 10", limit: 12 })
      .map((tool) => (tool as { name: string }).name);
    expect(byQuery).toContain(NAMES[10]!);
    // The initial set is not re-offered through discovery.
    expect(runtime.search({ names: INITIAL })).toEqual([]);
    const listed = runtime.inspectSearchableTools().map((tool) => tool.name);
    expect(new Set(listed)).toEqual(new Set(deferred));
    // Schemas disclosed by search are the server's own (closed root kept).
    const disclosed = runtime.inspectSearchableTools().find((tool) => tool.name === NAMES[8]);
    expect((disclosed?.parameters as { required?: string[] } | undefined)?.required).toEqual([
      "id",
    ]);
  } finally {
    await prepared.close();
  }
});

test("opted in: authority is unchanged (same tools resolve, same approval floor)", async () => {
  const before = await build("openai_native", false);
  const after = await build("openai_native", true);
  try {
    const beforeMap = await approvalMap(before.runtime);
    const afterMap = await approvalMap(after.runtime);
    expect(afterMap).toEqual(beforeMap);
    expect(afterMap[prefixedMcpToolName(SERVER, APPROVAL_RAW)]).toBe(true);
    expect(await after.runtime.resolveAuthorizedFunctionTool("cendra_pms__not_listed")).toBeNull();
  } finally {
    await before.prepared.close();
    await after.prepared.close();
  }
});
