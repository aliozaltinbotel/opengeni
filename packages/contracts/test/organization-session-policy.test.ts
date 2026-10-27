import { describe, expect, test } from "bun:test";
import {
  AGENT_FUNCTION_TOOL_CAPABILITIES,
  CUA_DESKTOP_TOOLS,
  FIRST_PARTY_MCP_TOOL_CAPABILITIES,
  FIRST_PARTY_MCP_TOOL_NAMES,
} from "@opengeni/contracts";
import {
  GOVERNED_ORGANIZATION_SESSION_POLICY,
  HostPutOrganizationSessionPolicyRequest,
  OrganizationSessionPolicy,
  SESSION_TOOL_FAMILIES,
  STOCK_ORGANIZATION_SESSION_POLICY,
  deniedSessionToolFamilies,
  sessionToolFamilyGate,
  sessionToolFamilyOf,
} from "@opengeni/contracts/organization-session-policy";

describe("organization session policy", () => {
  test("stock restricts nothing; the governed default denies every generic family and attachments", () => {
    expect(STOCK_ORGANIZATION_SESSION_POLICY).toEqual({
      attachments: "enabled",
      toolFamilies: { mode: "deny", families: [] },
    });
    expect(GOVERNED_ORGANIZATION_SESSION_POLICY).toEqual({
      attachments: "disabled",
      toolFamilies: { mode: "deny", families: ["shell", "codemode", "browser", "computerUse"] },
    });
    expect(deniedSessionToolFamilies(STOCK_ORGANIZATION_SESSION_POLICY)).toEqual([]);
    expect(deniedSessionToolFamilies(GOVERNED_ORGANIZATION_SESSION_POLICY)).toEqual([
      ...SESSION_TOOL_FAMILIES,
    ]);
  });

  test("an allowlist denies every family it does not name", () => {
    expect(
      deniedSessionToolFamilies({
        attachments: "enabled",
        toolFamilies: { mode: "allow", families: ["browser"] },
      }),
    ).toEqual(["shell", "codemode", "computerUse"]);
    expect(
      deniedSessionToolFamilies({
        attachments: "enabled",
        toolFamilies: { mode: "allow", families: [] },
      }),
    ).toEqual([...SESSION_TOOL_FAMILIES]);
  });

  test("the policy schema is strict and bounded", () => {
    expect(OrganizationSessionPolicy.safeParse(GOVERNED_ORGANIZATION_SESSION_POLICY).success).toBe(
      true,
    );
    for (const invalid of [
      { attachments: "on", toolFamilies: { mode: "deny", families: [] } },
      { attachments: "enabled", toolFamilies: { mode: "block", families: [] } },
      { attachments: "enabled", toolFamilies: { mode: "deny", families: ["mcp"] } },
      { attachments: "enabled", toolFamilies: { mode: "deny", families: ["shell", "shell"] } },
      { attachments: "enabled", toolFamilies: { mode: "deny", families: [] }, extra: true },
    ]) {
      expect(OrganizationSessionPolicy.safeParse(invalid).success).toBe(false);
    }
    expect(
      HostPutOrganizationSessionPolicyRequest.safeParse({
        actingExternalUser: { source: "test-host:user", externalId: "staff-1" },
        command: {
          policy: STOCK_ORGANIZATION_SESSION_POLICY,
          operationId: crypto.randomUUID(),
          expectedRevision: 1,
        },
      }).success,
    ).toBe(true);
    // A command must name the revision it replaces.
    expect(
      HostPutOrganizationSessionPolicyRequest.safeParse({
        actingExternalUser: { source: "test-host:user", externalId: "staff-1" },
        command: { policy: STOCK_ORGANIZATION_SESSION_POLICY, operationId: crypto.randomUUID() },
      }).success,
    ).toBe(false);
  });

  test("every first-party browser tool is the browser or computer-use family", () => {
    for (const name of FIRST_PARTY_MCP_TOOL_NAMES) {
      if (FIRST_PARTY_MCP_TOOL_CAPABILITIES[name] !== "browser") continue;
      const family = sessionToolFamilyOf(name);
      expect(family === "browser" || family === "computerUse").toBe(true);
    }
    expect(sessionToolFamilyOf("browser_open")).toBe("browser");
    expect(sessionToolFamilyOf("interaction_discover")).toBe("browser");
    expect(sessionToolFamilyOf("computer_act")).toBe("computerUse");
    // The in-process interaction tools' model names.
    expect(sessionToolFamilyOf("interaction__browser_open")).toBe("browser");
    expect(sessionToolFamilyOf("interaction__computer_act")).toBe("computerUse");
    expect(sessionToolFamilyOf("interaction__knowledge_search")).toBeNull();
    expect(sessionToolFamilyOf("excel_run")).toBe("computerUse");
    expect(sessionToolFamilyOf("connected_machine_enable_screen_control")).toBe("computerUse");
    for (const tool of CUA_DESKTOP_TOOLS)
      expect(sessionToolFamilyOf(`interaction__cua_${tool.name}`)).toBe("computerUse");
  });

  test("shell covers sandbox commands, file editing and compute routing", () => {
    for (const [name, owner] of Object.entries(AGENT_FUNCTION_TOOL_CAPABILITIES)) {
      if (owner === "sandbox") expect(sessionToolFamilyOf(name)).toBe("shell");
    }
    for (const name of [
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
      "command_read",
      "command_wait",
      "sandboxes_list",
      "sandbox_attach",
      "sandbox_swap",
      "sandbox_provision",
      "run_on",
      "connected_machine_enroll_token",
      "connected_machine_remove",
    ]) {
      expect(sessionToolFamilyOf(name)).toBe("shell");
    }
  });

  test("business and runtime tools belong to no family", () => {
    for (const name of [
      "knowledge_search",
      "set_session_title",
      "wait_for_input",
      "skill_read",
      "web_search",
      "request_human_input",
      "artifacts_list",
      "sandbox_file_publish",
      "acme__lookup",
    ]) {
      expect(sessionToolFamilyOf(name)).toBeNull();
    }
  });

  test("the gate refuses only the denied families' tools", () => {
    const stock = sessionToolFamilyGate(null);
    expect(stock.deniedFamilies.size).toBe(0);
    expect(stock.allowsTool("exec_command")).toBe(true);
    const governed = sessionToolFamilyGate(GOVERNED_ORGANIZATION_SESSION_POLICY);
    expect(governed.denies("codemode")).toBe(true);
    expect(governed.allowsTool("exec_command")).toBe(false);
    expect(governed.allowsTool("browser_open")).toBe(false);
    expect(governed.allowsTool("computer_act")).toBe(false);
    expect(governed.allowsTool("knowledge_search")).toBe(true);
    const browserOnly = sessionToolFamilyGate({
      attachments: "enabled",
      toolFamilies: { mode: "allow", families: ["browser"] },
    });
    expect(browserOnly.allowsTool("browser_open")).toBe(true);
    expect(browserOnly.allowsTool("computer_act")).toBe(false);
    expect(browserOnly.allowsTool("exec_command")).toBe(false);
  });
});
