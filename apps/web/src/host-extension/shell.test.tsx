// A configured host extension wraps both console shells in its providers,
// brands the rail with its own mark and name, keeps the workspace switcher and
// the landing to the workspaces it allows, and is waited on before sign-out
// and before switching workspace. The fixture extension stands in for a host
// product.
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRoute,
  type RouteComponent,
} from "@tanstack/react-router";
import { act, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { HostExtension } from "@opengeni/react/app/host-extension";
import type { AppContextValue } from "@opengeni/react/app/app-context";
import type { Workspace } from "@opengeni/react/app/types";

import { hostExtensionFixture } from "../../test/fixtures/host-extension-fixture";

/** What the fixture's lifecycle hooks do, set by each test. */
const hooks = {
  signOut: async (): Promise<void> => undefined,
  workspaceSwitch: async (_from: string, _to: string): Promise<void> => undefined,
};

function FixtureProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return (
    <div data-testid="fixture-provider" data-workspace-id={workspaceId}>
      {children}
    </div>
  );
}
function FixtureMark({ className }: { className?: string }) {
  return <svg data-testid="fixture-mark" className={className} />;
}
function FixtureWordmark({ className }: { className?: string }) {
  return (
    <span data-testid="fixture-wordmark" className={className}>
      Fixture PMS
    </span>
  );
}

const extension: HostExtension = {
  ...hostExtensionFixture,
  brand: { mark: FixtureMark, wordmark: FixtureWordmark },
  shellProviders: [FixtureProvider],
  workspaceFilter: (candidate) => candidate.id !== "w2",
  lifecycle: {
    onSignOut: () => hooks.signOut(),
    onWorkspaceSwitch: (from, to) => hooks.workspaceSwitch(from, to),
  },
};
void mock.module("@opengeni/web-host-extension", () => ({ default: extension }));

const railShell = await import("@/components/rail/rail-shell");
void mock.module("@/components/rail/rail-shell", () => ({
  ...railShell,
  RailShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="rail-shell">{children}</div>
  ),
}));
const settingsShell = await import("@/components/settings/workspace-settings-shell");
void mock.module("@/components/settings/workspace-settings-shell", () => ({
  ...settingsShell,
  WorkspaceManagementShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="settings-shell">{children}</div>
  ),
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await import("@/app-host");
const { AppContext } = await import("@opengeni/react/app/app-context");
const { RailProvider, useRail } = await import("@opengeni/react/app/components/rail/rail-context");
const { RailHeader } = await import("@opengeni/react/app/components/rail/rail-sections");
const { TooltipProvider } = await import("@opengeni/react/ui/tooltip");
const { WorkspaceShells } = await import("@/routes/workspace");
const { useSettingsRail } = await import("@/components/settings/settings-rail");
const { afterHostSignOut } = await import("./lifecycle");
const { HostWorkspaceSwitchBoundary, useHostWorkspaceEntered } =
  await import("./workspace-switch-boundary");
const { BrandMark } = await import("@opengeni/react/app/components/brand-mark");
const { openGeniGroupPresentation } =
  await import("@opengeni/react/app/components/billing-class-mark");
const { OpenGeniCreditsTile } = await import("@opengeni/react/app/components/models/provider-mark");
const { signOutManaged } = await import("@/api");
const app = await import("../App");

const errors = spyOn(console, "error").mockImplementation(() => undefined);
afterAll(() => {
  errors.mockRestore();
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  hooks.signOut = async () => undefined;
  hooks.workspaceSwitch = async () => undefined;
});
afterEach(() => errors.mockClear());

const ACCOUNT_ID = "account-1";
const SUBJECT_ID = "user:ada";

function workspace(id: string, name: string): Workspace {
  return {
    id,
    accountId: ACCOUNT_ID,
    kind: "shared",
    name,
    inferenceControl: { state: "active" },
  } as Workspace;
}

function appContextFor(
  workspaces: readonly Workspace[],
  defaultWorkspaceId: string | null = null,
): AppContextValue {
  return {
    workspaces,
    accessContext: {
      mode: "managed",
      subjectId: SUBJECT_ID,
      accountGrants: [],
      workspaceGrants: workspaces.map((candidate) => ({
        workspaceId: candidate.id,
        accountId: ACCOUNT_ID,
        subjectId: SUBJECT_ID,
        permissions: ["workspace:admin"],
      })),
      defaultAccountId: ACCOUNT_ID,
      defaultWorkspaceId,
    },
    clientConfig: { auth: { mode: "managedSession" }, productAccessMode: "managed" },
    managedSelfContext: null,
    client: { listInbox: async () => ({ items: [] }) },
    resetSessionView: () => undefined,
  } as unknown as AppContextValue;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

type Mounted = {
  container: HTMLElement;
  pathname: () => string;
  history: { back: () => void; forward: () => void };
  done: () => Promise<void>;
};

/**
 * Mounts a memory router at `url` with a root (holding the app context),
 * the workspace route rendering `workspace` around its pages, and the given
 * root-level routes.
 */
async function mount(input: {
  url: string;
  context: AppContextValue;
  workspace?: (workspaceId: string) => ReactNode;
  index?: RouteComponent;
}): Promise<Mounted> {
  const rootRoute = createRootRoute({
    component: () => (
      <AppContext.Provider value={input.context}>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </AppContext.Provider>
    ),
    notFoundComponent: () => null,
  });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "workspaces/$workspaceId",
    component: function Workspace() {
      const { workspaceId } = workspaceRoute.useParams();
      return (
        <>
          {input.workspace?.(workspaceId)}
          <p data-testid="workspace-page">{workspaceId}</p>
        </>
      );
    },
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => workspaceRoute, path, component: () => null });
  const children: AnyRoute[] = [workspaceRoute.addChildren([page("sessions"), page("settings")])];
  if (input.index) {
    children.push(
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: input.index }),
    );
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren(children),
    history: createMemoryHistory({ initialEntries: [input.url] }),
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
    pathname: () => router.state.location.pathname,
    history: { back: () => router.history.back(), forward: () => router.history.forward() },
    done: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** The console's own root index page (App.tsx's RootIndexRoute). */
function rootIndexComponent(): RouteComponent {
  const index = (app.routeTree.children as readonly AnyRoute[]).find(
    (route) => (route.options as { path?: string }).path === "/",
  );
  expect(index).toBeDefined();
  return index?.options.component as RouteComponent;
}

const W1 = workspace("w1", "Front desk");
const W2 = workspace("w2", "Elsewhere");

describe("host extension shell", () => {
  test("its providers wrap both the rail shell and the settings shell", async () => {
    for (const managementLocation of [null, { kind: "settings", section: "general" } as const]) {
      const view = await mount({
        url: "/workspaces/w1/sessions",
        context: appContextFor([W1]),
        workspace: (workspaceId) => (
          <WorkspaceShells
            workspaceId={workspaceId}
            workspaceName="Front desk"
            organizationName="Organization"
            managementLocation={managementLocation}
          >
            <p data-testid="page">page</p>
          </WorkspaceShells>
        ),
      });
      await settle();
      try {
        const provider = view.container.querySelector('[data-testid="fixture-provider"]');
        expect(provider?.getAttribute("data-workspace-id")).toBe("w1");
        const shell = managementLocation ? "settings-shell" : "rail-shell";
        expect(
          provider?.querySelector(`[data-testid="${shell}"] [data-testid="page"]`),
        ).not.toBeNull();
      } finally {
        await view.done();
      }
    }
  });

  test("the rail shows the host's mark and wordmark, named for the product", async () => {
    const view = await mount({
      url: "/workspaces/w1/sessions",
      context: appContextFor([W1]),
      workspace: (workspaceId) => (
        <RailProvider workspaceId={workspaceId}>
          <RailHeader showSwitcher={false} />
        </RailProvider>
      ),
    });
    try {
      const home = view.container.querySelector("[data-rail-brand] a[aria-label]");
      expect(home?.getAttribute("aria-label")).toBe("Fixture home");
      expect(home?.querySelector('[data-testid="fixture-mark"]')).not.toBeNull();
      expect(home?.querySelector('[data-testid="fixture-wordmark"]')?.textContent).toBe(
        "Fixture PMS",
      );
      expect(home?.textContent).not.toContain("Opengeni");
    } finally {
      await view.done();
    }
  });

  test("Opengeni credit marks keep the Opengeni mark under a host brand", async () => {
    const view = await mount({
      url: "/workspaces/w1/sessions",
      context: appContextFor([W1]),
      workspace: () => (
        <>
          <span data-testid="console-brand">
            <BrandMark />
          </span>
          <span data-testid="credits-tile">
            <OpenGeniCreditsTile />
          </span>
          <span data-testid="credits-class">
            {openGeniGroupPresentation.opengeni_credits?.icon}
          </span>
        </>
      ),
    });
    try {
      const within = (id: string) => view.container.querySelector(`[data-testid="${id}"]`);
      expect(within("console-brand")?.querySelector('[data-testid="fixture-mark"]')).not.toBeNull();
      for (const id of ["credits-tile", "credits-class"]) {
        expect(within(id)?.querySelector('[data-testid="fixture-mark"]')).toBeNull();
        expect(within(id)?.querySelector('svg[viewBox="0 0 176 138.73"]')).not.toBeNull();
      }
    } finally {
      await view.done();
    }
  });

  test("the root lands on a workspace the filter keeps", async () => {
    const index = rootIndexComponent();
    // The default workspace is w2, which the filter leaves out.
    const view = await mount({ url: "/", context: appContextFor([W2, W1], "w2"), index });
    await settle();
    try {
      expect(view.pathname()).toBe("/workspaces/w1/sessions");
    } finally {
      await view.done();
    }
  });

  test("a filter that leaves no workspace shows the no-workspace state, without redirecting", async () => {
    const index = rootIndexComponent();
    const view = await mount({ url: "/", context: appContextFor([W2], "w2"), index });
    await settle();
    try {
      expect(view.pathname()).toBe("/");
      expect(view.container.textContent).toContain("No workspace access");
    } finally {
      await view.done();
    }
  });
});

describe("host extension lifecycle", () => {
  let fetched: string[] = [];
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    fetched = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("onSignOut is awaited before the native sign-out request", async () => {
    const hook = deferred();
    hooks.signOut = () => hook.promise;
    const signedOut = afterHostSignOut(signOutManaged);
    await settle();
    expect(fetched.filter((url) => url.endsWith("/v1/auth/sign-out"))).toEqual([]);
    hook.resolve();
    await signedOut;
    expect(fetched.filter((url) => url.endsWith("/v1/auth/sign-out"))).toHaveLength(1);
  });

  test("a rejected onSignOut still signs out and logs HOST_LIFECYCLE_HOOK_FAILED", async () => {
    hooks.signOut = async () => Promise.reject(new Error("host unavailable"));
    await afterHostSignOut(signOutManaged);
    expect(fetched.filter((url) => url.endsWith("/v1/auth/sign-out"))).toHaveLength(1);
    expect(errors.mock.calls.map((call) => call[0])).toContain("HOST_LIFECYCLE_HOOK_FAILED");
  });

  /** Mounts the rail at w1 and returns its `openWorkspace`, the switcher's and ⌘K's switch. */
  async function railAt(url: string) {
    let openWorkspace: ((workspaceId: string) => void) | null = null;
    function Capture() {
      openWorkspace = useRail().openWorkspace;
      return null;
    }
    const view = await mount({
      url,
      context: appContextFor([W1, W2]),
      workspace: (workspaceId) => (
        <RailProvider workspaceId={workspaceId}>
          <Capture />
        </RailProvider>
      ),
    });
    return { view, open: (workspaceId: string) => openWorkspace?.(workspaceId) };
  }

  test("onWorkspaceSwitch(from, to) is awaited before the rail navigates", async () => {
    const hook = deferred();
    const seen: string[] = [];
    hooks.workspaceSwitch = (from, to) => {
      seen.push(`${from}->${to}`);
      return hook.promise;
    };
    const rail = await railAt("/workspaces/w1/sessions");
    try {
      await act(async () => rail.open("w2"));
      await settle();
      expect(seen).toEqual(["w1->w2"]);
      expect(rail.view.pathname()).toBe("/workspaces/w1/sessions");
      hook.resolve();
      await settle();
      expect(rail.view.pathname()).toBe("/workspaces/w2/sessions");
    } finally {
      await rail.view.done();
    }
  });

  test("a rejected onWorkspaceSwitch still switches and logs HOST_LIFECYCLE_HOOK_FAILED", async () => {
    hooks.workspaceSwitch = async () => Promise.reject(new Error("host unavailable"));
    const rail = await railAt("/workspaces/w1/sessions");
    try {
      await act(async () => rail.open("w2"));
      await settle();
      expect(rail.view.pathname()).toBe("/workspaces/w2/sessions");
      expect(errors.mock.calls.map((call) => call[0])).toContain("HOST_LIFECYCLE_HOOK_FAILED");
    } finally {
      await rail.view.done();
    }
  });

  test("the settings rail's picker waits for onWorkspaceSwitch too", async () => {
    const hook = deferred();
    const seen: string[] = [];
    hooks.workspaceSwitch = (from, to) => {
      seen.push(`${from}->${to}`);
      return hook.promise;
    };
    let picker: ReactElement<{ onSelect: (workspaceId: string) => void }> | null = null;
    function Capture({ workspaceId }: { workspaceId: string }) {
      const element = useSettingsRail({
        workspaceId,
        location: { kind: "settings", section: "general" },
      }).picker;
      picker = isValidElement(element)
        ? (element as ReactElement<{ onSelect: (workspaceId: string) => void }>)
        : null;
      return null;
    }
    const view = await mount({
      url: "/workspaces/w1/settings",
      context: appContextFor([W1, W2]),
      workspace: (workspaceId) => <Capture workspaceId={workspaceId} />,
    });
    try {
      expect(picker).not.toBeNull();
      await act(async () =>
        (
          picker as ReactElement<{ onSelect: (workspaceId: string) => void }> | null
        )?.props.onSelect("w2"),
      );
      await settle();
      expect(seen).toEqual(["w1->w2"]);
      expect(view.pathname()).toBe("/workspaces/w1/settings");
      hook.resolve();
      await settle();
      expect(view.pathname()).toBe("/workspaces/w2/settings");
    } finally {
      await view.done();
    }
  });
});

describe("host extension workspace-switch fallback", () => {
  /** The console's workspace state owner, kept across the workspace route's renders. */
  const owner: { current: string | null } = { current: null };
  beforeEach(async () => {
    owner.current = null;
    // Signing out forgets the workspace last entered, so each test starts fresh.
    await afterHostSignOut(async () => undefined);
  });

  /** The workspace route as the console builds it: the tenant boundary, then the shell. */
  function FallbackShell({ workspaceId }: { workspaceId: string }) {
    const [stateOwner, setStateOwner] = useState(owner.current);
    const ready = stateOwner === workspaceId;
    useHostWorkspaceEntered(workspaceId, ready);
    if (!ready) {
      return (
        <HostWorkspaceSwitchBoundary
          workspaceId={workspaceId}
          stateOwnerWorkspaceId={stateOwner}
          prepareTransition={(next) => {
            owner.current = next;
            setStateOwner(next);
          }}
        />
      );
    }
    return (
      <RailProvider workspaceId={workspaceId}>
        <CaptureRail />
        <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId: "w2" }}>
          Open w2
        </Link>
      </RailProvider>
    );
  }
  const rail: { openWorkspace: ((workspaceId: string) => void) | null } = { openWorkspace: null };
  function CaptureRail() {
    rail.openWorkspace = useRail().openWorkspace;
    return null;
  }

  async function shellAt(url: string) {
    const view = await mount({
      url,
      context: appContextFor([W1, W2]),
      workspace: (workspaceId) => <FallbackShell workspaceId={workspaceId} />,
    });
    await settle();
    return view;
  }

  function recordSwitches(): { seen: string[]; release: () => void } {
    const seen: string[] = [];
    let pending = deferred();
    hooks.workspaceSwitch = (from, to) => {
      seen.push(`${from}->${to}`);
      return pending.promise;
    };
    return {
      seen,
      release: () => {
        pending.resolve();
        pending = deferred();
      },
    };
  }

  test("a raw link into another workspace waits for onWorkspaceSwitch once", async () => {
    const switches = recordSwitches();
    const view = await shellAt("/workspaces/w1/sessions");
    try {
      expect(switches.seen).toEqual([]);
      const link = Array.from(view.container.querySelectorAll("a")).find(
        (anchor) => anchor.textContent === "Open w2",
      );
      await act(async () => link?.click());
      await settle();
      expect(view.pathname()).toBe("/workspaces/w2/sessions");
      expect(view.container.textContent).toContain("Switching workspace");
      expect(switches.seen).toEqual(["w1->w2"]);
      switches.release();
      await settle();
      expect(owner.current).toBe("w2");
      expect(view.container.textContent).not.toContain("Switching workspace");
      expect(switches.seen).toEqual(["w1->w2"]);
    } finally {
      await view.done();
    }
  });

  test("back and forward each wait for onWorkspaceSwitch once", async () => {
    const switches = recordSwitches();
    const view = await shellAt("/workspaces/w1/sessions");
    try {
      const link = Array.from(view.container.querySelectorAll("a")).find(
        (anchor) => anchor.textContent === "Open w2",
      );
      await act(async () => link?.click());
      await settle();
      switches.release();
      await settle();
      await act(async () => view.history.back());
      await settle();
      expect(view.pathname()).toBe("/workspaces/w1/sessions");
      expect(switches.seen).toEqual(["w1->w2", "w2->w1"]);
      expect(owner.current).toBe("w2");
      switches.release();
      await settle();
      expect(owner.current).toBe("w1");
      await act(async () => view.history.forward());
      await settle();
      switches.release();
      await settle();
      expect(view.pathname()).toBe("/workspaces/w2/sessions");
      expect(owner.current).toBe("w2");
      expect(switches.seen).toEqual(["w1->w2", "w2->w1", "w1->w2"]);
    } finally {
      await view.done();
    }
  });

  test("a switch the rail already waited on is not hooked again at the boundary", async () => {
    const switches = recordSwitches();
    const view = await shellAt("/workspaces/w1/sessions");
    try {
      await act(async () => rail.openWorkspace?.("w2"));
      await settle();
      expect(view.pathname()).toBe("/workspaces/w1/sessions");
      switches.release();
      await settle();
      expect(view.pathname()).toBe("/workspaces/w2/sessions");
      expect(owner.current).toBe("w2");
      expect(switches.seen).toEqual(["w1->w2"]);
    } finally {
      await view.done();
    }
  });
});
