// A configured host extension adds its nav items to the primary nav and the
// settings rail, and a native destination it hides is unreachable through
// every link source and by direct URL. The fixture extension stands in for a
// host product; it also hides Automations and Secrets.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRoute,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { HostExtension } from "@opengeni/react/app/host-extension";

import { hostExtensionFixture } from "../../test/fixtures/host-extension-fixture";
import {
  WORKSPACE_ID,
  describeSections,
  indicators,
  installNavMocks,
  installViewportMatchMedia,
  rail,
  renderInRouter,
  setViewportHeight,
  settingsRailSections,
} from "./nav-harness";

const extension: HostExtension = {
  ...hostExtensionFixture,
  hiddenNativeDestinations: ["automations", "secrets"],
};
void mock.module("@opengeni/web-host-extension", () => ({ default: extension }));

const warmed: { preload?: (() => unknown) | undefined }[][] = [];
const desktop = await import("@opengeni/react/app/lib/desktop");
void mock.module("@opengeni/react/app/lib/desktop", () => ({
  ...desktop,
  warmDesktopPages: (pages: readonly { preload?: (() => unknown) | undefined }[]) => {
    warmed.push([...pages]);
  },
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await installNavMocks();
const { PrimaryNavExtras, WorkspaceShortcutLinks } = await import("@/components/rail/primary-nav");
const { useSettingsRail } = await import("@/components/settings/settings-rail");
const { searchSettings, settingsSearchEntries } =
  await import("@/components/settings/settings-search");
const { NotFoundPanel } = await import("@/components/route-error");
const { visibleNativeRoutes } = await import("./hidden-destinations");
const app = await import("../App");
await import("@/app-host");
const { useAppHost } = await import("@opengeni/react/app/lib/app-host");

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

function links(container: HTMLElement): { label: string; href: string | null }[] {
  return Array.from(container.querySelectorAll("a")).map((link) => ({
    label: link.getAttribute("aria-label") ?? link.textContent ?? "",
    href: link.getAttribute("href"),
  }));
}

function hrefs(container: HTMLElement): (string | null)[] {
  return links(container).map((link) => link.href);
}

describe("host extension primary nav", () => {
  test("lists the extension's primary items after the native shortcuts, without hidden ones", async () => {
    const view = await renderInRouter(() => <PrimaryNavExtras />);
    try {
      expect(hrefs(view.container)).toEqual([
        "/workspaces/w1/inbox",
        "/workspaces/w1/plugins",
        "/workspaces/w1/state",
        "/workspaces/w1/meetings",
        "/workspaces/w1/artifacts",
        "/workspaces/w1/pms",
      ]);
      const today = view.container.querySelector('a[href="/workspaces/w1/pms"]');
      expect(today?.textContent).toBe("Today");
      expect(today?.getAttribute("title")).toBe("What needs doing today");
      expect(today?.querySelector('[data-testid="fixture-icon"]')).not.toBeNull();
    } finally {
      await view.done();
    }
  });

  test("the collapsed rail shows the extension item by its label", async () => {
    rail.collapsed = true;
    const view = await renderInRouter(() => <WorkspaceShortcutLinks />);
    try {
      expect(links(view.container)).toEqual([
        { label: "Capabilities", href: "/workspaces/w1/plugins" },
        { label: "Knowledge", href: "/workspaces/w1/state" },
        { label: "Meetings", href: "/workspaces/w1/meetings" },
        { label: "Artifacts", href: "/workspaces/w1/artifacts" },
        { label: "Today", href: "/workspaces/w1/pms" },
      ]);
    } finally {
      await view.done();
    }
  });

  test("a short window folds the shortcuts without the hidden Automations, and does not throw", async () => {
    setViewportHeight(600);
    indicators.pendingKnowledge = true;
    // An automation needing attention would surface Automations; it is hidden.
    indicators.scheduleAttention = true;
    const view = await renderInRouter(() => <PrimaryNavExtras />);
    try {
      expect(hrefs(view.container)).toEqual([
        "/workspaces/w1/inbox",
        "/workspaces/w1/state?review=true",
      ]);
      expect(view.container.textContent).toContain("More");
    } finally {
      await view.done();
    }
  });

  test("the folded More names an open extension page as the current section", async () => {
    setViewportHeight(600);
    const view = await renderInRouter(() => <PrimaryNavExtras />, "/workspaces/w1/pms");
    try {
      const more = Array.from(view.container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "More",
      );
      expect(more?.getAttribute("aria-label")).toBe("More, current section Today");
    } finally {
      await view.done();
    }
  });
});

describe("host extension settings rail and search", () => {
  test("the rail has no Secrets and one section per settings group after Workspace", async () => {
    const sections = describeSections(await settingsRailSections(useSettingsRail));
    expect(sections.map((section) => section.id)).toEqual([
      "workspace",
      "extension-group:property",
      "account",
    ]);
    const items = sections.flatMap((section) => section.groups.flat());
    expect(items.map((item) => item.label)).not.toContain("Secrets");
    expect(items.map((item) => item.label)).toContain("Machines");
    expect(sections[1]).toEqual({
      id: "extension-group:property",
      label: "Property",
      meta: null,
      groups: [
        [
          {
            id: "extension:property-preferences",
            label: "Property preferences",
            to: "/workspaces/$workspaceId/pms-settings",
            params: { workspaceId: WORKSPACE_ID },
            search: null,
          },
        ],
      ],
    });
  });

  test("search offers the extension's settings page and nothing of Secrets", async () => {
    const entries = settingsSearchEntries(await settingsRailSections(useSettingsRail));
    expect(entries.filter((entry) => entry.id.includes("secrets"))).toEqual([]);
    expect(searchSettings(entries, "vault")).toEqual([]);
    const found = searchSettings(entries, "property");
    expect(found.map((entry) => [entry.id, entry.location])).toEqual([
      ["extension:property-preferences", "Property"],
    ]);
  });
});

describe("hidden native destinations by direct URL", () => {
  function workspaceChildren(): readonly AnyRoute[] {
    const workspace = (app.routeTree.children as readonly AnyRoute[]).find(
      (route) => (route.options as { path?: string }).path === "workspaces/$workspaceId",
    );
    return (workspace?.children ?? []) as readonly AnyRoute[];
  }

  /** Whether a page under the workspace matches; otherwise only the workspace route does. */
  function matches(pathname: string): boolean {
    const router = createRouter({ routeTree: app.routeTree });
    const [, , foundRoute] = router.getMatchedRoutes(pathname);
    return foundRoute !== undefined && foundRoute.id !== "/workspaces/$workspaceId";
  }

  test("the workspace route has no route for a hidden destination or its legacy URLs", () => {
    const firstSegments = workspaceChildren().map(
      (route) => ((route.options as { path?: string }).path ?? "").split("/")[0],
    );
    for (const hidden of ["automations", "schedules", "secrets", "variable-sets", "environments"]) {
      expect(firstSegments).not.toContain(hidden);
    }
    expect(firstSegments).toContain("plugins");
    expect(firstSegments).toContain("pms");
  });

  test("a hidden destination's URL matches no route, like any unknown URL", () => {
    for (const path of [
      "automations",
      "automations/new",
      "automations/a1/edit",
      "schedules",
      "secrets",
      "secrets/v1/i1",
      "variable-sets",
    ]) {
      expect(matches(`/workspaces/w1/${path}`)).toBe(false);
    }
    expect(matches("/workspaces/w1/no-such-page")).toBe(false);
    for (const path of ["plugins", "machines", "pms", "sessions"]) {
      expect(matches(`/workspaces/w1/${path}`)).toBe(true);
    }
  });

  test("an unmatched workspace URL renders the console's not-found page", async () => {
    const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFoundPanel });
    const workspaceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "workspaces/$workspaceId",
      component: () => (
        <div data-testid="shell">
          <Outlet />
        </div>
      ),
    });
    const page = (path: string) =>
      createRoute({ getParentRoute: () => workspaceRoute, path, component: () => <p>{path}</p> });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        workspaceRoute.addChildren(
          visibleNativeRoutes([page("sessions"), page("automations")], ["automations"]),
        ),
      ]),
      history: createMemoryHistory({ initialEntries: ["/workspaces/w1/automations"] }),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    try {
      expect(container.textContent).toContain("Page not found");
      expect(container.querySelector('[data-testid="shell"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("other link sources", () => {
  test("the desktop app does not warm a hidden destination's page", () => {
    // Sessions, sessions index, inbox, capabilities and artifacts; not automations.
    expect(warmed.map((pages) => pages.length)).toEqual([5]);
  });

  test("the shared session UI reads the hidden set from the page's app host", () => {
    let hidden: unknown;
    function Capture() {
      hidden = useAppHost().hiddenNativeDestinations;
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Capture />));
    act(() => root.unmount());
    expect(hidden).toEqual(["automations", "secrets"]);
  });
});
