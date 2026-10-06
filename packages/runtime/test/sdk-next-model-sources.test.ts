import { expect, test } from "bun:test";
import { run, type MCPServer, type ModelRequest } from "@openai/agents";
import { createHash } from "node:crypto";
import { ScriptedModel, functionCall, testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, prepareAgentTools } from "../src/index";
import { bindModelSourceInput, modelSourceBindings, ModelRequestCaptureModel, withModelRequestCapture, type ModelRequestCapture } from "../src/model-request-capture";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

for (const streaming of [false, true]) {
  test(`actual SDK ${streaming ? "streaming" : "ordinary"} next call keeps exact model and projected MCP source bindings through clone`, async () => {
    const callId = crypto.randomUUID();
    const retained = { owner: "cendra.knowledge.retrieval_use", id: crypto.randomUUID(), version: "1", sha256: digest("synthetic passage") };
    const raw = { content: [{ type: "text" as const, text: "Synthetic evidence" }], structuredContent: { passage: "Synthetic evidence" } };
    const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false, mcpServers: [{ id: "cendra-pms", url: "https://synthetic.invalid/mcp", cacheToolsList: false }] });
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "cendra-pms" }], {
      accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), attemptId: crypto.randomUUID(), executionGeneration: 1,
      localMcpServers: [{ id: "cendra-pms", server: {
        name: "cendra-pms", cacheToolsList: false, connect: async () => {}, close: async () => {}, invalidateToolsCache: async () => {},
        listTools: async () => [{ name: "knowledge_search", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } }],
        callTool: async () => raw.content, callToolResult: async () => raw,
      } satisfies MCPServer, modelSourceRefs: () => [retained] }],
    });
    const requests: ModelRequest[] = [];
    const capture: ModelRequestCapture = () => {};
    capture.beforeCall = async request => {
      requests.push(request);
      const bindings = modelSourceBindings(request.input);
      expect(bindings).toHaveLength(request.input.length);
      if (requests.length === 2) {
        const result = bindings.find(binding => binding.kind === "TOOL_RESULT")!;
        expect(result.retainedSources).toEqual([retained]);
        expect(result.parents).toEqual([{ owner: "native.tool.result", id: result.parents[0]!.id, sha256: digest(raw) }]);
        expect(JSON.stringify(request.input)).not.toContain(retained.owner);
      }
      return `source-${requests.length}`;
    };
    const step = (request: ModelRequest) => {
      if(requests.length!==1)return {outputText:"Synthetic answer"};
      const tool=request.tools.find(value=>value.type==="function" && value.name.endsWith("__knowledge_search"));
      if(!tool || tool.type!=="function")throw Error("Actual SDK MCP catalog tool missing");
      return {output:[functionCall(tool.name,{},callId)]};
    };
    const model = new ModelRequestCaptureModel({
      async getResponse(request) { return await new ScriptedModel([step(request)]).getResponse(request); },
      async *getStreamedResponse(request) { yield* new ScriptedModel([step(request)]).getStreamedResponse(request); },
    });
    try {
      const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers }).clone({ model });
      const input = { type: "message" as const, role: "user" as const, content: "Synthetic request" };
      bindModelSourceInput(input, { kind: "HISTORY_ROW", sourceRef: { owner: "native.runtime.artifact", id: "initial", sha256: digest(input) }, parents: [], retainedSources: [] });
      await withModelRequestCapture(capture, async () => {
        if (streaming) { const result = await run(agent, [input], { stream: true, historyOwnership: "external", tracingDisabled: true }); for await (const _event of result) {} await result.completed; }
        else await run(agent, [input], { historyOwnership: "external", tracingDisabled: true });
      });
      expect(requests).toHaveLength(2);
    } finally { await prepared.close(); }
  });
}
