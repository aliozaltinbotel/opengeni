import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { canonicalModelSourceJson, NATIVE_HOST_SOURCE_HEADER, signDelegatedAccessToken, type AccessGrant, type ModelCallSourceReceipt, type NativeHostSourceContext } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { digestCanonicalJson } from "@opengeni/tool-gateway";
import { prepareWorkspaceToolGatewayTools } from "@opengeni/runtime/workspace-tool-gateway";
import { nativeHostSourceVerifier } from "../src/host-source-attestation";
import { buildWorkspaceToolGatewayMcpServer, type PreparedWorkspaceToolGateway } from "../src/workspace-tool-gateway";

const scope = { accountId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333", turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555", executionGeneration: 2 };
const secret = "test-only-host-source-secret", authorization = "Bearer ogmcp_at_synthetic";
const resource = `https://native.invalid/v1/workspaces/${scope.workspaceId}/mcp`;
const settings = testSettings({ delegationSecret: secret, publicBaseUrl: "https://native.invalid", mcpServers: [{ id: "host", url: "https://unused.invalid" }] });
const grant: AccessGrant = { ...scope, subjectId: "user:owner", principalKind: "human_session", permissions: ["workspace:read"], metadata: { mcpOAuth: true } };
const args = { z: 2, a: 1 };
const sourceRef = { owner: "native.runtime.artifact", id: "synthetic-instruction", sha256: "a".repeat(64) };
function receipt(sourceKey = "original-source"): ModelCallSourceReceipt {
  const body = { version: 1 as const, ...scope, id: "77777777-7777-4777-8777-777777777777", sourceKey, requestIndex: 1, purpose: "AGENT" as const,
    inputs: [{ ordinal: 0, kind: "INSTRUCTION" as const, contentSha256: sourceRef.sha256, sourceRef, parents: [], retainedSources: [] }],
    closure: [{ kind: "INSTRUCTION" as const, sourceRef, parents: [], retainedSources: [] }], complete: true, incompleteReasons: [] };
  return { ...body, digest: createHash("sha256").update(canonicalModelSourceJson(body)).digest("hex") };
}
async function proof(overrides: Partial<NonNullable<Parameters<typeof signDelegatedAccessToken>[1]["hostSource"]>> = {}) {
  return await signDelegatedAccessToken(secret, { ...scope, subjectId: "worker:first-party-mcp", principalKind: "agent_attempt", permissions: ["workspace:read"], exp: Math.floor(Date.now() / 1000) + 60,
    hostSource: { purpose: "HOST_SOURCE", resource, serverId: "host", toolName: "prepare", wireToolName: "host__prepare",
      nativeModelSourceKey: "original-source", sourceCallId: "call-original", operationId: "66666666-6666-4666-8666-666666666666",
      inputSha256: digestCanonicalJson(args), credentialSha256: digestCanonicalJson(authorization), connectionSubjectId: grant.subjectId, ...overrides } });
}
const response = (value: ModelCallSourceReceipt) => ({ schema: "cendra.native-source-basis/v1", receipt: value });
const request = (token?: string, bearer = authorization) => new Request(resource, { headers: { authorization: bearer, ...(token ? { [NATIVE_HOST_SOURCE_HEADER]: token } : {}) } });
async function prepared(calls: NativeHostSourceContext[]) {
  const native = await prepareWorkspaceToolGatewayTools(settings, [{ kind: "mcp", id: "host" }], {
    accountId: scope.accountId, workspaceId: scope.workspaceId, workspaceToolGateway: {},
    localMcpServers: [{ id: "host", server: { name: "host", cacheToolsList: false, async connect() {}, async close() {},
      async listTools() { return [{ name: "prepare", inputSchema: { type: "object", properties: { a: { type: "number" }, z: { type: "number" } }, additionalProperties: false } }]; },
      async callTool() { throw new Error("source-required preparation"); } },
      async callToolWithSource(_name, _args, source) { await Promise.resolve(); calls.push(source); return { content: [] }; } }],
  });
  if (!native.toolGateway || !native.toolGatewayCatalog) throw new Error("gateway missing");
  return { toolGateway: native.toolGateway, toolGatewayCatalog: native.toolGatewayCatalog, close: native.close } satisfies PreparedWorkspaceToolGateway;
}

test("verified source reaches the physical host registration per call, without shared state", async () => {
  const calls: NativeHostSourceContext[] = [], gateway = await prepared(calls);
  const entry = gateway.toolGatewayCatalog.entries[0]!;
  const verify = nativeHostSourceVerifier({ db: {} as never, settings }, grant, request(await proof()), {
    currentConnection: async () => {}, currentAttempt: async attempt => { expect(attempt.subjectId).toBe("worker:first-party-mcp"); }, readReceipt: async () => response(receipt()),
  });
  const server = buildWorkspaceToolGatewayMcpServer(gateway, grant, undefined, verify);
  const client = new Client({ name: "host-source-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const results = await Promise.all([1, 2].map(() => client.callTool({ name: entry.modelName, arguments: { a: 1, z: 2 } })));
    expect(results.every(result => !result.isError)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.nativeModelSourceKey).toBe("original-source");
    expect(calls[0]?.receiptDigest).toBe(receipt().digest);
  } finally { await client.close(); await server.close(); await gateway.close(); }
});

test("public metadata cannot create source context; wrong scope, input, target, credential and purpose refuse", async () => {
  const gateway = await prepared([]), entry = gateway.toolGatewayCatalog.entries[0]!;
  try {
    expect(nativeHostSourceVerifier({ db: {} as never, settings }, grant, request())).toBeUndefined();
    for (const overrides of [{ serverId: "other" }, { toolName: "other" }, { wireToolName: "other" }, { inputSha256: "b".repeat(64) }, { credentialSha256: "c".repeat(64) }, { resource: resource + "?other" }]) {
      const verify = nativeHostSourceVerifier({ db: {} as never, settings }, grant, request(await proof(overrides)), {
        currentConnection: async () => {}, currentAttempt: async () => {}, readReceipt: async () => response(receipt()),
      });
      await expect(verify!(entry, args)).rejects.toMatchObject({ status: 403 });
    }
    for (const mismatch of [{ accountId: "88888888-8888-4888-8888-888888888888" }, { workspaceId: "88888888-8888-4888-8888-888888888888" }, { subjectId: "user:other" }, { principalKind: "agent_attempt" as const }]) {
      const verify = nativeHostSourceVerifier({ db: {} as never, settings }, { ...grant, ...mismatch }, request(await proof()), { currentConnection: async () => {}, currentAttempt: async () => {}, readReceipt: async () => response(receipt()) });
      await expect(verify!(entry, args)).rejects.toMatchObject({ status: 403 });
    }
  } finally { await gateway.close(); }
});

test("stale generation, missing/corrupt source and withdrawal during the read cannot reach preparation", async () => {
  const gateway = await prepared([]), entry = gateway.toolGatewayCatalog.entries[0]!;
  try {
    for (const value of [null, { ...receipt(), executionGeneration: 1 }, { ...receipt(), digest: "b".repeat(64) }, { ...receipt(), sourceKey: "other" }]) {
      const verify = nativeHostSourceVerifier({ db: {} as never, settings }, grant, request(await proof()), {
        currentConnection: async () => {}, currentAttempt: async () => {}, readReceipt: async () => ({ schema: "cendra.native-source-basis/v1", receipt: value }),
      });
      await expect(verify!(entry, args)).rejects.toMatchObject({ status: 403 });
    }
    let reads = 0;
    const verify = nativeHostSourceVerifier({ db: {} as never, settings }, grant, request(await proof()), {
      currentConnection: async () => {}, currentAttempt: async () => { if (++reads === 2) throw new Error("attempt withdrawn"); }, readReceipt: async () => response(receipt()),
    });
    await expect(verify!(entry, args)).rejects.toThrow("attempt withdrawn");
  } finally { await gateway.close(); }
});

test("public forged metadata and an attempt withdrawn before physical dispatch never reach the source hook", async () => {
  for (const mode of ["public", "attempt", "connection"] as const) {
    const calls: NativeHostSourceContext[] = [], gateway = await prepared(calls);
    let checks = 0, connections = 0;
    const verify = mode !== "public" ? nativeHostSourceVerifier({ db: {} as never, settings }, grant, request(await proof()), {
      currentConnection: async () => { if (mode === "connection" && ++connections === 2) throw new Error("connection withdrawn before dispatch"); },
      currentAttempt: async () => { if (mode === "attempt" && ++checks === 3) throw new Error("attempt withdrawn before dispatch"); },
      readReceipt: async () => response(receipt()),
    }) : undefined;
    const server = buildWorkspaceToolGatewayMcpServer(gateway, grant, undefined, verify);
    const client = new Client({ name: "host-source-negative", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    try {
      await expect(client.callTool({ name: "host__prepare", arguments: args,
        _meta: { nativeHostSource: { ...scope, nativeModelSourceKey: "original-source" }, nativeModelSourceKey: "original-source" },
      })).rejects.toThrow(mode === "public" ? "source-required preparation" : `${mode} withdrawn before dispatch`);
      expect(calls).toEqual([]);
    } finally { await client.close(); await server.close(); await gateway.close(); }
  }
});
