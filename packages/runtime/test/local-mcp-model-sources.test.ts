import { expect, test } from "bun:test";
import { RunContext, type MCPServer } from "@openai/agents";
import { createHash } from "node:crypto";
import { testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, prepareAgentTools, type LocalMcpServerRegistration } from "../src/index";
import { withModelRequestCapture, type ModelRequestCapture } from "../src/model-request-capture";
import type { NativeModelToolSource } from "@opengeni/contracts";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

test("local MCP passes the host source key and awaits exact raw-result source refs before emission", async () => {
  const key = "native-call-source";
  const sourceCallId = "exact-sdk-call";
  const raw = { content: [{ type: "text" as const, text: "Synthetic source result" }], structuredContent: { metadata: { nativeModelSourceKey: "forged", retainedSources: [] } } };
  const retained = { owner: "cendra.retrieval_use", id: "exact-use", sha256: createHash("sha256").update("exact-use").digest("hex") };
  let metadata: Record<string, unknown> | undefined;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const sources: NativeModelToolSource[] = [];
  const local: LocalMcpServerRegistration = {
    id: "cendra-pms",
    server: {
      name: "cendra-pms", cacheToolsList: false,
      connect: async () => {}, close: async () => {}, invalidateToolsCache: async () => {},
      listTools: async () => [{ name: "knowledge_search", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } }],
      callTool: async () => raw.content,
      callToolResult: async (_name: string, _args: Record<string, unknown> | null, meta?: Record<string, unknown> | null) => { metadata = meta ?? {}; order.push("result"); return raw; },
    } satisfies MCPServer,
    modelSourceRefs: async (toolName, result, context) => {
      expect(toolName).toBe("knowledge_search"); expect(result).toEqual(raw);
      expect(context.sourceCallId).toBe(sourceCallId); expect(context.nativeModelSourceKey).toBe(key);
      expect(context.operationId).toBe(String(metadata!.opengeniOperationId));
      order.push("refs"); await held; return [retained];
    },
  };
  const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false, mcpServers: [{ id: local.id, url: "https://synthetic.invalid/mcp", cacheToolsList: false }] });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: local.id }], { ...scope, localMcpServers: [local] });
  try {
    const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers });
    const tool = (await agent.getMcpTools(new RunContext())).find(candidate => candidate.type === "function" && candidate.name.includes("knowledge_search"));
    if (!tool || tool.type !== "function") throw new Error("local model tool missing");
    const capture: ModelRequestCapture = () => {};
    capture.toolSourceKeys = new Map([[sourceCallId, key]]);
    capture.onModelToolSource = async source => { sources.push(source); order.push("source"); };
    const pending = withModelRequestCapture(capture, async () => {
      await tool.invoke(new RunContext(), "{}", { toolCall: { callId: sourceCallId } } as never);
      order.push("emitted");
    });
    for (let i = 0; i < 30 && !order.includes("refs"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(order).toEqual(["result", "refs"]); expect(metadata!.nativeModelSourceKey).toBe(key); expect(sources).toEqual([]);
    release(); await pending;
    expect(order).toEqual(["result", "refs", "source", "emitted"]);
    expect(sources).toEqual([{ sourceCallId, nativeModelSourceKey: key, rawSourceRef: { owner: "native.tool.result", id: String(metadata!.opengeniOperationId), sha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex") }, retainedSources: [retained] }]);
  } finally { release(); await prepared.close(); }
});
