import { describe, expect, test } from "bun:test";

import {
  workspaceManagementLocation,
  workspaceSwitchTarget,
} from "./workspace-management-location";

describe("workspaceManagementLocation", () => {
  test("opens an extension settings page in settings mode", () => {
    expect(
      workspaceManagementLocation("/workspaces/w1/pms-settings", "w1", undefined, ["pms-settings"]),
    ).toEqual({ kind: "extension", path: "pms-settings" });
  });

  test("matches an extension path segment by segment, with params", () => {
    const paths = ["pms-settings", "pms-settings/rules/$ruleId"];
    expect(
      workspaceManagementLocation(
        "/workspaces/w1/pms-settings/rules/r%201",
        "w1",
        undefined,
        paths,
      ),
    ).toEqual({ kind: "extension", path: "pms-settings/rules/$ruleId" });
    for (const pathname of [
      "/workspaces/w1/pms-settings-archive",
      "/workspaces/w1/pms-settings/other",
      "/workspaces/w1/pms-settings/rules/",
      "/workspaces/w1/pms-settings/rules/r1/extra",
      "/workspaces/w2/pms-settings",
    ]) {
      expect(workspaceManagementLocation(pathname, "w1", undefined, paths)).toBeNull();
    }
  });

  test("leaves rail pages and the stock locations alone", () => {
    expect(
      workspaceManagementLocation("/workspaces/w1/pms", "w1", undefined, ["pms-settings"]),
    ).toBe(null);
    expect(workspaceManagementLocation("/workspaces/w1/pms-settings", "w1")).toBeNull();
    expect(workspaceManagementLocation("/workspaces/w1/settings", "w1", "access", [])).toEqual({
      kind: "settings",
      section: "access",
    });
    expect(workspaceManagementLocation("/workspaces/w1/rigs/r1", "w1")).toEqual({
      kind: "page",
      target: "/workspaces/$workspaceId/rigs",
    });
  });
});

describe("workspaceSwitchTarget", () => {
  const params = { workspaceId: "w2" };

  test("keeps an extension settings page, or opens settings for one addressed by its ids", () => {
    expect(workspaceSwitchTarget({ kind: "extension", path: "pms-settings" }, "w2")).toEqual({
      to: "/workspaces/$workspaceId/pms-settings" as never,
      params,
    });
    expect(
      workspaceSwitchTarget({ kind: "extension", path: "pms-settings/rules/$ruleId" }, "w2"),
    ).toEqual({ to: "/workspaces/$workspaceId/settings", params, search: {} });
  });

  test("keeps the stock destinations", () => {
    expect(workspaceSwitchTarget(null, "w2")).toEqual({
      to: "/workspaces/$workspaceId/sessions",
      params,
    });
    expect(workspaceSwitchTarget({ kind: "settings", section: "access" }, "w2")).toEqual({
      to: "/workspaces/$workspaceId/settings",
      params,
      search: { section: "access" },
    });
    expect(workspaceSwitchTarget({ kind: "settings", section: null }, "w2")).toEqual({
      to: "/workspaces/$workspaceId/settings",
      params,
      search: {},
    });
    expect(
      workspaceSwitchTarget({ kind: "page", target: "/workspaces/$workspaceId/rigs" }, "w2"),
    ).toEqual({ to: "/workspaces/$workspaceId/rigs", params });
    expect(workspaceSwitchTarget({ kind: "organization", section: null }, "w2")).toEqual({
      to: "/workspaces/$workspaceId/organization",
      params,
      search: {},
    });
  });
});
