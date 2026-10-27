import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

import { hostExtensionFixture } from "../../test/fixtures/host-extension-fixture";
import { validateHostExtension } from "./registry";
import { buildHostExtensionWorkspaceRoutes } from "./routes";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const FIXTURE_PAGE = '[data-testid="fixture-page"]';

/** Renders the fixture extension's routes under a bare workspace route at `url`. */
async function renderFixtureAt(url: string): Promise<{ container: HTMLElement; done: () => void }> {
  const rootRoute = createRootRoute({ component: Outlet });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "workspaces/$workspaceId",
    component: Outlet,
  });
  const extension = validateHostExtension(hostExtensionFixture);
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      workspaceRoute.addChildren(
        buildHostExtensionWorkspaceRoutes(workspaceRoute, extension.routes),
      ),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await router.load();
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  // Let the lazy page chunk resolve and commit.
  for (let attempt = 0; attempt < 50 && !container.querySelector(FIXTURE_PAGE); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return {
    container,
    done: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function pathOf(route: AnyRoute): string | undefined {
  return (route.options as { path?: string }).path;
}

function workspaceChildren(tree: AnyRoute): readonly AnyRoute[] {
  const children = (tree.children ?? []) as readonly AnyRoute[];
  const workspace = children.find((route) => pathOf(route) === "workspaces/$workspaceId");
  expect(workspace).toBeDefined();
  return (workspace?.children ?? []) as readonly AnyRoute[];
}

describe("host extension workspace routes", () => {
  test("renders an extension page with the workspace id from the URL", async () => {
    const view = await renderFixtureAt("/workspaces/w1/pms");
    try {
      const page = view.container.querySelector(FIXTURE_PAGE);
      expect(page?.textContent).toBe("Fixture page for w1");
      // A rail page gets the console's default scroller.
      expect(page?.closest('[data-slot="content-page"]')).not.toBeNull();
    } finally {
      view.done();
    }
  });

  test("renders a settings page bare, inside the settings shell's own scroller", async () => {
    const view = await renderFixtureAt("/workspaces/w1/pms-settings");
    try {
      const page = view.container.querySelector(FIXTURE_PAGE);
      expect(page?.textContent).toBe("Fixture page for w1");
      expect(page?.closest('[data-slot="content-page"]')).toBeNull();
    } finally {
      view.done();
    }
  });

  test("builds one route per extension route, at its path, and none for the stub", () => {
    const parent = createRoute({ getParentRoute: () => createRootRoute(), path: "w/$workspaceId" });
    const extension = validateHostExtension(hostExtensionFixture);
    expect(buildHostExtensionWorkspaceRoutes(parent, extension.routes).map(pathOf)).toEqual([
      "pms",
      "pms-settings",
    ]);
    expect(buildHostExtensionWorkspaceRoutes(parent, undefined)).toEqual([]);
  });

  test("with the stub, the workspace route has exactly the stock children", async () => {
    const app = await import("../App");
    const source = await Bun.file(`${import.meta.dir}/../App.tsx`).text();
    const block =
      source.match(
        /workspaceRoute\.addChildren\(\s*visibleNativeRoutes\(\s*\[([\s\S]*?)\n {6}\],/,
      )?.[1] ?? "";
    // The direct native children sit at eight spaces; nested children deeper.
    const nativeCount = Array.from(
      block.matchAll(/^ {8}(workspace[A-Z]\w+Route)(?:,|\.addChildren\(\[)$/gm),
    ).length;
    expect(nativeCount).toBeGreaterThan(40);
    expect(app.hostExtensionWorkspaceRoutes).toEqual([]);
    expect(workspaceChildren(app.routeTree)).toHaveLength(nativeCount);
  });
});
