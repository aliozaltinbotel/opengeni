import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WORKSPACE_MCP_TOOL_REFUSAL_CODES } from "@opengeni/contracts";
import {
  buildWorkspaceToolGatewayMcpServer,
  type PreparedWorkspaceToolGateway,
} from "../src/workspace-tool-gateway";

/*
 * A `tools/call` for a name the connection cannot call answers a named MCP
 * error (JSON-RPC -32602, as MCP answers an unknown tool, with data.code),
 * never the generic -32603 internal error.
 */

const listed = {
  identity: { serverId: "acme", toolName: "get_status" },
  modelName: "acme__get_status",
  codemodePath: ["acme", "get_status"],
  source: "mcp",
  approval: "none",
  inputSchema: { type: "object" },
};
const approvalOnly = {
  ...listed,
  identity: { serverId: "acme", toolName: "cancel_booking" },
  modelName: "acme__cancel_booking",
  codemodePath: ["acme", "cancel_booking"],
  approval: "human",
};

async function gateway(options: { consentFrozen?: boolean }) {
  let calls = 0;
  const prepared = {
    toolGateway: {
      prepareCall: async () => ({
        execute: async () => {
          calls += 1;
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    },
    toolGatewayCatalog: { digest: "test-digest", entries: [listed, approvalOnly] },
    close: async () => undefined,
    ...(options.consentFrozen ? { consentFrozen: true } : {}),
  } as unknown as PreparedWorkspaceToolGateway;
  const server = buildWorkspaceToolGatewayMcpServer(prepared, { subjectId: "user:1" } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-refusals", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string) =>
    await client.callTool({ name, arguments: {} }).then(
      (result) => ({ result, error: undefined }),
      (error: { code?: number; data?: unknown }) => ({
        result: undefined,
        error: { code: error.code, data: error.data },
      }),
    );
  return {
    call,
    calls: () => calls,
    close: async () => await Promise.allSettled([client.close(), server.close()]),
  };
}

describe("workspace MCP tools/call refusals", () => {
  test("an MCP OAuth connection answers TOOL_NOT_CONSENTED for a tool outside its consent", async () => {
    const mcp = await gateway({ consentFrozen: true });
    try {
      expect((await mcp.call("acme__get_status")).result).toBeDefined();
      expect((await mcp.call("acme__delete_everything")).error).toEqual({
        code: -32602,
        data: {
          code: WORKSPACE_MCP_TOOL_REFUSAL_CODES.notConsented,
          name: "acme__delete_everything",
        },
      });
      expect(mcp.calls()).toBe(1);
    } finally {
      await mcp.close();
    }
  });

  test("another caller answers TOOL_NOT_FOUND for a name outside its catalog", async () => {
    const mcp = await gateway({});
    try {
      expect((await mcp.call("acme__missing")).error).toEqual({
        code: -32602,
        data: { code: "TOOL_NOT_FOUND", name: "acme__missing" },
      });
    } finally {
      await mcp.close();
    }
  });

  test("a tool listed only for a person's approval answers TOOL_APPROVAL_REQUIRED", async () => {
    for (const consentFrozen of [true, false]) {
      const mcp = await gateway({ consentFrozen });
      try {
        expect((await mcp.call("acme__cancel_booking")).error).toEqual({
          code: -32602,
          data: { code: "TOOL_APPROVAL_REQUIRED", name: "acme__cancel_booking" },
        });
        expect(mcp.calls()).toBe(0);
      } finally {
        await mcp.close();
      }
    }
  });
});
