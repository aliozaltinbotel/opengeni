import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { configurePageAppHost } from "../lib/app-host";
import { useMemoryNavigation } from "../embed/memory-navigation";
import type { NavigateFunction } from "../lib/navigation";
import type { HostExtension } from "../host-extension";
import * as registry from "../../../../../apps/web/src/host-extension/registry";
import { ADD_AGENT_DEFAULT_PROMPT, NEW_SESSION_STARTERS, NewSessionStarters } from "./new-session-starters";

let priorActEnvironmentDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  priorActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  try {
    GlobalRegistrator.unregister();
  } finally {
    if (priorActEnvironmentDescriptor) {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorActEnvironmentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  }
});

test("six always-visible suggestions emit only editable prompt text on explicit click", async () => {
  const onSelect = mock((_prompt: string) => {});
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<NewSessionStarters onSelect={onSelect} />));
    expect(onSelect).not.toHaveBeenCalled();
    expect(container.querySelector("h2")?.textContent).toBe("Suggestions");
    expect(container.querySelectorAll("button")).toHaveLength(6);
    expect(container.querySelector("select, [role=combobox], details, a")).toBeNull();
    const buttons = [...container.querySelectorAll("button")];
    for (const [index, starter] of NEW_SESSION_STARTERS.entries()) {
      const button = buttons[index]!;
      expect(button.type).toBe("button");
      expect(button.textContent).toBe(starter.title + starter.description);
      expect(button.classList.contains("h-full")).toBe(true);
      await act(async () => button.click());
      expect(onSelect.mock.calls[index]).toEqual([starter.prompt]);
    }
    expect(onSelect).toHaveBeenCalledTimes(6);
    const marks = buttons.map((button) => button.querySelector("img, svg")!);
    expect(marks.slice(0, 3).every((mark) => mark.classList.contains("size-8"))).toBe(true);
    expect(marks.slice(3).every((mark) => mark.classList.contains("size-5"))).toBe(true);
    expect(marks.every((mark) => mark.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(marks[1]!.getAttribute("fill")).toBe("currentColor");
    expect(buttons[0]!.parentElement?.classList.contains("auto-rows-fr")).toBe(true);

    await act(async () => root.render(<NewSessionStarters onSelect={onSelect} disabled />));
    expect(container.querySelectorAll("button:disabled")).toHaveLength(6);
    await act(async () => container.querySelector("button")!.click());
    expect(onSelect).toHaveBeenCalledTimes(6);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("route keeps suggestions below recent sessions and uses the ordinary draft/send boundary", () => {
  const route = readFileSync(new URL("../routes/sessions-index.tsx", import.meta.url), "utf8");
  expect(route.indexOf("<NewSessionStarters")).toBeGreaterThan(route.indexOf("<RecentSessions"));
  expect(route).toContain('data-workspace-scroll-owner="self-managed"');
  expect(route).toContain("[&_textarea]:min-h-[calc(2lh+1rem)]");
  expect(route).toContain('querySelector("textarea")?.focus({ preventScroll: true })');
  expect(route).toContain("setMessage(prompt)");
  expect(route).toContain("value: message");
  expect(route).toContain("setValue: setMessage");
  // Visibility and where it runs are "+" drill-ins, not controls under the composer.
  expect(route).toContain("<VisibilityMenuBody");
  expect(route).toContain("<RunsOnMenuBody");
  expect(route).toContain("<ComputeTargetControl");
});

test("without the chat list, the new-chat page shows no recent chats or project picker", () => {
  const route = readFileSync(new URL("../routes/sessions-index.tsx", import.meta.url), "utf8");
  expect(route).toContain('const chatList = useSessionUiFeature("chatList");');
  expect(route).toContain("{chatList ? <RecentSessions workspaceId={workspaceId} /> : null}");
  expect(route).toMatch(/chatList \? \(\s*<SessionSetupStrip/);
});

afterEach(() => configurePageAppHost({ starters: undefined }));

async function hostStarters(
  run: (container: HTMLDivElement, navigate: NavigateFunction) => Promise<void>,
  source: NonNullable<HostExtension["starters"]> = (context) => [{ id: "host", label: context.pathname, prompt: "Help with this page" }],
  expectedPrompt: string | null = "Help with this page",
) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let navigate: NavigateFunction | undefined;
  expect(registry).toHaveProperty("createHostStartersResolver");
  const resolved = registry.createHostStartersResolver(source);
  const selected: string[] = [];
  function Harness() {
    const navigation = useMemoryNavigation({ initialPath: "/workspaces/w1/sessions", consoleOrigin: "https://example.test", handles: () => true });
    navigate = navigation.useNavigate();
    configurePageAppHost({ starters: resolved, navigation });
    return <NewSessionStarters workspaceId="w1" set="product" onSelect={(prompt) => selected.push(prompt)} />;
  }
  try {
    await act(async () => root.render(<Harness />));
    expect(navigate).toBeDefined();
    await run(container, (options) => { if (!navigate) throw new Error("not mounted"); return navigate(options); });
    await act(async () => container.querySelector("button")?.click());
    expect(selected).toEqual(expectedPrompt === null ? [] : [expectedPrompt]);
  } finally { await act(async () => root.unmount()); }
}

test("host starters replace the developer list", async () => {
  await hostStarters(async (container) => {
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.textContent).not.toContain("Connect GitHub");
    expect(container.textContent).not.toContain("Add an agent");
  });
});
test("starters follow the context's pathname", async () => {
  await hostStarters(async (container, navigate) => {
    expect(container.textContent).toContain("/workspaces/w1/sessions");
    await act(async () => navigate({ to: "/workspaces/w1/overview" }));
    expect(container.textContent).toContain("/workspaces/w1/overview");
  });
});
test("a starters callback that throws falls back to the built-in list", async () => {
  await hostStarters(async (container) => {
    expect(container.querySelectorAll("button, a[data-starter]")).toHaveLength(6);
    expect(container.textContent).toContain("Add an agent");
  }, () => { throw new Error("host unavailable"); }, ADD_AGENT_DEFAULT_PROMPT);
});
test("duplicate ids or more than 8 fall back and warn once", async () => {
  const starter = { id: "same", label: "Starter", prompt: "Help" };
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const items of [[starter, starter], Array.from({ length: 9 }, (_, i) => ({ ...starter, id: String(i) }))]) {
      warning.mockClear();
      await hostStarters(async (container, navigate) => {
        expect(container.querySelectorAll("button, a[data-starter]")).toHaveLength(6);
        await act(async () => navigate({ to: "/workspaces/w1/next" }));
        expect(warning.mock.calls).toEqual([["HOST_STARTERS_FAILED"]]);
      }, () => items, ADD_AGENT_DEFAULT_PROMPT);
    }
  } finally { warning.mockRestore(); }
});
test("installation never invokes a workspace-dependent starter callback", () => {
  let calls = 0;
  expect(() => registry.validateHostExtension({ id: "host", starters: () => { calls += 1; throw new Error("workspace required"); } })).not.toThrow();
  expect(calls).toBe(0);
});
test("an intentional empty host list shows no starters", async () => {
  await hostStarters(async (container) => expect(container.querySelectorAll("button, a[data-starter]")).toHaveLength(0), () => [], null);
});
test("stock console without an extension is unchanged", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<NewSessionStarters onSelect={() => undefined} />));
    expect(container.querySelectorAll("button")).toHaveLength(6);
    expect(container.textContent).toContain("Connect GitHub");
  } finally { await act(async () => root.unmount()); }
});
