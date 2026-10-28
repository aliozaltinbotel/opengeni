// Shared by the host extension nav tests: renders the primary nav and reads
// the settings rail inside a real memory router, with the rail and its two
// attention indicators under the test's control. Call `installNavMocks` after
// any extension mock and before importing the nav or the rail.
import { mock } from "bun:test";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, isValidElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import type { SettingsRailSection } from "@/components/settings/settings-sidebar";
import type { useSettingsRail } from "@/components/settings/settings-rail";

export const WORKSPACE_ID = "w1";

/** The rail the nav reads, changed by each test. */
export const rail = {
  workspaceId: WORKSPACE_ID,
  collapsed: false,
  isMobile: false,
  setDrawerOpen: (_open: boolean) => undefined,
};

/** What the knowledge-review and schedule-attention indicators report. */
export const indicators = { pendingKnowledge: false, scheduleAttention: false };

export async function installNavMocks(): Promise<void> {
  const railContext = await import("@opengeni/react/app/components/rail/rail-context");
  void mock.module("@opengeni/react/app/components/rail/rail-context", () => ({
    ...railContext,
    useRail: () => rail,
  }));
  const knowledge = await import("@/components/rail/use-knowledge-review-indicator");
  void mock.module("@/components/rail/use-knowledge-review-indicator", () => ({
    ...knowledge,
    useKnowledgeReviewIndicator: () => indicators.pendingKnowledge,
  }));
  const schedules = await import("@/components/rail/use-scheduled-task-attention");
  void mock.module("@/components/rail/use-scheduled-task-attention", () => ({
    ...schedules,
    useScheduledTaskAttentionIndicator: () => indicators.scheduleAttention,
  }));
}

/** A tall or short window; the nav folds its shortcuts under More below 720px. */
export function setViewportHeight(height: number): void {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

export function installViewportMatchMedia(): () => void {
  const original = window.matchMedia;
  window.matchMedia = (query) => {
    const media = original.call(window, query);
    Object.defineProperty(media, "matches", { get: () => window.innerHeight < 720 });
    return media;
  };
  return () => {
    window.matchMedia = original;
  };
}

const appContext = {
  workspaces: [
    {
      id: WORKSPACE_ID,
      accountId: "",
      kind: "shared",
      name: "Operations",
    },
  ],
  accessContext: {
    mode: "managed",
    subjectId: "user:ada",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: WORKSPACE_ID,
        accountId: "",
        subjectId: "user:ada",
        permissions: ["workspace:admin"],
      },
    ],
  },
  clientConfig: { auth: { mode: "managedSession" }, productAccessMode: "managed" },
  managedSelfContext: null,
  // The Inbox entry loads its count; an empty inbox keeps the nav still.
  client: { listInbox: async () => ({ items: [] }) },
  resetSessionView: () => undefined,
} as unknown as AppContextValue;

export const ORGANIZATION_ID = "o1";

/**
 * The same person as the owner of the workspace's organization, so the rail
 * also lists the organization's settings pages.
 */
export const organizationOwnerContext = {
  ...appContext,
  workspaces: [{ ...appContext.workspaces[0]!, accountId: ORGANIZATION_ID }],
  accessContext: {
    ...appContext.accessContext,
    accountGrants: [
      {
        accountId: ORGANIZATION_ID,
        subjectId: "user:ada",
        role: "owner",
        permissions: ["account:admin", "billing:manage", "members:manage", "api_keys:manage"],
        metadata: { accountName: "Operations Group" },
      },
    ],
    workspaceGrants: [
      {
        workspaceId: WORKSPACE_ID,
        accountId: ORGANIZATION_ID,
        subjectId: "user:ada",
        permissions: ["workspace:admin"],
      },
    ],
  },
} as unknown as AppContextValue;

/** Renders `node` in a memory router at `url` and returns its HTML; unmounts after. */
export async function renderInRouter(
  node: () => ReactNode,
  url = `/workspaces/${WORKSPACE_ID}/sessions`,
  context: AppContextValue = appContext,
): Promise<{ container: HTMLElement; done: () => Promise<void> }> {
  const rootRoute = createRootRoute({
    component: () => <AppContext.Provider value={context}>{node()}</AppContext.Provider>,
    notFoundComponent: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await router.load();
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  return {
    container,
    done: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

type SettingsRailHook = typeof useSettingsRail;

/** The settings rail's sections for workspace w1's General page. */
export async function settingsRailSections(
  useRail: SettingsRailHook,
  context: AppContextValue = appContext,
): Promise<SettingsRailSection[]> {
  let sections: SettingsRailSection[] = [];
  function Capture() {
    sections = useRail({
      workspaceId: WORKSPACE_ID,
      location: { kind: "settings", section: "general" },
    }).sections;
    return null;
  }
  const view = await renderInRouter(() => <Capture />, undefined, context);
  await view.done();
  return sections;
}

/** A rail's sections as plain data: ids, labels and where each item links. */
export function describeSections(sections: readonly SettingsRailSection[]) {
  return sections.map((section) => ({
    id: section.id,
    label: section.label,
    meta: section.meta ?? null,
    groups: section.groups.map((group) =>
      group.items.map((item) => {
        const props = isValidElement(item.link)
          ? (item.link.props as { to?: unknown; params?: unknown; search?: unknown })
          : {};
        return {
          id: item.id,
          label: item.label,
          to: props.to ?? null,
          params: props.params ?? null,
          search: props.search ?? null,
        };
      }),
    ),
  }));
}
