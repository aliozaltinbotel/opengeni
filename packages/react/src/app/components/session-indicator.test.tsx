import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { configurePageAppHost } from "../lib/app-host";
import { validateHostExtension } from "../../../../../apps/web/src/host-extension/registry";

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => configurePageAppHost({ sessionIndicator: undefined }));
afterAll(() => GlobalRegistrator.unregister());

async function surface() {
  expect(existsSync(new URL("./session-indicator.tsx", import.meta.url))).toBe(true);
  return import("./session-indicator");
}
function Indicator({ workspaceId, sessionId }: { workspaceId: string; sessionId: string | null }) {
  return <p>{workspaceId}:{sessionId ?? "new"}</p>;
}

test("the host indicator renders on a session and on the new-chat page", async () => {
  const { HostSessionIndicatorFrame } = await surface();
  configurePageAppHost({ sessionIndicator: Indicator });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<><HostSessionIndicatorFrame workspaceId="w1" sessionId="s1"><p>Conversation</p></HostSessionIndicatorFrame><HostSessionIndicatorFrame workspaceId="w1" sessionId={null}><p>New chat</p></HostSessionIndicatorFrame></>));
    expect(container.textContent).toBe("w1:s1Conversationw1:newNew chat");
  } finally { await act(async () => root.unmount()); }
});
test("the indicator has no dismiss control", async () => {
  const { HostSessionIndicatorFrame } = await surface();
  configurePageAppHost({ sessionIndicator: Indicator });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HostSessionIndicatorFrame workspaceId="w1" sessionId="s1"><div data-pill-row><button>Leave context out</button></div></HostSessionIndicatorFrame>));
    const indicator = container.querySelector("[data-host-session-indicator]");
    expect(indicator).not.toBeNull();
    expect(indicator?.querySelector("button, [role=button]")).toBeNull();
    expect(container.querySelector("[data-pill-row]")?.contains(indicator)).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
test("stock console without an extension is unchanged", async () => {
  const { HostSessionIndicatorFrame } = await surface();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HostSessionIndicatorFrame workspaceId="w1" sessionId={null}><p>Composer</p></HostSessionIndicatorFrame>));
    expect(container.innerHTML).toBe("<p>Composer</p>");
  } finally { await act(async () => root.unmount()); }
});
test("every session route state and the new-chat route use the indicator frame", () => {
  for (const name of ["session", "sessions-index"]) {
    const source = readFileSync(new URL(`../routes/${name}.tsx`, import.meta.url), "utf8");
    expect(source).toContain("<HostSessionIndicatorFrame");
  }
});
test("malformed indicator components are refused at install by name", () => {
  for (const sessionIndicator of ["invalid", 42, { $$typeof: "unknown" }]) {
    expect(() => validateHostExtension({ id: "host", sessionIndicator })).toThrow("sessionIndicator");
  }
});
test("a failing host indicator preserves the native view and warns once", async () => {
  const { HostSessionIndicatorFrame, guardHostSessionIndicator } = await surface();
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  configurePageAppHost({ sessionIndicator: guardHostSessionIndicator(({ sessionId }) => {
    if (sessionId !== "good") throw new Error("host unavailable");
    return <p>Ready</p>;
  }) });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (sessionId: string) => root.render(<HostSessionIndicatorFrame workspaceId="w1" sessionId={sessionId}><p>Composer</p></HostSessionIndicatorFrame>);
  try {
    await act(async () => render("broken"));
    expect(container.textContent).toBe("Composer");
    await act(async () => render("broken-again"));
    expect(warning.mock.calls).toEqual([["HOST_SESSION_INDICATOR_FAILED"]]);
    await act(async () => render("good"));
    expect(container.textContent).toBe("ReadyComposer");
  } finally { await act(async () => root.unmount()); warning.mockRestore(); errors.mockRestore(); }
});

test("existing component fields retain their base validator while indicator validation is scoped", () => {
  const legacy = { $$typeof: "legacy-wrapper" };
  expect(() => validateHostExtension({ id: "host", brand: { mark: legacy, wordmark: legacy } })).not.toThrow();
  expect(() => validateHostExtension({ id: "host", sessionIndicator: legacy })).toThrow("sessionIndicator");
});
