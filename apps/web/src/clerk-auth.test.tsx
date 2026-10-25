import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
const noPrincipalReset = async () => {};
let auth = {
  isLoaded: false,
  isSignedIn: false,
  sessionId: null as string | null,
  userId: "fixture-user-one",
  orgId: "fixture-organization-one" as string | null,
  getToken: async () => "fixture-clerk-session-token",
  signOut: async () => {},
};
let organizationState = {
  isLoaded: true,
  setActive: async (_input: { organization: string }) => {},
  userMemberships: {
    data: [{ organization: { id: "fixture-organization-one", name: "Existing organization" } }],
    isLoading: false,
    error: null as Error | null,
    hasNextPage: false,
    isFetching: false,
    fetchNext: () => {},
    revalidate: async () => {},
  },
};
mock.module("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  SignIn: ({ routing }: { routing: string }) => <div data-clerk-signin={routing} />,
  useAuth: () => auth,
  useOrganizationList: () => organizationState,
}));
const { ClerkConsoleAuth } = await import("./clerk-auth");
const { hasExternalAccessTokenSource, requestResponse, createOpenGeniClient } =
  await import("./api");
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
test("Clerk loading and signed-out states withhold native App, authenticated bridge registers before App starts", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  function NativeApp() {
    expect(hasExternalAccessTokenSource()).toBe(true);
    return <div data-native-app />;
  }
  const render = () =>
    root.render(
      <ClerkConsoleAuth publishableKey="pk_test_fixture" onPrincipalChange={noPrincipalReset}>
        <NativeApp />
      </ClerkConsoleAuth>,
    );
  try {
    await act(async () => render());
    expect(element.querySelector("[data-native-app]")).toBeNull();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    auth = { ...auth, isLoaded: true };
    await act(async () => render());
    expect(element.querySelector('[data-clerk-signin="hash"]')).not.toBeNull();
    expect(element.querySelector("[data-native-app]")).toBeNull();
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      networkCalls++;
      return Response.json({});
    }) as typeof fetch;
    try {
      await expect(requestResponse("/v1/config/client")).rejects.toThrow();
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    auth = { ...auth, isSignedIn: true, sessionId: "fixture-session-one" };
    await act(async () => render());
    expect(element.querySelector("[data-native-app]")).not.toBeNull();
    const actorAClient = createOpenGeniClient();
    const beforeRefreshFetch = globalThis.fetch;
    const authHeaders: Headers[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      authHeaders.push(new Headers(init?.headers));
      return Response.json({});
    }) as typeof fetch;
    try {
      auth = { ...auth, getToken: async () => "fixture-refreshed-token", signOut: async () => {} };
      await act(async () => render());
      await actorAClient.getAccessContext();
      expect(authHeaders[0]?.get("authorization")).toBe("Bearer fixture-refreshed-token");
      auth = { ...auth, sessionId: "fixture-session-two" };
      await act(async () => render());
      await expect(actorAClient.getAccessContext()).rejects.toMatchObject({ name: "AbortError" });
      expect(element.querySelector("[data-native-app]")).not.toBeNull();
    } finally {
      globalThis.fetch = beforeRefreshFetch;
    }
    auth = { ...auth, isSignedIn: false, sessionId: null };
    await act(async () => render());
    expect(element.querySelector("[data-native-app]")).toBeNull();
    expect(element.querySelector("[data-clerk-signin]")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test("same-session organization and person changes retire old clients and remount the native app", async () => {
  auth = {
    ...auth,
    isLoaded: true,
    isSignedIn: true,
    sessionId: "shared-session",
    userId: "person-one",
    orgId: "org-one",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounts = 0;
  function NativeApp() {
    const [instance] = useState(() => ++mounts);
    return <div data-instance={instance} />;
  }
  const render = () =>
    root.render(
      <ClerkConsoleAuth publishableKey="pk_test_fixture" onPrincipalChange={noPrincipalReset}>
        <NativeApp />
      </ClerkConsoleAuth>,
    );
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    calls++;
    return Response.json({});
  }) as typeof fetch;
  try {
    await act(async () => render());
    const firstClient = createOpenGeniClient();
    expect(mounts).toBe(1);
    auth = { ...auth, getToken: async () => "fresh-token-same-principal" };
    await act(async () => render());
    expect(mounts).toBe(1);
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls++;
      requestSignal = init?.signal;
      requestStarted();
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
          once: true,
        });
      });
    }) as typeof fetch;
    const pending = firstClient.getAccessContext().catch((error: unknown) => error);
    await started;
    auth = { ...auth, orgId: "org-two" };
    await act(async () => render());
    expect(requestSignal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(mounts).toBe(2);
    await expect(firstClient.getAccessContext()).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    const secondClient = createOpenGeniClient();
    auth = { ...auth, userId: "person-two" };
    await act(async () => render());
    expect(mounts).toBe(3);
    await expect(secondClient.getAccessContext()).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test.each([401, 403])(
  "Clerk configuration refusal %s offers existing organizations and an explicit account change",
  async (status) => {
    auth = {
      ...auth,
      isLoaded: true,
      isSignedIn: true,
      sessionId: "recovery-session",
      userId: "recovery-person",
      orgId: "refused-org",
    };
    const { App } = await import("./App");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      requests++;
      return Response.json({ code: "NOT_AUTHORIZED" }, { status });
    }) as typeof fetch;
    try {
      await act(async () =>
        root.render(
          <ClerkConsoleAuth publishableKey="pk_test_fixture" onPrincipalChange={noPrincipalReset}>
            <App />
          </ClerkConsoleAuth>,
        ),
      );
      expect(container.textContent).toContain("Choose an organization");
      expect(container.querySelector('option[value="fixture-organization-one"]')?.textContent).toBe(
        "Existing organization",
      );
      expect(container.textContent).toContain("Use another account");
      expect(container.textContent).not.toContain("Create organization");
      expect(requests).toBe(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    }
  },
);

test.each(["loading", "empty", "error"] as const)(
  "Clerk recovery reports organization list %s without inventing access",
  async (state) => {
    auth = {
      ...auth,
      isLoaded: true,
      isSignedIn: true,
      sessionId: "state-session",
      userId: "state-person",
      orgId: "refused-org",
    };
    organizationState = {
      ...organizationState,
      isLoaded: state !== "loading",
      userMemberships: {
        ...organizationState.userMemberships,
        data: [],
        isLoading: state === "loading",
        error: state === "error" ? new Error("private issuer detail") : null,
      },
    };
    const { App } = await import("./App");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      Response.json({ code: "NOT_AUTHORIZED" }, { status: 403 })) as typeof fetch;
    try {
      await act(async () =>
        root.render(
          <ClerkConsoleAuth publishableKey="pk_test_fixture" onPrincipalChange={noPrincipalReset}>
            <App />
          </ClerkConsoleAuth>,
        ),
      );
      expect(container.textContent).toContain(
        state === "loading"
          ? "Loading your organizations"
          : state === "empty"
            ? "This account has no organizations"
            : "Your organizations could not be loaded",
      );
      expect(container.textContent).not.toContain("private issuer detail");
      expect(container.textContent).toContain("Use another account");
      expect(container.querySelector("select")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    }
  },
);

test("Clerk recovery selects only an existing membership, clears old route and signs out only explicitly", async () => {
  auth = {
    ...auth,
    isLoaded: true,
    isSignedIn: true,
    sessionId: "action-session",
    userId: "action-person",
    orgId: "refused-org",
  };
  let signOuts = 0;
  const selected: string[] = [];
  auth.signOut = async () => {
    signOuts++;
    throw new Error("private signout detail");
  };
  organizationState = {
    ...organizationState,
    isLoaded: true,
    setActive: async ({ organization }) => {
      expect(window.location.pathname).toBe("/");
      expect(window.location.search).toBe("");
      selected.push(organization);
    },
    userMemberships: {
      ...organizationState.userMemberships,
      data: [{ organization: { id: "fixture-organization-one", name: "Existing organization" } }],
      isLoading: false,
      error: null,
    },
  };
  const { App } = await import("./App");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    Response.json({ code: "NOT_AUTHORIZED" }, { status: 403 })) as typeof fetch;
  try {
    await act(async () =>
      root.render(
        <ClerkConsoleAuth publishableKey="pk_test_fixture" onPrincipalChange={noPrincipalReset}>
          <App />
        </ClerkConsoleAuth>,
      ),
    );
    expect(signOuts).toBe(0);
    await act(async () => {
      window.history.pushState(
        null,
        "",
        "/workspaces/00000000-0000-4000-8000-000000000099/sessions/00000000-0000-4000-8000-000000000098?workspaceId=old#old-session",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(window.location.pathname).not.toBe("/");
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "fixture-organization-one";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue",
    )!;
    await act(async () => continueButton.click());
    expect(selected).toEqual(["fixture-organization-one"]);
    expect(signOuts).toBe(0);
    const signOut = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use another account",
    )!;
    await act(async () => signOut.click());
    expect(signOuts).toBe(1);
    expect(container.textContent).toContain("The change could not be completed");
    expect(container.textContent).not.toContain("private signout detail");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test("external Clerk principal replacement clears the actual router URL before new bootstrap", async () => {
  auth = {
    ...auth,
    isLoaded: true,
    isSignedIn: true,
    sessionId: "external-session",
    userId: "external-person",
    orgId: "org-first",
  };
  const { App, resetPrincipalRoute } = await import("./App");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const bootstraps: string[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    bootstraps.push(window.location.pathname + window.location.search + window.location.hash);
    return Response.json({ code: "NOT_AUTHORIZED" }, { status: 403 });
  }) as typeof fetch;
  const render = () =>
    root.render(
      <ClerkConsoleAuth publishableKey="pk_test_fixture" onPrincipalChange={resetPrincipalRoute}>
        <App />
      </ClerkConsoleAuth>,
    );
  try {
    await act(async () => {
      window.history.pushState(
        null,
        "",
        "/workspaces/00000000-0000-4000-8000-000000000099/sessions/00000000-0000-4000-8000-000000000098?workspaceId=old#old-session",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
      render();
    });
    expect(bootstraps[0]).toContain("workspaceId=old");
    auth = { ...auth, orgId: "org-second" };
    await act(async () => render());
    expect(bootstraps).toHaveLength(2);
    expect(bootstraps[1]).toBe("/");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test("a superseded asynchronous principal reset cannot mount the old person", async () => {
  auth = {
    ...auth,
    isLoaded: true,
    isSignedIn: true,
    sessionId: "reset-session",
    userId: "reset-person",
    orgId: "org-a",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const resets: Array<() => void> = [];
  const reset = () => new Promise<void>((resolve) => resets.push(resolve));
  const render = () =>
    root.render(
      <ClerkConsoleAuth publishableKey="pk_test_fixture" onPrincipalChange={reset}>
        <div data-accepted-principal={auth.orgId} />
      </ClerkConsoleAuth>,
    );
  try {
    await act(async () => render());
    auth = { ...auth, orgId: "org-b" };
    await act(async () => render());
    auth = { ...auth, orgId: "org-c" };
    await act(async () => render());
    expect(resets).toHaveLength(2);
    await act(async () => resets[0]!());
    expect(container.querySelector("[data-accepted-principal]")).toBeNull();
    await act(async () => resets[1]!());
    expect(
      container.querySelector("[data-accepted-principal]")?.getAttribute("data-accepted-principal"),
    ).toBe("org-c");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("organization pagination rejection is shown without an unhandled promise or losing memberships", async () => {
  auth = {
    ...auth,
    isLoaded: true,
    isSignedIn: true,
    sessionId: "pagination-session",
    userId: "pagination-person",
    orgId: "refused-org",
  };
  organizationState = {
    ...organizationState,
    isLoaded: true,
    userMemberships: {
      ...organizationState.userMemberships,
      data: [{ organization: { id: "fixture-organization-one", name: "Existing organization" } }],
      error: null,
      isLoading: false,
      hasNextPage: true,
      fetchNext: async () => {
        throw new Error("private pagination detail");
      },
    },
  };
  const { App } = await import("./App");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    Response.json({ code: "NOT_AUTHORIZED" }, { status: 403 })) as typeof fetch;
  try {
    await act(async () =>
      root.render(
        <ClerkConsoleAuth publishableKey="pk_test_fixture" onPrincipalChange={noPrincipalReset}>
          <App />
        </ClerkConsoleAuth>,
      ),
    );
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Show more organizations",
    )!;
    await act(async () => more.click());
    expect(container.textContent).toContain("The change could not be completed");
    expect(container.textContent).not.toContain("private pagination detail");
    expect(container.querySelector('option[value="fixture-organization-one"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});


test("Clerk recovery retries an existing current organization without treating selection as new access", async () => {
  auth = { ...auth, isLoaded: true, isSignedIn: true, sessionId: "retry-current-session", userId: "retry-current-person", orgId: "fixture-organization-one" };
  const selected: string[] = [];
  organizationState = { ...organizationState, isLoaded: true,
    setActive: async ({ organization }) => { selected.push(organization); },
    userMemberships: { ...organizationState.userMemberships,
      data: [{ organization: { id: "fixture-organization-one", name: "Existing organization" } }],
      isLoading: false, error: null, hasNextPage: false, isFetching: false },
  };
  const { App } = await import("./App");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  let configurationRequests = 0;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    configurationRequests++;
    return Response.json({ code: "NOT_AUTHORIZED" }, { status: 403 });
  }) as typeof fetch;
  try {
    await act(async () => root.render(<ClerkConsoleAuth publishableKey="pk_test_fixture" onPrincipalChange={noPrincipalReset}><App /></ClerkConsoleAuth>));
    const select = container.querySelector("select")!;
    // A disabled placeholder must remain the visible selection until an explicit choice.
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]?.textContent).toBe("Choose an organization");
    const continueButton = [...container.querySelectorAll("button")].find(button => button.textContent === "Continue")!;
    expect(continueButton.disabled).toBe(true);
    await act(async () => {
      select.value = "fixture-organization-one";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(continueButton.disabled).toBe(false);
    await act(async () => continueButton.click());
    expect(selected).toEqual(["fixture-organization-one"]);
    expect(configurationRequests).toBe(2);
    // A retry is not authorization: the real repeated refusal must still render recovery.
    expect(container.textContent).toContain("Choose an organization");
    expect(container.querySelector("[data-native-app]")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});
