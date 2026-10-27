import { describe, expect, test } from "bun:test";
import type { AccessGrant, FirstPartyMcpToolName } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

/*
 * The first-party MCP server is the API's call admission for the worker, for
 * Codemode and for any MCP client. A host policy's denied families are never
 * registered, whatever the delegated token's signed tool selection claims.
 */

const scope = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
};

const CLAIMED: FirstPartyMcpToolName[] = [
  "command_read",
  "command_wait",
  "sandboxes_list",
  "sandbox_attach",
  "run_on",
  "connected_machine_enroll_token",
  "connected_machine_enable_screen_control",
  "knowledge_search",
  "set_session_title",
];

function deps(): ApiRouteDeps {
  return {
    settings: testSettings({ sandboxSelfhostedEnabled: true }),
    db: {},
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as unknown as ApiRouteDeps;
}

function agentGrant(): AccessGrant {
  return {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions: [
      "sessions:read",
      "sessions:control",
      "enrollments:manage",
      "knowledge:read",
      "documents:search",
    ],
    principalKind: "agent_attempt",
    metadata: {
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      executionGeneration: 1,
      firstPartyMcpTools: CLAIMED,
    },
  };
}

function registered(server: unknown): string[] {
  return Object.keys(
    (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  )
    .filter((name) => !name.startsWith("__opengeni_empty_"))
    .sort();
}

describe("first-party MCP admission under a host session policy", () => {
  test("without a restriction the claimed shell and computer tools are registered", () => {
    const names = registered(buildOpenGeniMcpServer(deps(), agentGrant()));
    for (const tool of ["command_read", "sandboxes_list", "connected_machine_enroll_token"])
      expect(names).toContain(tool);
  });

  test("denied families are not registered even though the signed selection names them", () => {
    const names = registered(
      buildOpenGeniMcpServer(deps(), agentGrant(), {
        deniedToolFamilies: ["shell", "codemode", "browser", "computerUse"],
      }),
    );
    for (const tool of [
      "command_read",
      "command_wait",
      "sandboxes_list",
      "sandbox_attach",
      "run_on",
      "connected_machine_enroll_token",
      "connected_machine_enable_screen_control",
    ])
      expect(names).not.toContain(tool);
    expect(names).toContain("set_session_title");
  });

  test("a forged call to a denied tool is refused", async () => {
    const server = buildOpenGeniMcpServer(deps(), agentGrant(), { deniedToolFamilies: ["shell"] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "session-tool-family-forged-call", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed).not.toContain("command_read");
      const result = await client
        .callTool({ name: "command_read", arguments: { commandId: crypto.randomUUID() } })
        .catch((error: unknown) => ({ isError: true, error }));
      expect((result as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
