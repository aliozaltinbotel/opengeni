// Native entries a host extension moves into one of its settings groups: they
// leave their native place (the primary rail, or the workspace section for
// Insights), render first in that group of the settings rail under the
// override's label, and Insights keeps its workspace:admin gate there. The
// stock rail is unchanged (nav-stock.test.tsx).
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { HostExtension } from "@opengeni/react/app/host-extension";
import type { AppContextValue } from "@opengeni/react/app/app-context";

import { hostExtensionFixture } from "../../test/fixtures/host-extension-fixture";
import {
  WORKSPACE_ID,
  appContext,
  describeSections,
  indicators,
  installNavMocks,
  installViewportMatchMedia,
  rail,
  renderInRouter,
  setViewportHeight,
  settingsRailSections,
} from "../../test/fixtures/host-extension-nav-harness";

const extension: HostExtension = {
  ...hostExtensionFixture,
  settingsGroups: [...(hostExtensionFixture.settingsGroups ?? []), { id: "setup", label: "Setup" }],
  navOverrides: [
    { id: "insights", label: "Agent usage", settingsGroup: "setup" },
    { id: "state", label: "Know-how", settingsGroup: "setup" },
  ],
};
void mock.module("@opengeni/web-host-extension", () => ({ default: extension }));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await installNavMocks();
await import("./startup");
const { PrimaryNavExtras } = await import("@/components/rail/primary-nav");
const { useSettingsRail, workspacePageLabel } = await import("@/components/settings/settings-rail");

let restoreMatchMedia: () => void = () => undefined;
beforeAll(() => {
  restoreMatchMedia = installViewportMatchMedia();
});
afterAll(() => {
  restoreMatchMedia();
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  setViewportHeight(900);
  rail.collapsed = false;
  indicators.pendingKnowledge = false;
  indicators.scheduleAttention = false;
});

const INSIGHTS = "/workspaces/$workspaceId/insights";
const KNOWLEDGE = "/workspaces/$workspaceId/state";

describe("native entries in a host settings group", () => {
  test("the group lists the moved entries first, relabelled; their native places drop them", async () => {
    const sections = describeSections(await settingsRailSections(useSettingsRail));
    const setup = sections.find((section) => section.id === "extension-group:setup");
    expect(setup).toEqual({
      id: "extension-group:setup",
      label: "Setup",
      meta: null,
      groups: [
        [
          {
            id: `workspace:${KNOWLEDGE}`,
            label: "Know-how",
            to: KNOWLEDGE,
            params: { workspaceId: WORKSPACE_ID },
            search: null,
          },
          {
            id: `workspace:${INSIGHTS}`,
            label: "Agent usage",
            to: INSIGHTS,
            params: { workspaceId: WORKSPACE_ID },
            search: null,
          },
        ],
      ],
    });
    const workspace = sections.find((section) => section.id === "workspace")!;
    expect(workspace.groups.flat().map((item) => item.to)).not.toContain(INSIGHTS);
    // The host's own group is unchanged.
    expect(sections.map((section) => section.id)).toContain("extension-group:property");

    const view = await renderInRouter(() => <PrimaryNavExtras />);
    const labels = Array.from(view.container.querySelectorAll("a")).map(
      (link) => link.getAttribute("aria-label") ?? link.textContent ?? "",
    );
    await view.done();
    expect(labels.some((label) => label.includes("Knowledge") || label.includes("Know-how"))).toBe(
      false,
    );
    expect(labels.some((label) => label.includes("Capabilities"))).toBe(true);
  });

  test("Insights keeps its workspace:admin gate inside the host group", async () => {
    const member = {
      ...appContext,
      accessContext: {
        ...appContext.accessContext,
        workspaceGrants: [
          {
            workspaceId: WORKSPACE_ID,
            accountId: "",
            subjectId: "user:ada",
            permissions: ["workspace:read"],
          },
        ],
      },
    } as unknown as AppContextValue;
    const sections = describeSections(await settingsRailSections(useSettingsRail, member));
    const setup = sections.find((section) => section.id === "extension-group:setup")!;
    expect(setup.groups.flat().map((item) => item.label)).toEqual(["Know-how"]);
  });

  test("the Insights page is named by the override's label", () => {
    expect(workspacePageLabel({ kind: "page", target: INSIGHTS } as never)).toBe("Agent usage");
  });
});
