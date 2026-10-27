// Without a host extension the console's shells are stock: the Opengeni brand,
// no providers around the shells, every workspace offered, nothing awaited.
import { afterAll, describe, expect, mock, test } from "bun:test";
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
import type { AppContextValue } from "@opengeni/react/app/app-context";

const railShell = await import("@/components/rail/rail-shell");
void mock.module("@/components/rail/rail-shell", () => ({
  ...railShell,
  RailShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="rail-shell">{children}</div>
  ),
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await import("@/app-host");
const { AppContext } = await import("@opengeni/react/app/app-context");
const { RailProvider } = await import("@opengeni/react/app/components/rail/rail-context");
const { RailHeader } = await import("@opengeni/react/app/components/rail/rail-sections");
const { TooltipProvider } = await import("@opengeni/react/ui/tooltip");
const { WorkspaceShells } = await import("@/routes/workspace");
const { afterHostSignOut } = await import("./lifecycle");
const { HostWorkspaceSwitchBoundary } = await import("./workspace-switch-boundary");
const { currentHostExtension } = await import("./registry");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const appContext = {
  workspaces: [{ id: "w1", accountId: "", kind: "shared", name: "Operations" }],
  accessContext: { mode: "managed", subjectId: "user:ada", accountGrants: [], workspaceGrants: [] },
  resetSessionView: () => undefined,
} as unknown as AppContextValue;

async function render(
  node: ReactNode,
): Promise<{ container: HTMLElement; done: () => Promise<void> }> {
  const rootRoute = createRootRoute({ component: Outlet });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "workspaces/$workspaceId",
    component: () => (
      <AppContext.Provider value={appContext}>
        <TooltipProvider>{node}</TooltipProvider>
      </AppContext.Provider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute]),
    history: createMemoryHistory({ initialEntries: ["/workspaces/w1"] }),
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

describe("stock shell (no host extension)", () => {
  test("the stub declares no providers, brand, filter or hooks", () => {
    expect(currentHostExtension()).toEqual({ id: "none" });
  });

  test("the rail shows the Opengeni brand", async () => {
    const view = await render(
      <RailProvider workspaceId="w1">
        <RailHeader showSwitcher={false} />
      </RailProvider>,
    );
    try {
      const home = view.container.querySelector("[data-rail-brand] a[aria-label]");
      expect(home?.getAttribute("aria-label")).toBe("Opengeni home");
      expect(home?.textContent).toBe("Opengeni");
    } finally {
      await view.done();
    }
  });

  test("the shells render with no wrapper around them", async () => {
    const view = await render(
      <WorkspaceShells
        workspaceId="w1"
        workspaceName="Operations"
        organizationName="Organization"
        managementLocation={null}
      >
        <p>page</p>
      </WorkspaceShells>,
    );
    try {
      expect(view.container.innerHTML).toBe('<div data-testid="rail-shell"><p>page</p></div>');
    } finally {
      await view.done();
    }
  });

  test("the tenant boundary hands over at once, as before", async () => {
    const prepared: string[] = [];
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <HostWorkspaceSwitchBoundary
          workspaceId="w2"
          stateOwnerWorkspaceId="w1"
          prepareTransition={(workspaceId) => prepared.push(workspaceId)}
        />,
      );
    });
    expect(prepared).toEqual(["w2"]);
    expect(container.textContent).toContain("Switching workspace");
    await act(async () => root.unmount());
  });

  test("sign-out goes straight to the native request", async () => {
    let calls = 0;
    const pending = afterHostSignOut(async () => {
      calls += 1;
    });
    // Called in the same tick: nothing is awaited first.
    expect(calls).toBe(1);
    await pending;
  });
});
