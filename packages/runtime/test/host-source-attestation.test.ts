import { expect, test } from "bun:test";
import { Usage, type Model, type ModelRequest } from "@openai/agents";
import { testSettings } from "@opengeni/testing/settings";
import { NATIVE_HOST_SOURCE_HEADER, verifyHostSourceAttestation } from "@opengeni/contracts";
import { ModelRequestCaptureModel, withModelRequestCapture, type ModelRequestCapture } from "../src/model-request-capture";
import { nativeHostSourceRequestInit, withNativeHostSourceInvocation } from "../src/host-source-attestation";
import { prepareAgentTools } from "../src/index";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const scope = { accountId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333", turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555", executionGeneration: 2 };
const secret = "test-only-host-source-secret", subjectId = "user:owner";
const identity = { serverId: "host", toolName: "prepare" }, args = { z: 2, a: 1 };
const operationId = "66666666-6666-4666-8666-666666666666";

async function producer<T>(sourceKey: string, callId: string, modelName: string, run: () => Promise<T>): Promise<T> {
  const capture: ModelRequestCapture = Object.assign(() => {}, { beforeCall: async () => sourceKey });
  const model: Model = { async getResponse() { return { usage: new Usage(), output: [{ type: "function_call", name: modelName, callId, arguments: JSON.stringify(args), status: "completed" }] }; },
    getStreamedResponse() { throw new Error("unused"); } };
  return await withModelRequestCapture(capture, async () => {
    await new ModelRequestCaptureModel(model).getResponse({ input: [], tools: [], modelSettings: {}, outputType: "text", tracing: false, systemInstructions: "Synthetic instruction" } as ModelRequest);
    return await run();
  });
}

test("real runtime remote MCP dispatch signs the original producer per concurrent call and keeps OAuth separate", async () => {
  const seen: Array<{ key: string; callId: string; authorization: string | null; workerSubject: string; connectionSubject: string }> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const mcp = new Server({ name: "native-host-fixture", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "host__prepare", inputSchema: { type: "object", properties: { a: { type: "number" }, z: { type: "number" } } }, _meta: { "opengeni/identity": identity } }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => {
      const token = request.headers.get(NATIVE_HOST_SOURCE_HEADER);
      const proof = token ? await verifyHostSourceAttestation(secret, token) : null;
      if (!proof) throw new Error("trusted source missing");
      seen.push({ key: proof.hostSource.nativeModelSourceKey, callId: proof.hostSource.sourceCallId, authorization: request.headers.get("authorization"), workerSubject: proof.subjectId, connectionSubject: proof.hostSource.connectionSubjectId });
      return { content: [] };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await mcp.connect(transport);
    try { return await transport.handleRequest(request); } finally { await mcp.close(); }
  } });
  const url = `http://127.0.0.1:${provider.port}/v1/workspaces/${scope.workspaceId}/mcp`;
  const settings = testSettings({ sandboxBackend: "none", delegationSecret: secret, publicBaseUrl: `http://127.0.0.1:${provider.port}`,
    integrationsAllowPrivateNetworkTargets: true, mcpServers: [{ id: "remote", url, headers: { authorization: "Bearer ogmcp_at_synthetic", [NATIVE_HOST_SOURCE_HEADER]: "forged-config-header" } }] });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "remote", eager: true }], { ...scope, subjectId: "worker:first-party-mcp", credentialSubjectId: subjectId });
  try {
    const entry = prepared.attemptToolCatalog?.entries[0];
    if (!entry || !prepared.attemptToolEnvironment) throw new Error("attempt environment missing");
    await Promise.all(["one", "two"].map(async value => await producer(`source-${value}`, `call-${value}`, entry.modelName, async () =>
      await prepared.attemptToolEnvironment!.callModel({ modelName: entry.modelName, arguments: { a: 1, z: 2 }, subjectId,
        sourceCallId: `call-${value}`, nativeModelSourceKey: `source-${value}` }))));
    expect(seen.map(value => `${value.key}/${value.callId}`).sort()).toEqual(["source-one/call-one", "source-two/call-two"]);
    expect(seen.every(value => value.authorization === "Bearer ogmcp_at_synthetic")).toBe(true);
    expect(seen.map(value => [value.workerSubject, value.connectionSubject])).toEqual([
      ["worker:first-party-mcp", "user:owner"], ["worker:first-party-mcp", "user:owner"],
    ]);
  } finally { await prepared.close(); await provider.stop(true); }
});

test("public metadata cannot create a producer; wrong originating key and changed physical input refuse", async () => {
  const settings = testSettings({ delegationSecret: secret, publicBaseUrl: "https://native.invalid" });
  const resource = `https://native.invalid/v1/workspaces/${scope.workspaceId}/mcp`;
  const init = { method: "POST", headers: { authorization: "Bearer ogmcp_at_synthetic", [NATIVE_HOST_SOURCE_HEADER]: "forged" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "host__prepare", arguments: args, _meta: { nativeModelSourceKey: "forged" } } }) };
  expect(new Headers((await nativeHostSourceRequestInit(settings, resource, init))?.headers).has(NATIVE_HOST_SOURCE_HEADER)).toBe(false);
  const context = { operationId, caller: { kind: "model" as const, subjectId }, sourceCallId: "call-one", nativeModelSourceKey: "forged" };
  await expect(producer("source-one", "call-one", "remote__host__prepare", async () =>
    withNativeHostSourceInvocation(scope, "worker:first-party-mcp", subjectId, context, identity, "host__prepare", args, async () => {}))).rejects.toThrow("HOST_SOURCE_ORIGINAL_CALL_UNAVAILABLE");
  await expect(producer("source-one", "call-one", "remote__host__prepare", async () =>
    withNativeHostSourceInvocation(scope, "worker:first-party-mcp", subjectId, { ...context, nativeModelSourceKey: "source-one" }, identity, "host__prepare", { a: 9 }, async () =>
      await nativeHostSourceRequestInit(settings, resource, init)))).rejects.toThrow("HOST_SOURCE_TARGET_MISMATCH");
});
