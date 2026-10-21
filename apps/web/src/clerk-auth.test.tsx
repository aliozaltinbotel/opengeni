import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
let auth = {
  isLoaded: false,
  isSignedIn: false,
  sessionId: null as string | null,
  getToken: async () => "fixture-clerk-session-token",
  signOut: async () => {},
};
mock.module("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  SignIn: ({ routing }: { routing: string }) => <div data-clerk-signin={routing} />,
  useAuth: () => auth,
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
      <ClerkConsoleAuth publishableKey="pk_test_fixture">
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
