import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";

import "@/navigation-host";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import {
  RailProvider,
  useRail,
  type RailContextValue,
} from "@opengeni/react/app/components/rail/rail-context";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

// RailProvider reads only these; any other read fails loudly.
const appContext = new Proxy(
  {
    resetSessionView: () => undefined,
    accessContext: { subjectId: "subject-1" },
    workspaces: [],
  } as unknown as AppContextValue,
  {
    get(target, key) {
      if (key in target) return target[key as keyof AppContextValue];
      throw new Error(`The workspace switch test's app context has no ${String(key)}`);
    },
  },
);

/**
 * Switches from `url` to workspace w2 through the rail's `openWorkspace`, the
 * function the ⌘K menu and workspace actions call, and returns where it lands.
 */
async function switchWorkspaceFrom(
  url: string,
  extensionSettingsPaths?: readonly string[],
): Promise<string> {
  let rail: RailContextValue | null = null;
  function CaptureRail() {
    rail = useRail();
    return null;
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "workspaces/$workspaceId",
    component: function Workspace() {
      const { workspaceId } = workspaceRoute.useParams();
      return (
        <RailProvider
          workspaceId={workspaceId}
          {...(extensionSettingsPaths ? { extensionSettingsPaths } : {})}
        >
          <CaptureRail />
          <Outlet />
        </RailProvider>
      );
    },
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => workspaceRoute, path, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      workspaceRoute.addChildren([
        page("sessions"),
        page("settings"),
        page("pms-settings"),
        page("pms-settings/rules/$ruleId"),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await router.load();
    await act(async () => {
      root.render(
        <AppContext.Provider value={appContext}>
          <RouterProvider router={router} />
        </AppContext.Provider>,
      );
    });
    expect(rail).not.toBeNull();
    await act(async () => {
      (rail as RailContextValue | null)?.openWorkspace("w2");
    });
    // Let the navigation commit.
    for (
      let attempt = 0;
      attempt < 50 && !router.state.location.pathname.startsWith("/workspaces/w2/");
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    return router.state.location.pathname;
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

describe("switching workspace from the command menu", () => {
  test("keeps an extension settings page in the next workspace", async () => {
    expect(await switchWorkspaceFrom("/workspaces/w1/pms-settings", ["pms-settings"])).toBe(
      "/workspaces/w2/pms-settings",
    );
  });

  test("opens settings for an extension page addressed by its own ids", async () => {
    expect(
      await switchWorkspaceFrom("/workspaces/w1/pms-settings/rules/r1", [
        "pms-settings",
        "pms-settings/rules/$ruleId",
      ]),
    ).toBe("/workspaces/w2/settings");
  });

  test("stock: without extension paths, the page lands on the next workspace's sessions", async () => {
    expect(await switchWorkspaceFrom("/workspaces/w1/pms-settings")).toBe(
      "/workspaces/w2/sessions",
    );
    expect(await switchWorkspaceFrom("/workspaces/w1/settings?section=access")).toBe(
      "/workspaces/w2/settings",
    );
  });
});
