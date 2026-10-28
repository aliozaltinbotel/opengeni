// The workspace landing: a host extension's `landing` is where both the root
// redirect and `workspaces/$workspaceId/` open; stock opens sessions.
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
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { workspaceLanding } from "@opengeni/react/app/host-extension";

import { LandingRedirect, WorkspaceLandingRedirect } from "./landing";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

/** Opens `/workspaces/w1/` whose index renders `redirect`, and returns where the router settles. */
async function landedAt(redirect: (workspaceId: string) => ReactNode): Promise<string> {
  const rootRoute = createRootRoute({ component: Outlet });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "workspaces/$workspaceId",
    component: Outlet,
  });
  const indexRoute = createRoute({
    getParentRoute: () => workspaceRoute,
    path: "/",
    component: () => redirect(workspaceRoute.useParams().workspaceId),
  });
  const leaf = (path: string) =>
    createRoute({ getParentRoute: () => workspaceRoute, path, component: () => <p>{path}</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      workspaceRoute.addChildren([indexRoute, leaf("sessions"), leaf("operations/today")]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/workspaces/w1/"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  for (let attempt = 0; attempt < 50 && !container.querySelector("p"); attempt += 1)
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  const pathname = router.state.location.pathname;
  act(() => root.unmount());
  container.remove();
  return pathname;
}

describe("workspace landing", () => {
  test("the stock console (no extension installed) opens the workspace's sessions", async () => {
    expect(
      await landedAt((workspaceId) => <WorkspaceLandingRedirect workspaceId={workspaceId} />),
    ).toBe("/workspaces/w1/sessions");
  });

  test("an extension's landing opens its own page", async () => {
    const landing = workspaceLanding({ landing: "operations/today" });
    expect(
      await landedAt((workspaceId) => (
        <LandingRedirect workspaceId={workspaceId} landing={landing} />
      )),
    ).toBe("/workspaces/w1/operations/today");
  });

  test("both the root redirect and the workspace index open the landing", async () => {
    const source = await Bun.file(`${import.meta.dir}/../App.tsx`).text();
    const body = (name: string) =>
      source.match(new RegExp(`function ${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    for (const name of ["RootIndexRoute", "WorkspaceIndexRedirect"]) {
      expect(body(name)).toContain("<WorkspaceLandingRedirect workspaceId={workspaceId} />");
      expect(body(name)).not.toContain('to="/workspaces/$workspaceId/sessions"');
    }
  });
});
