import { describe, expect, test } from "bun:test";

import {
  PRIMARY_WORKSPACE_ITEMS,
  WORKSPACE_CONFIG_GROUPS,
  isConfigItemActive,
  isWorkspaceConfigPath,
  visibleNativeItems,
} from "./workspace-nav-data";

const workspaceNavSource = await Bun.file(`${import.meta.dir}/workspace-nav.tsx`).text();
const workspaceRouteSource = await Bun.file(`${import.meta.dir}/../../routes/workspace.tsx`).text();

describe("workspace rail destinations", () => {
  test("labels the settings entry without changing its destination", () => {
    expect(workspaceNavSource).toContain('aria-label="Settings"');
    expect(workspaceNavSource).toContain(
      '<TooltipContent side={rail.collapsed ? "right" : "top"}>Settings</TooltipContent>',
    );
    expect(workspaceNavSource).toContain('<span className="min-w-0 truncate">Settings</span>');
    expect(workspaceNavSource).toContain('to="/workspaces/$workspaceId/settings"');
    expect(workspaceNavSource).toContain('search={{ section: "general" }}');
  });

  test("keeps primary product destinations out of workspace administration", () => {
    const primaryTargets = PRIMARY_WORKSPACE_ITEMS.map((item) => item.to);
    const settingsTargets = WORKSPACE_CONFIG_GROUPS.flatMap((group) => group.items).map(
      (item) => item.to,
    );

    expect(primaryTargets).toEqual([
      "/workspaces/$workspaceId/plugins",
      "/workspaces/$workspaceId/state",
      "/workspaces/$workspaceId/automations",
      "/workspaces/$workspaceId/meetings",
      "/workspaces/$workspaceId/artifacts",
    ]);
    expect(PRIMARY_WORKSPACE_ITEMS.map((item) => item.label)).not.toContain("Documents");
    expect(settingsTargets.filter((target) => primaryTargets.includes(target))).toEqual([]);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/automations", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/artifacts", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/documents", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/state", "ws-1")).toBe(false);
    expect(isWorkspaceConfigPath("/workspaces/ws-1/settings", "ws-1")).toBe(true);
    expect(
      isConfigItemActive(
        "/workspaces/ws-1/artifacts/site-1",
        "ws-1",
        "/workspaces/$workspaceId/artifacts",
      ),
    ).toBe(true);
  });

  test("settings mode swaps the main rail for the settings rail", () => {
    // The footer Settings entry is the way in; the management shell replaces RailShell.
    // Workspace and organization settings share that one management shell.
    const shell = workspaceRouteSource.slice(
      workspaceRouteSource.indexOf("{managementLocation ? ("),
    );
    const management = shell.indexOf("<WorkspaceManagementShell");
    expect(management).toBeGreaterThan(0);
    expect(management).toBeLessThan(shell.indexOf("<RailShell>"));
    expect(shell.slice(management, shell.indexOf("</WorkspaceManagementShell>"))).not.toContain(
      "<RailShell>",
    );
  });
});

describe("visible native destinations", () => {
  test("nothing hidden keeps every item, in order", () => {
    expect(visibleNativeItems(PRIMARY_WORKSPACE_ITEMS, [])).toEqual(PRIMARY_WORKSPACE_ITEMS);
  });

  test("drops an item whose segment after $workspaceId/ is hidden", () => {
    expect(
      visibleNativeItems(PRIMARY_WORKSPACE_ITEMS, ["automations", "secrets"]).map(
        (item) => item.to,
      ),
    ).toEqual([
      "/workspaces/$workspaceId/plugins",
      "/workspaces/$workspaceId/state",
      "/workspaces/$workspaceId/meetings",
      "/workspaces/$workspaceId/artifacts",
    ]);
  });

  test("matches the whole first segment only", () => {
    const items = [
      { to: "/workspaces/$workspaceId/secrets" },
      { to: "/workspaces/$workspaceId/secrets/$vaultId" },
      { to: "/workspaces/$workspaceId/secrets-archive" },
      { to: "/workspaces/$workspaceId/settings" },
    ];
    expect(visibleNativeItems(items, ["secrets"]).map((item) => item.to)).toEqual([
      "/workspaces/$workspaceId/secrets-archive",
      "/workspaces/$workspaceId/settings",
    ]);
  });
});
