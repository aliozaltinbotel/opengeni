// A configured extension's chat panel (`HostExtension.chatPanel`): a rail page
// opens the console's chat beside it with checked context, a second open keeps
// the one chat, and a page `enabled` answers false for (or a settings page)
// offers none. The panel body is a stand-in that records what the frame gives
// it; host-chat-panel.test.tsx covers the panel itself.
import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostExtension, HostExtensionPage } from "@opengeni/react/app/host-extension";
import type { HostChatPanelProps } from "@opengeni/react/app/components/host-chat-panel";

const panelProps: HostChatPanelProps[] = [];
const panelMounts = { count: 0 };
const pageMounts = { count: 0 };
let opened: boolean[] = [];

function PanelStandIn(props: HostChatPanelProps) {
  panelProps.push(props);
  useEffect(() => {
    panelMounts.count += 1;
  }, []);
  return (
    <aside aria-label="Chat" data-session={props.sessionId ?? ""}>
      <button type="button" onClick={() => props.onSessionChange("session-1")}>
        Started
      </button>
      <button type="button" onClick={props.onClose}>
        Close chat
      </button>
    </aside>
  );
}
void mock.module("@opengeni/react/app/routes/site-view", () => ({ HostChatPanel: PanelStandIn }));

const { openChatPanel } = await import("@opengeni/react/app/chat-panel");

const stay = { id: "stay", label: "Stay R-1", text: "reservation: r-1", detail: "Arrives Friday" };
const property = { id: "property", label: "Villa", text: "property: p-1" };
let nextContext: unknown = [stay];

const Page: HostExtensionPage = ({ workspaceId }) => {
  useEffect(() => {
    pageMounts.count += 1;
  }, []);
  return (
    <button
      type="button"
      data-testid="ask"
      onClick={() => opened.push(openChatPanel(nextContext as never))}
    >
      Ask in chat on {workspaceId}
    </button>
  );
};
const load = async () => ({ default: Page });

const extension: HostExtension = {
  id: "fixture",
  routes: [
    { path: "pms", load },
    { path: "pms-quiet", load },
    { path: "pms-settings", load, mode: "settings" },
  ],
  chatPanel: { enabled: ({ pathname }) => !pathname.endsWith("/pms-quiet") },
};
void mock.module("@opengeni/web-host-extension", () => ({ default: extension }));

let registry: typeof import("./registry");
let routes: typeof import("./routes");
beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  await import("./startup");
  registry = await import("./registry");
  routes = await import("./routes");
});
afterAll(async () => {
  mock.restore();
  await GlobalRegistrator.unregister();
});

let root: Root | null = null;
let router: AnyRouter | null = null;
afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  router = null;
  document.body.innerHTML = "";
  panelProps.length = 0;
  panelMounts.count = 0;
  pageMounts.count = 0;
  opened = [];
  nextContext = [stay];
  // Leave the shared panel closed for the next test.
  const { closeChatPanel } = await import("./chat-panel-state");
  closeChatPanel();
});

const settle = async (until: () => boolean) => {
  for (let attempt = 0; attempt < 60 && !until(); attempt += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};

async function renderAt(url: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "workspaces/$workspaceId",
    component: Outlet,
  });
  router = createRouter({
    routeTree: rootRoute.addChildren([
      workspaceRoute.addChildren(
        routes.buildHostExtensionWorkspaceRoutes(
          workspaceRoute,
          registry.currentHostExtension().routes,
          registry.currentHostExtension().chatPanel,
        ),
      ),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await router.load();
  await act(async () => root!.render(<RouterProvider router={router!} />));
  await settle(() => container.querySelector('[data-testid="ask"]') !== null);
  return container;
}

const ask = async (container: HTMLElement) => {
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="ask"]')!.click());
  await settle(() => container.querySelector('aside[aria-label="Chat"]') !== null);
};
const click = async (container: HTMLElement, label: string) =>
  act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click(),
  );
const lastProps = () => panelProps.at(-1)!;

test("the seam opens the console's chat beside the page with the checked context", async () => {
  const container = await renderAt("/workspaces/w1/pms");
  expect(container.querySelector('aside[aria-label="Chat"]')).toBeNull();

  await ask(container);

  expect(opened).toEqual([true]);
  // Beside the page, in the page's own scroller.
  const row = container.querySelector('[data-slot="content-page"]')!.parentElement!;
  expect(row.querySelector('aside[aria-label="Chat"]')).not.toBeNull();
  expect(lastProps().workspaceId).toBe("w1");
  expect(lastProps().context).toEqual([stay]);
  expect(lastProps().sessionId).toBeNull();
  // Opening it never remounts the page.
  expect(pageMounts.count).toBe(1);
});

test("a second open keeps the one open chat and takes the new context", async () => {
  const container = await renderAt("/workspaces/w1/pms");
  await ask(container);
  await click(container, "Started");
  expect(lastProps().sessionId).toBe("session-1");

  nextContext = [property];
  await ask(container);

  expect(opened).toEqual([true, true]);
  expect(panelMounts.count).toBe(1);
  expect(lastProps().sessionId).toBe("session-1");
  expect(lastProps().context).toEqual([property]);
  expect(lastProps().openCount).toBe(panelProps[0]!.openCount + 1);
});

test("a closed panel opens again on a new chat", async () => {
  const container = await renderAt("/workspaces/w1/pms");
  await ask(container);
  await click(container, "Started");
  await click(container, "Close chat");
  expect(container.querySelector('aside[aria-label="Chat"]')).toBeNull();

  await ask(container);
  expect(lastProps().sessionId).toBeNull();
});

test("context the extension's messageContext could not return opens the panel without it", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const container = await renderAt("/workspaces/w1/pms");
    for (const refused of [
      "reservation r-1",
      [{ id: "stay", text: "reservation: r-1" }],
      [stay, { ...stay, label: "Again" }],
      [{ ...stay, authority: "admin" }],
    ]) {
      nextContext = refused;
      await ask(container);
      expect(lastProps().context).toEqual([]);
    }
    expect(opened).toEqual([true, true, true, true]);
    expect(warn.mock.calls).toEqual([["HOST_CHAT_PANEL_CONTEXT_FAILED"]]);
  } finally {
    warn.mockRestore();
  }
});

test("a page chatPanel.enabled answers false for, and a settings page, offer no panel", async () => {
  for (const url of ["/workspaces/w1/pms-quiet", "/workspaces/w1/pms-settings"]) {
    const container = await renderAt(url);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="ask"]')!.click(),
    );
    await settle(() => false);
    expect(container.querySelector('aside[aria-label="Chat"]')).toBeNull();
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  }
  expect(opened).toEqual([false, false]);
});

test("the panel follows the person to another rail page and leaves pages that offer none", async () => {
  const container = await renderAt("/workspaces/w1/pms");
  await ask(container);
  await click(container, "Started");

  await act(async () => router!.history.push("/workspaces/w1/pms-quiet"));
  await settle(() => container.querySelector('aside[aria-label="Chat"]') === null);
  expect(container.querySelector('aside[aria-label="Chat"]')).toBeNull();

  await act(async () => router!.history.push("/workspaces/w1/pms"));
  await settle(() => container.querySelector('aside[aria-label="Chat"]') !== null);
  expect(container.querySelector('aside[aria-label="Chat"]')?.getAttribute("data-session")).toBe(
    "session-1",
  );
});

test("chatPanel is checked at registration", () => {
  expect(() =>
    registry.validateHostExtension({ id: "x", chatPanel: { enabled: () => true } }),
  ).not.toThrow();
  expect(() => registry.validateHostExtension({ id: "x", chatPanel: true })).toThrow(
    "HOST_EXTENSION_INVALID: chatPanel must be an object",
  );
  expect(() => registry.validateHostExtension({ id: "x", chatPanel: { enabled: true } })).toThrow(
    "HOST_EXTENSION_INVALID: chatPanel.enabled must be a function",
  );
  expect(() =>
    registry.validateHostExtension({ id: "x", chatPanel: { enabled: () => true, width: 400 } }),
  ).toThrow("HOST_EXTENSION_INVALID: chatPanel.width is not a known field");
});
