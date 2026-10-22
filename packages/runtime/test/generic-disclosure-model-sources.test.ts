import { expect, test } from "bun:test";
import { Runner, type ModelRequest } from "@openai/agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, prepareAgentTools } from "../src/index";
import { installLazyToolRuntime, expandInteractionFamilyDisclosures } from "../src/lazy-tool-transport";
import { OpenGeniResponsesModel } from "../src/model-provider-routing";
import { callModelInputFilterForSettings } from "../src/model-input";
import { bindModelSourceInput, modelSourceInputBinding, ModelRequestCaptureModel, withModelRequestCapture, type ModelRequestCapture } from "../src/model-request-capture";

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

for (const streaming of [false, true]) for (const unavailable of [false, true]) {
  test(`production filter + Responses ${streaming ? "SSE" : "ordinary"} owns nonempty HTTP MCP search, ${unavailable ? "unavailable refusal" : "invoke"} and continuation`, async () => {
    let executions = 0;
    const transports: WebStandardStreamableHTTPServerTransport[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const mcp = new McpServer({ name: "source-fixture", version: "1.0.0" });
      mcp.registerTool("status_read", { description: "Read synthetic status", inputSchema: {} }, async () => {
        executions++;
        return { content: [{ type: "text" as const, text: "Synthetic status" }] };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      transports.push(transport);
      await mcp.connect(transport);
      return transport.handleRequest(request);
    } });
    const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false, openaiProviderItemIds: "strip", mcpServers: [{ id: "connected", url: `http://127.0.0.1:${server.port}/mcp`, cacheToolsList: false }] });
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "connected" }], {
      accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), attemptId: crypto.randomUUID(), executionGeneration: 1,
    });
    const entry = prepared.attemptToolEnvironment?.catalog.entries.find(candidate => candidate.identity.toolName === "status_read");
    if (!entry) throw Error("ACTUAL_CATALOG_ENTRY_REQUIRED");
    let requests = 0;
    const captured: ModelRequest[] = [];
    const client = new OpenAI({ apiKey: "synthetic-key", maxRetries: 0, fetch: async (_url, init) => {
      requests++;
      const wire = JSON.parse(String(init?.body)) as { stream?: boolean };
      const output = requests < 3 ? [{ type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name: requests === 1 ? "tool_search" : "tool_invoke", status: "completed", arguments: JSON.stringify(requests === 1 ? { query: "", names: [entry.modelName] } : { name: unavailable ? "not_currently_authorized" : entry.modelName, arguments: {} }) }]
        : [{ type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Status read", annotations: [], logprobs: [] }] }];
      const response = { id: `response_${requests}`, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      const events = [{ type: "response.created", response: { id: response.id, status: "in_progress", output: [] } }, ...output.map((item, output_index) => ({ type: "response.output_item.done", item, output_index })), { type: "response.completed", response }];
      return new Response(wire.stream ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") : JSON.stringify(response), { headers: { "content-type": wire.stream ? "text/event-stream" : "application/json" } });
    } });
    const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers });
    const runtime = installLazyToolRuntime(agent, "generic_dispatch", new Set(["connected"]));
    const selected = agent.clone({ model: runtime.wrapModel(new OpenGeniResponsesModel(client, "synthetic-model", { id: "synthetic", label: "Synthetic", kind: "api-key", api: "responses", builtin: true })) });
    const capture: ModelRequestCapture = () => {};
    capture.beforeCall = async request => {
      captured.push(request);
      for (const [ordinal, item] of request.input.entries()) {
        if (typeof item !== "object") throw Error("OBJECT_INPUT_REQUIRED");
        const binding = modelSourceInputBinding(item);
        if (!binding || binding.sourceRef.sha256 !== digest(item)) throw Error(`UNKNOWN_SOURCE:${ordinal}:${item.type}`);
      }
      return `source_${captured.length}`;
    };
    const initial = { type: "message" as const, role: "user" as const, content: "Read synthetic status" };
    bindModelSourceInput(initial, { kind: "HISTORY_ROW", sourceRef: { owner: "native.runtime.artifact", id: "initial", sha256: digest(initial) }, parents: [], retainedSources: [] });
    try {
      await withModelRequestCapture(capture, async () => {
        const runner = new Runner({ tracingDisabled: true, callModelInputFilter: callModelInputFilterForSettings(settings) });
        const result = streaming ? await runner.run(selected, [initial], { stream: true, historyOwnership: "external" }) : await runner.run(selected, [initial], { historyOwnership: "external" });
        if ("toStream" in result) { for await (const _event of result.toStream()) {} await result.completed; }
        expect(result.finalOutput).toBe("Status read");
        if (!unavailable) {
          // Use real Runner history, not hand-authored disclosure markers. A
          // changed schema or replayed marker cannot mint a native artifact.
          const altered = structuredClone(result.history);
          const call = altered.find(item => item.type === "function_call" && item.name === "tool_search");
          if (!call || call.type !== "function_call") throw Error("ACTUAL_SEARCH_CALL_REQUIRED");
          const marker = call.providerData?.["opengeni.lazy_search.v1"] as { tools: Array<Record<string, unknown>> } | undefined;
          if (!marker?.tools[0]) throw Error("ACTUAL_DISCLOSURE_SCHEMA_REQUIRED");
          marker.tools[0].description = "Unregistered schema instructions";
          const expanded = expandInteractionFamilyDisclosures(altered);
          const forged = expanded.find(item => item.type === "message" && item.role === "developer");
          expect(forged).toBeDefined();
          expect(modelSourceInputBinding(forged)).toBeUndefined();
          const boundary = new ModelRequestCaptureModel(new OpenGeniResponsesModel(client, "synthetic-model", { id: "synthetic", label: "Synthetic", kind: "api-key", api: "responses", builtin: true }));
          if (!forged) throw Error("FORGED_DISCLOSURE_REQUIRED");
          await expect(boundary.getResponse({ ...captured[0]!, input: [forged] })).rejects.toThrow("UNKNOWN_SOURCE");
          const unrelated: ModelRequestCapture = () => {};
          unrelated.beforeCall = async request => {
            if (request.input.some(item => !modelSourceInputBinding(item))) throw Error("UNKNOWN_SOURCE");
            return "foreign-source";
          };
          await expect(withModelRequestCapture(unrelated, () => {
            const replay = expandInteractionFamilyDisclosures(structuredClone(result.history)).find(item => item.type === "message" && item.role === "developer");
            if (!replay) throw Error("REPLAY_DISCLOSURE_REQUIRED");
            expect(modelSourceInputBinding(replay)).toBeUndefined();
            return boundary.getResponse({ ...captured[0]!, input: [replay] });
          })).rejects.toThrow("UNKNOWN_SOURCE");
        }
      });
      expect(executions).toBe(unavailable ? 0 : 1);
      expect(requests).toBe(3);
      if (unavailable) {
        const refused = captured[2]!.input.find(item => item.type === "function_call_result" && item.callId === "call_2");
        expect(JSON.stringify(refused)).toContain("tool_unavailable");
        expect(modelSourceInputBinding(refused)?.rawToolSource?.rawSourceRef.owner).toBe("native.tool.result");
      }
      const disclosure = captured[1]!.input.find(item => item.type === "message" && item.role === "developer");
      expect(disclosure).toBeDefined();
      const schemaBinding = modelSourceInputBinding(disclosure);
      expect(schemaBinding?.nativeProducerSourceKey).toBe("source_1");
      expect(schemaBinding?.kind).toBe("HISTORY_ROW");
      expect(schemaBinding?.sourceRef.owner).toBe("native.runtime.artifact");
      expect(schemaBinding?.parents).toEqual([]);
      expect(schemaBinding?.retainedSources).toEqual([]);
      expect(schemaBinding?.rawToolSource).toBeUndefined();
      const searchResult = captured[1]!.input.find(item => item.type === "function_call_result");
      expect(modelSourceInputBinding(searchResult)?.rawToolSource?.rawSourceRef.owner).toBe("native.tool.result");
    } finally {
      await prepared.close();
      for (const transport of transports) await transport.close();
      server.stop(true);
    }
  });
}
