import { expect, test } from "bun:test";
import { Runner, MCPServerStreamableHttp, type MCPServer, type ModelRequest, type AgentInputItem, type StreamEvent } from "@openai/agents";
import { createHash } from "node:crypto";
import { ScriptedModel, functionCall, testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, prepareAgentTools, createProductionAgentRuntime } from "../src/index";
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
        if (streaming) { const result = await new Runner({tracingDisabled:true}).run(agent, [input], { stream: true, historyOwnership: "external" }); for await (const _event of result) {} await result.completed; }
        else await new Runner({tracingDisabled:true}).run(agent, [input], { historyOwnership: "external" });
      });
      expect(requests).toHaveLength(2);
    } finally { await prepared.close(); }
  });
}


test("production streaming runtime binds genuine loopback MCP calls after SDK projection", async () => {
  const native = await import("@opengeni/db");
  const nativeUrl = process.env.OPENGENI_NATIVE_MCP_SOURCE_APP_URL;
  const db = nativeUrl ? native.createDb(nativeUrl, { max: 4 }) : undefined;
  const scope: { accountId: string; workspaceId: string; sessionId: string; turnId: string; attemptId: string; executionGeneration: number } = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), attemptId: crypto.randomUUID(), executionGeneration: 1 };
  let selections: { instructionPolicySnapshotId: string; companyProfileSnapshotId: string; preferenceSnapshotId: string } | undefined;
  let nativeRows: Awaited<ReturnType<typeof native.getActiveSessionHistoryItemsPaged>> | undefined;
  if (db) {
    const role = await db.db.execute(await import("drizzle-orm").then(({ sql }) => sql`select r.rolsuper,r.rolbypassrls,current_setting('server_version_num')::int version from pg_roles r where r.rolname=current_user`));
    const flags = role[0] as { rolsuper: boolean; rolbypassrls: boolean; version: number };
    expect(flags.rolsuper).toBe(false); expect(flags.rolbypassrls).toBe(false);
    expect(flags.version).toBeGreaterThanOrEqual(170000); expect(flags.version).toBeLessThan(180000);
    const subjectId = crypto.randomUUID();
    const access = await native.bootstrapWorkspace(db.db, { accountExternalSource: "native-mcp-source", accountExternalId: subjectId, accountName: "Synthetic", workspaceExternalSource: "native-mcp-source", workspaceExternalId: subjectId, workspaceName: "Synthetic", subjectId });
    scope.accountId = access.workspaceGrants[0]!.accountId; scope.workspaceId = access.workspaceGrants[0]!.workspaceId;
    const session = await native.createSession(db.db, { accountId: scope.accountId, workspaceId: scope.workspaceId, initialMessage: "Synthetic request", createdBy: { kind: "subject", subjectId }, resources: [], metadata: {}, model: "scripted", reasoningEffort: "low", latencyMode: "standard", sandboxBackend: "none" });
    scope.sessionId = session.id;
    await native.initializeSessionStartAtomically(db.db, { ...scope, reasoningEffortFallback: "low", createdEventPayload: {} });
    const claim = await native.claimSessionWorkForAttempt(db.db, scope.workspaceId, { sessionId: scope.sessionId, workflowId: `session-${scope.sessionId}`, workflowRunId: crypto.randomUUID(), dispatchId: subjectId, attemptId: scope.attemptId, trigger: { kind: "next" } });
    if (claim.action !== "claimed") throw Error("Native fixture claim refused");
    scope.turnId = claim.turn.id; scope.executionGeneration = claim.turn.executionGeneration;
    selections = await native.withSessionRlsActorContext({ subjectId: "worker:native-mcp-source", initiatingHumanSubjectId: subjectId }, async () => ({
      instructionPolicySnapshotId: (await native.getOrCreateWorkspaceInstructionPolicySnapshot(db.db, scope)).id,
      companyProfileSnapshotId: (await native.getOrCreateCompanyProfileSnapshot(db.db, scope)).id,
      preferenceSnapshotId: (await native.getOrCreatePreferenceRegistrySnapshot(db.db, scope)).id,
    }));
    nativeRows = await native.getActiveSessionHistoryItemsPaged(db.db, scope.workspaceId, scope.sessionId);
  }
  const receipts: Awaited<ReturnType<typeof native.persistModelCallSourceReceipt>>[] = [];
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
  const transports: InstanceType<typeof WebStandardStreamableHTTPServerTransport>[] = [];
  const raw = { content: [{ type: "text" as const, text: "Synthetic current evidence" }], structuredContent: { passage: "Synthetic current evidence" } };
  const retained = { owner: "cendra.knowledge.retrieval_use", id: crypto.randomUUID(), version: "1", sha256: digest("Synthetic current evidence") };
  const providerCalls: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const server = new McpServer({ name: "synthetic-cendra-pms", version: "1.0.0" });
    server.registerTool("knowledge_search", { inputSchema: {} }, async () => { providerCalls.push("knowledge_search"); return raw; });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    transports.push(transport); await server.connect(transport); return transport.handleRequest(request);
  } });
  const url = `http://127.0.0.1:${provider.port}/mcp`;
  const server = new MCPServerStreamableHttp({ name: "cendra-pms", url, cacheToolsList: false });
  const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false, openaiProviderItemIds: "strip", mcpServers: [{ id: "cendra-pms", url, cacheToolsList: false }] });
  const requests: ModelRequest[] = [];
  const outputs: object[] = [];
  const step = (request: ModelRequest) => {
    if (requests.length > 8) return { outputText: "Synthetic grounded answer" };
    const tool = request.tools.find(value => value.type === "function" && value.name.endsWith("__knowledge_search"));
    if (!tool || tool.type !== "function") throw Error("Actual advertised MCP tool missing");
    return { output: [functionCall(tool.name, {}, crypto.randomUUID())] };
  };
  const runtime = createProductionAgentRuntime({ model: {
    async getResponse() { throw Error("streaming required"); },
    async *getStreamedResponse(request) {
      for await (const event of new ScriptedModel([step(request)]).getStreamedResponse(request)) {
        if (event.type === "response_done") outputs.push(...event.response.output);
        yield event;
      }
    },
  } });
  const prepared = await runtime.prepareTools(settings, [{ kind: "mcp", id: "cendra-pms" }], {
    ...scope,
    localMcpServers: [{ id: "cendra-pms", server, modelSourceRefs: () => [retained] }],
  });
  try {
    const agent = runtime.buildAgent(settings, [], { mcpServers: prepared.mcpServers });
    const initial = { type: "message" as const, role: "user" as const, content: "Synthetic request" };
    bindModelSourceInput(initial, { kind: "HISTORY_ROW", sourceRef: { owner: "native.runtime.artifact", id: "initial", sha256: digest(initial) }, parents: [], retainedSources: [] });
    for (const row of nativeRows ?? []) bindModelSourceInput(row.item, { kind: "HISTORY_ROW", sourceRef: { owner: "session_history_items", id: row.id, sha256: row.sourceSha256! }, parents: [], retainedSources: [] });
    const input = await runtime.prepareInput(agent, { kind: "message", historyItems: nativeRows ? nativeRows.map(row => row.item as AgentInputItem) : [initial] });
    const stream = await runtime.runStream(agent, input, settings, { beforeModelCallSourceReceipt: async request => {
      requests.push(request);
      if (!Array.isArray(request.input)) throw Error("Array input required");
      const bindings = modelSourceBindings(request.input);
      if (requests.length === 2) {
        const projected = request.input.find(value => value.type === "function_call");
        console.log(JSON.stringify({ event: "native-mcp-output-projection", raw: outputs[0], projected, sameObject: outputs[0] === projected, rawSha256: digest(outputs[0]), projectedSha256: digest(projected), bindings: bindings.map(binding => ({ ordinal: binding.ordinal, kind: binding.kind })) }));
      }
      expect(bindings).toHaveLength(request.input.length);
      for (const value of request.input) {
        if (value.type !== "function_call") continue;
        const rawCall = outputs.find(output => "callId" in output && output.callId === value.callId);
        expect(rawCall).toBeDefined();
        expect(rawCall).not.toBe(value);
        const { id: _id, ...projection } = rawCall as Record<string, unknown>;
        expect(JSON.stringify(value)).toBe(JSON.stringify(projection));
        const binding = modelSourceBindings([value])[0]!;
        expect(binding.sourceRef.sha256).toBe(digest(value));
      }
      const results = bindings.filter(binding => binding.kind === "TOOL_RESULT");
      for (const result of results) {
        expect(result.retainedSources).toEqual([retained]);
        expect(result.rawToolSource!.rawSourceRef.sha256).toBe(digest(result.rawToolResult));
        expect(result.sourceRef.sha256).not.toBe(result.rawToolSource!.rawSourceRef.sha256);
      }
      expect(JSON.stringify(request.input)).not.toContain(retained.owner);
      if (db) {
        const identity = { ...scope, sourceKey: crypto.randomUUID(), requestIndex: requests.length };
        const receipt = await native.persistModelCallSourceReceipt(db.db, identity, { purpose: "AGENT", instructions: request.systemInstructions, input: request.input, sourceBindings: bindings, tools: request.tools, instructionSelections: selections! });
        expect(receipt.complete).toBe(true); expect(receipt.incompleteReasons).toEqual([]);
        expect((await native.readModelCallSourceReceipt(db.db, identity)).receipt).toEqual(receipt);
        receipts.push(receipt); return receipt.sourceKey;
      }
      return `production-source-${requests.length}`;
    } });
    for await (const _event of stream) {} await stream.completed;
    expect(requests).toHaveLength(9); expect(providerCalls).toHaveLength(8);
    const outputCount = outputs.length;
    const unknown = await runtime.prepareInput(agent, { kind: "message", historyItems: [{ role: "user", content: "Unattributed synthetic source" }] });
    await expect((async () => {
      const refused = await runtime.runStream(agent, unknown, settings, { beforeModelCallSourceReceipt: async request => {
        expect(modelSourceBindings(request.input)).toHaveLength(0);
        if (db) {
          const receipt = await native.persistModelCallSourceReceipt(db.db, { ...scope, sourceKey: crypto.randomUUID(), requestIndex: requests.length + 1 }, { input: request.input });
          expect(receipt.complete).toBe(false); expect(receipt.incompleteReasons).toContain("UNKNOWN_SOURCE");
        }
        throw Error("UNKNOWN_SOURCE");
      } });
      for await (const _event of refused) {} await refused.completed;
    })()).rejects.toThrow("UNKNOWN_SOURCE");
    expect(outputs).toHaveLength(outputCount); expect(providerCalls).toHaveLength(8);
    if (db) {
      expect(receipts).toHaveLength(requests.length);
      for (const [index, request] of requests.entries()) {
        const receipt = receipts[index]!;
        for (const binding of modelSourceBindings(request.input).filter(value => value.nativeProducerSourceKey)) {
          const producer = receipts.find(value => value.sourceKey === binding.nativeProducerSourceKey)!;
          expect(producer).toBeDefined(); expect(producer.complete).toBe(true); expect(producer.purpose).toBe("AGENT");
          expect(producer.requestIndex).toBeLessThan(receipt.requestIndex);
          const artifact = receipt.closure.find(node => node.sourceRef.id === binding.sourceRef.id)!;
          expect(artifact).toBeDefined();
          for (const ancestor of producer.inputs.flatMap(value => value.sourceRef ? [value.sourceRef] : [])) expect(artifact.parents).toContainEqual(ancestor);
        }
      }
      const final = requests.at(-1)!;
      const bindings = modelSourceBindings(final.input);
      const callBinding = bindings.find(value => value.nativeProducerSourceKey && value.kind === "HISTORY_ROW")!;
      const toolBinding = bindings.find(value => value.kind === "TOOL_RESULT")!;
      const persistMutant = async (mutant: typeof bindings) => await native.persistModelCallSourceReceipt(db.db, { ...scope, sourceKey: crypto.randomUUID(), requestIndex: requests.length + 2 }, { input: final.input, sourceBindings: mutant });
      const title = await native.persistModelCallSourceReceipt(db.db, { ...scope, sourceKey: crypto.randomUUID(), requestIndex: requests.length + 1 }, { purpose: "TITLE", input: nativeRows!.map(row => row.item) });
      expect(title.complete).toBe(true);
      for (const producerKey of [crypto.randomUUID(), title.sourceKey]) {
        const mutant = bindings.map(value => value === callBinding ? { ...value, nativeProducerSourceKey: producerKey } : value);
        const refused = await persistMutant(mutant); expect(refused.complete).toBe(false); expect(refused.incompleteReasons).toContain("UNRESOLVED_PARENT");
      }
      const rawMutant = bindings.map(value => value === toolBinding ? { ...value, rawToolResult: { content: [] } } : value);
      expect((await persistMutant(rawMutant)).complete).toBe(false);
      const finalReceipt = receipts.at(-1)!;
      await native.applySessionTurnSettlement(db.db, scope.workspaceId, { sessionId: scope.sessionId, turnId: scope.turnId, triggerEventId: (await native.getSessionTurn(db.db, scope.workspaceId, scope.turnId))!.triggerEventId, attemptId: scope.attemptId, turnStatus: "completed", sessionStatus: "idle", activeTurnId: null, events: [{ type: "turn.completed", payload: { output: "Synthetic answer" } }] });
      expect((await native.validateRetainedModelSources(db.db, { identity: { ...scope, sourceKey: finalReceipt.sourceKey, requestIndex: finalReceipt.requestIndex }, receipt: finalReceipt })).incompleteReasons).toContain("ATTEMPT_NOT_CURRENT");
      console.log(JSON.stringify({ event: "native-mcp-source-pg17", requests: receipts.length, receiptsComplete: receipts.every(value => value.complete), role: "NONSU_NOBYPASSRLS", exactClosure: true, rawDigestMutant: "REFUSED", producerMutants: "REFUSED", settledAttempt: "REFUSED" }));
    }
  } finally {
    await prepared.close(); await server.close();
    for (const transport of transports) await transport.close();
    provider.stop(true); await db?.close();
  }
});

test("only the installed id projection of genuine output can restore a producer binding", async () => {
  const { Usage } = await import("@openai/agents");
  const requestWith = (systemInstructions: string, input: ModelRequest["input"]): ModelRequest => ({ systemInstructions, input, modelSettings: {}, tools: [], handoffs: [], outputType: "text", tracing: false });
  const actual = functionCall("mcp_actual__knowledge_search", { query: "Synthetic query" });
  let calls = 0;
  const capture: ModelRequestCapture = () => {};
  capture.beforeCall = async sent => {
    if (calls > 0 && modelSourceBindings(sent.input).length === 0) throw Error("UNKNOWN_SOURCE");
    return `exact-producer-${calls + 1}`;
  };
  const model = new ModelRequestCaptureModel({ async getResponse() { calls++; return { usage: new Usage(), output: calls === 1 ? [actual] : [] }; }, getStreamedResponse(): AsyncIterable<StreamEvent> { throw Error("unused"); } });
  await withModelRequestCapture(capture, async () => {
    await model.getResponse(requestWith("Synthetic instruction", []));
    const { id: _id, ...projected } = structuredClone(actual);
    const restored = requestWith("Synthetic instruction", [projected]);
    await model.getResponse(restored);
    expect(modelSourceBindings(restored.input)[0]!.nativeProducerSourceKey).toBe("exact-producer-1");
    // Derive the closed wire shape from the genuine provider producer. Changing
    // any surviving field, omitting one, or adding a field must fail closed.
    for (const field of Object.keys(projected)) {
      for (const operation of ["change", "omit"] as const) {
        const altered: Record<string, unknown> = structuredClone(projected);
        if (operation === "omit") delete altered[field]; else altered[field] = `changed:${String(altered[field])}`;
        await expect(model.getResponse(requestWith("Synthetic instruction", [altered] as ModelRequest["input"]))).rejects.toThrow("UNKNOWN_SOURCE");
      }
    }
    const extended: Record<string, unknown> = { ...structuredClone(projected), extra: "unsupported" };
    await expect(model.getResponse(requestWith("Synthetic instruction", [extended] as ModelRequest["input"]))).rejects.toThrow("UNKNOWN_SOURCE");
    expect(calls).toBe(2);
  });
});
