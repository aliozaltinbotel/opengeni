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

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const RegisterPage = () => createElement("p", { "data-testid": "host-page" }, "Register");
const NotAdmittedPage = () => createElement("p", { "data-testid": "host-page" }, "Not admitted");
const HostProvider = ({ children }: { children: ReactNode }) =>
  createElement("section", { "data-testid": "host-provider" }, children);

const extension: HostExtension = {
  id: "fixture",
  outsideWorkspaceRoutes: [
    { path: "register", load: async () => ({ default: RegisterPage }), access: "public" },
    { path: "not-admitted", load: async () => ({ default: NotAdmittedPage }) },
  ],
  outsideWorkspaceProviders: [HostProvider],
};
void mock.module("@opengeni/web-host-extension", () => ({ default: extension }));

/** What the console's app state reports: signed out, or signed in with no workspace. */
const state = { signedIn: false };
const appState = await import("@opengeni/react/app/app-state");
void mock.module("@opengeni/react/app/app-state", () => ({
  ...appState,
  useAppState: () => ({
    appContext: {},
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
