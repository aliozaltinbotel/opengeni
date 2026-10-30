// A host extension's pages outside any workspace: mounted at the console's top
// level inside the extension's outside-workspace providers, a public page
// reaches a signed-out visitor, and a signed-in page reaches a person who has
// no workspace yet, ahead of the sign-in, access and onboarding gates.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { HostExtension } from "@opengeni/react/app/host-extension";
import { useOptionalAppContext } from "@opengeni/react/app/app-context";
import { useOpenGeni, useOpenGeniClient } from "@opengeni/react";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const RegisterPage = () => createElement("p", { "data-testid": "host-page" }, "Register");
const NotAdmittedPage = () => createElement("p", { "data-testid": "host-page" }, "Not admitted");
// A host resolver page: reads the signed-in person's workspaces from the app context.
const WorkspacesPage = () => {
  const appContext = useOptionalAppContext();
  const text = appContext
    ? appContext.workspaces.map((workspace) => workspace.name).join(",")
    : "no app context";
  return createElement("p", { "data-testid": "host-page" }, text);
};
// The app context opens no workspace: workspace-scoped hooks still refuse.
const WorkspaceScopedPage = () => {
  const refusals: string[] = [];
  try {
    refusals.push(`workspace:${useOpenGeni().workspaceId}`);
  } catch {
    refusals.push("no workspace");
  }
  try {
    useOpenGeniClient();
    refusals.push("client");
  } catch {
    refusals.push("no client");
  }
  return createElement("p", { "data-testid": "host-page" }, refusals.join(","));
};
// A public page renders with the public pages, outside the app context.
const PublicContextPage = () =>
  createElement(
    "p",
    { "data-testid": "host-page" },
    useOptionalAppContext() ? "app context" : "no app context",
  );
const HostProvider = ({ children }: { children: ReactNode }) =>
  createElement("section", { "data-testid": "host-provider" }, children);

const extension: HostExtension = {
  id: "fixture",
  outsideWorkspaceRoutes: [
    { path: "register", load: async () => ({ default: RegisterPage }), access: "public" },
    { path: "not-admitted", load: async () => ({ default: NotAdmittedPage }) },
    { path: "choose-workspace", load: async () => ({ default: WorkspacesPage }) },
    { path: "scoped", load: async () => ({ default: WorkspaceScopedPage }) },
    {
      path: "public-context",
      load: async () => ({ default: PublicContextPage }),
      access: "public",
    },
  ],
  outsideWorkspaceProviders: [HostProvider],
};
void mock.module("@opengeni/web-host-extension", () => ({ default: extension }));

/** What the console's app state reports: signed out, or signed in with no workspace. */
const state = { signedIn: false, appContextResolved: true };
/** The signed-in person's own workspaces, as their resolved app context carries them. */
const personWorkspaces = [
  { id: "w1", accountId: "a1", name: "Alpha" },
  { id: "w2", accountId: "a1", name: "Beta" },
];
const appState = await import("@opengeni/react/app/app-state");
void mock.module("@opengeni/react/app/app-state", () => ({
  ...appState,
  useAppState: () => ({
    appContext:
      state.signedIn && state.appContextResolved ? { workspaces: personWorkspaces } : null,
    client: {},
    clientConfig: {
      auth: { mode: "managedSession" },
      productAccessMode: "managed",
      analytics: { providers: {} },
    },
    configError: null,
    retryClientConfig: () => undefined,
    authSession: state.signedIn
      ? { user: { id: "u1", email: "ada@example.test", name: "Ada" } }
      : null,
    accessContext: state.signedIn ? { subjectId: "user:u1", workspaceGrants: [] } : null,
    accessError: null,
    accessLoading: false,
    accessKeyVersion: 0,
    retryAccess: () => undefined,
    keyAuthRequired: false,
    hasAccessKey: false,
    accessKeyDraft: "",
    setAccessKeyDraft: () => undefined,
    saveAccessKey: () => undefined,
    managedAuthRequired: true,
    managedEmailVerificationRequired: false,
    managedNewSignupsEnabled: true,
    managedSocialProviders: [],
    browserAccountsConfigured: false,
    browserAccountsEnabled: false,
    handleManagedAuth: async () => undefined,
    handleManagedSessionSetSignup: async () => undefined,
    handleManagedSocialAuth: async () => undefined,
    handleManagedSignOut: async () => undefined,
    handleBrowserActorTransition: async () => undefined,
    completeOrganizationOnboarding: () => undefined,
    revalidatePrincipalAccess: async () => undefined,
    defaultWorkspaceId: null,
    slackLinkContinuationWorkspaceId: null,
    routedWorkspace: null,
    creditRequired: null,
    setCreditRequired: () => undefined,
    mutationBusy: false,
  }),
}));

await import("./startup");
const { RootRouteComponent } = await import("../context");
const { buildHostExtensionOutsideWorkspaceRoutes } = await import("./routes");
const { outsideWorkspaceRouteAt } = await import("./registry");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  document.body.replaceChildren();
  state.signedIn = false;
  state.appContextResolved = true;
});

async function render(url: string): Promise<{ text: string; inProvider: boolean }> {
  const rootRoute = createRootRoute({ component: RootRouteComponent });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      buildHostExtensionOutsideWorkspaceRoutes(
        rootRoute,
        extension.outsideWorkspaceRoutes,
        extension.outsideWorkspaceProviders,
      ),
    ),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  for (
    let attempt = 0;
    attempt < 50 && !container.querySelector('[data-testid="host-page"]');
    attempt += 1
  )
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  const page = container.querySelector('[data-testid="host-page"]');
  const result = {
    text: page?.textContent ?? container.textContent ?? "",
    inProvider: Boolean(page?.closest('[data-testid="host-provider"]')),
  };
  act(() => root.unmount());
  container.remove();
  return result;
}

describe("host pages outside any workspace", () => {
  test("a public page reaches a signed-out visitor, inside the outside-workspace providers", async () => {
    expect(await render("/register")).toEqual({ text: "Register", inProvider: true });
  });

  test("a signed-in page reaches a person with no workspace, before onboarding", async () => {
    state.signedIn = true;
    expect(await render("/not-admitted")).toEqual({ text: "Not admitted", inProvider: true });
  });

  test("a signed-in page reads exactly the person's workspaces from their app context", async () => {
    state.signedIn = true;
    expect(await render("/choose-workspace")).toEqual({ text: "Alpha,Beta", inProvider: true });
  });

  test("a signed-in page has no app context until it has resolved", async () => {
    state.signedIn = true;
    state.appContextResolved = false;
    expect(await render("/choose-workspace")).toEqual({ text: "no app context", inProvider: true });
  });

  test("a signed-in page gets no workspace from the app context: workspace hooks still refuse", async () => {
    state.signedIn = true;
    expect(await render("/scoped")).toEqual({ text: "no workspace,no client", inProvider: true });
  });

  test("a public page has no app context, signed out or signed in", async () => {
    expect(await render("/public-context")).toEqual({ text: "no app context", inProvider: true });
    state.signedIn = true;
    expect(await render("/public-context")).toEqual({ text: "no app context", inProvider: true });
  });

  test("a signed-in page still asks a signed-out visitor to sign in", async () => {
    const view = await render("/not-admitted");
    expect(view.text).not.toBe("Not admitted");
  });

  test("the registry finds a page by its path, with or without a trailing slash", () => {
    expect(outsideWorkspaceRouteAt("/register")?.access).toBe("public");
    expect(outsideWorkspaceRouteAt("/not-admitted/")?.path).toBe("not-admitted");
    expect(outsideWorkspaceRouteAt("/register/extra")).toBeUndefined();
  });

  test("the console builds no outside page for the stub", () => {
    expect(
      buildHostExtensionOutsideWorkspaceRoutes(createRootRoute(), undefined, undefined),
    ).toEqual([]);
  });
});
