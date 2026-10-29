import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { reportCaughtError } from "../../lib/host-boundary-diagnostics";
import type { HostExtensionUtility } from "../../host-extension";
GlobalRegistrator.register({ url: "https://app.test" });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { configurePageAppHost } = await import("../../lib/app-host");
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = undefined; configurePageAppHost({ utilities: undefined }); });
afterAll(() => GlobalRegistrator.unregister());
const Icon = () => <svg aria-hidden="true" />;
function utility(id: string): HostExtensionUtility { return { id, label: id, icon: Icon, load: async () => ({ default: ({ workspaceId }) => <p>{id}:{workspaceId}</p> }) }; }
async function render(utilities: readonly HostExtensionUtility[] | undefined) {
  expect(existsSync(new URL("./host-utilities.tsx", import.meta.url))).toBe(true);
  const { HostRailUtilities } = await import("./host-utilities");
  configurePageAppHost({ utilities });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container, { onCaughtError: reportCaughtError });
  await act(async () => root?.render(<HostRailUtilities workspaceId="w1" collapsed={false} />));
  return container;
}
test("host utilities render in the utility area, at most 3", async () => {
  const view = await render([utility("one"), utility("two"), utility("three"), utility("four")]);
  expect([...view.querySelectorAll("[data-rail-utilities] button")].map((button) => button.getAttribute("aria-label"))).toEqual(["one", "two", "three"]);
});
test("a utility body loads only after selection and receives the current workspace", async () => {
  let loads = 0;
  const view = await render([{ ...utility("notifications"), load: async () => { loads += 1; return { default: ({ workspaceId }) => <p>Notifications:{workspaceId}</p> }; } }]);
  expect(loads).toBe(0);
  await act(async () => view.querySelector<HTMLButtonElement>("button")?.click());
  expect(loads).toBe(1);
  expect(document.body.textContent).toContain("Notifications:w1");
});
test("a failed utility load keeps the rail working and retries with one warning", async () => {
  let loads = 0;
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const view = await render([{ ...utility("notifications"), load: async () => { loads += 1; if (loads === 1) throw new Error("private host value"); return { default: () => <p>Recovered</p> }; } }]);
    await act(async () => view.querySelector<HTMLButtonElement>("button")?.click());
    const retry = document.querySelector<HTMLButtonElement>('button[aria-label="Retry notifications"]');
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());
    expect(document.body.textContent).toContain("Recovered");
    expect(loads).toBe(2);
    expect(warning.mock.calls).toEqual([["HOST_UTILITY_FAILED"]]);
    expect(view.querySelector("button")).not.toBeNull();
  } finally { warning.mockRestore(); errors.mockRestore(); }
});
test("utility placement is outside the rail scroll viewport and above its footer", () => {
  const source = readFileSync(new URL("./session-shell.tsx", import.meta.url), "utf8");
  expect(source.indexOf("<HostRailUtilities")).toBeGreaterThan(source.indexOf("Keep the persistent controls"));
  expect(source.indexOf("<HostRailUtilities")).toBeLessThan(source.indexOf("<div data-rail-footer"));
});
test("stock console without an extension is unchanged", async () => {
  const view = await render(undefined);
  expect(view.innerHTML).toBe("");
});

test("host icon and body render failures remain inside native utility controls", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const BrokenIcon = () => { throw new Error("private host icon value"); };
    const BrokenBody = () => { throw new Error("private host body value"); };
    const view = await render([{ ...utility("broken"), icon: BrokenIcon, load: async () => ({ default: BrokenBody }) }, utility("working")]);
    const triggers = view.querySelectorAll<HTMLButtonElement>("button");
    expect(triggers).toHaveLength(2);
    await act(async () => triggers[0]?.click());
    expect(document.querySelector('button[aria-label="Retry broken"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Retry broken"]')?.click());
    expect(document.querySelector('button[aria-label="Retry broken"]')).not.toBeNull();
    await act(async () => triggers[1]?.click());
    expect(document.body.textContent).toContain("working:w1");
    expect(errors).not.toHaveBeenCalled();
    expect(warning.mock.calls).toEqual([["HOST_UTILITY_FAILED"]]);
  } finally { warning.mockRestore(); errors.mockRestore(); }
});

test("repeated failures across the installed utilities warn once and sanitize load errors", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const load = async (): Promise<never> => { throw new Error("private host value"); };
    const view = await render([{ ...utility("first"), load }, { ...utility("second"), load }]);
    const triggers = view.querySelectorAll<HTMLButtonElement>("button");
    await act(async () => triggers[0]?.click());
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Retry first"]')?.click());
    await act(async () => triggers[1]?.click());
    expect(document.querySelector('button[aria-label="Retry second"]')).not.toBeNull();
    expect(warning.mock.calls).toEqual([["HOST_UTILITY_FAILED"]]);
    expect(errors.mock.calls.some((call) => call.some((value: unknown) => value instanceof Error && value.message.includes("private host value")))).toBe(false);
  } finally { warning.mockRestore(); errors.mockRestore(); }
});

test("a malformed lazy module offers native recovery", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    // Simulate a JavaScript host returning an invalid module across the typed API.
    const load = async () => JSON.parse('{"default":null}') as Awaited<ReturnType<HostExtensionUtility["load"]>>;
    const view = await render([{ ...utility("invalid"), load }]);
    await act(async () => view.querySelector<HTMLButtonElement>("button")?.click());
    expect(document.querySelector('button[aria-label="Retry invalid"]')).not.toBeNull();
    expect(warning.mock.calls).toEqual([["HOST_UTILITY_FAILED"]]);
  } finally { warning.mockRestore(); errors.mockRestore(); }
});

test("switching workspace closes the old utility body and loads the new workspace only on selection", async () => {
  let loads = 0;
  const utilities = [{ ...utility("notifications"), load: async () => { loads += 1; return { default: ({ workspaceId }: { workspaceId: string }) => <p>Notifications:{workspaceId}</p> }; } }];
  const view = await render(utilities);
  const { HostRailUtilities } = await import("./host-utilities");
  await act(async () => view.querySelector<HTMLButtonElement>("button")?.click());
  expect(document.body.textContent).toContain("Notifications:w1");
  expect(loads).toBe(1);
  await act(async () => root?.render(<HostRailUtilities workspaceId="w2" collapsed={false} />));
  expect(document.body.textContent).not.toContain("Notifications:w1");
  expect(document.body.textContent).not.toContain("Notifications:w2");
  expect(view.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  expect(loads).toBe(1);
  await act(async () => view.querySelector<HTMLButtonElement>("button")?.click());
  expect(document.body.textContent).toContain("Notifications:w2");
  expect(loads).toBe(2);
});

test("ordinary recovery boundaries retain the original error and React component stack", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  const ordinaryError = new Error("ordinary component failed");
  const Broken = () => { throw ordinaryError; };
  try {
    await render(undefined);
    const { FailureRecoveryBoundary } = await import("../session/failure-recovery-boundary");
    await act(async () => root?.render(<FailureRecoveryBoundary fallback={<p>Ordinary fallback</p>}><Broken /></FailureRecoveryBoundary>));
    expect(container?.textContent).toBe("Ordinary fallback");
    const diagnostic = errors.mock.calls.find((call) => call[0] === ordinaryError);
    expect(diagnostic).toHaveLength(2);
    expect(typeof diagnostic?.[1]).toBe("string");
    expect(diagnostic?.[1]).toContain("Broken");
    expect(diagnostic?.[1]).toContain("FailureRecoveryBoundary");
  } finally { errors.mockRestore(); }
});
