import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createMemoryHistory, createRouter, isNotFound } from "@tanstack/react-router";
import type { HostExtension, NativeSectionId } from "@opengeni/react/app/host-extension";
import { describeSections, installNavMocks, organizationOwnerContext, renderInRouter, settingsRailSections } from "../../test/fixtures/host-extension-nav-harness";

const hidden: NativeSectionId[] = [];
const extension: HostExtension = { id: "host", hiddenNativeSections: hidden };
void mock.module("@opengeni/web-host-extension", () => ({ default: extension }));
GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await installNavMocks();
const { useSettingsRail } = await import("@/components/settings/settings-rail");
const { PrimaryNavExtras } = await import("@/components/rail/primary-nav");
const { isNativeCapabilityDetailHidden } = await import("@opengeni/react/app/host-extension");
const { settingsSearchEntries } = await import("@/components/settings/settings-search");
const { validateHostExtension } = await import("./registry");
const app = await import("../App");
await import("@/app-host");
afterAll(() => { mock.restore(); GlobalRegistrator.unregister(); });
beforeEach(() => { hidden.length = 0; });

const cases: readonly { id: NativeSectionId; item: string; url: string }[] = [
  { id: "workspace.access", item: "workspace:access", url: "settings?section=access" },
  { id: "workspace.api-keys", item: "workspace:api-keys", url: "settings?section=api-keys" },
  { id: "workspace.developer", item: "workspace:developer", url: "settings?section=developer" },
  { id: "workspace.models", item: "workspace:models", url: "settings?section=models" },
  { id: "organization.members", item: "organization:people", url: "organization?section=people" },
  { id: "organization.workspaces", item: "organization:workspaces", url: "organization?section=workspaces" },
  { id: "organization.mcp-clients", item: "organization:agents", url: "organization?section=agents" },
  { id: "capabilities.plugins", item: "workspace:plugins", url: "plugins?section=plugins" },
  { id: "capabilities.integrations", item: "workspace:connections", url: "plugins?section=connections" },
];
async function notFound(path: string) {
  const router = createRouter({ routeTree: app.routeTree, history: createMemoryHistory({ initialEntries: [`/workspaces/w1/${path}`] }) });
  await router.load();
  return router.state.matches.some((match) => isNotFound(match.error));
}
for (const row of cases) {
  test(`${row.id} is absent from rail and search and 404s by URL`, async () => {
    hidden.push(row.id);
    const sections = await settingsRailSections(useSettingsRail, organizationOwnerContext);
    const ids = describeSections(sections).flatMap((section) => section.groups.flat()).map((item) => item.id);
    expect(ids).not.toContain(row.item);
    expect(settingsSearchEntries(sections).map((entry) => entry.id)).not.toContain(row.item);
    expect(await notFound(row.url)).toBe(true);
  });
}
test("hiding plugin connect keeps Skills reachable", async () => {
  hidden.push("capabilities.plugins");
  expect(await notFound("plugins")).toBe(true);
  expect(await notFound("capabilities")).toBe(true);
  expect(await notFound("plugins?section=skills")).toBe(false);
  expect(await notFound("capabilities?section=skills")).toBe(false);
  expect(await notFound("plugins?section=connections")).toBe(false);
});
test("hiding workspace integrations keeps organization integrations visible", async () => {
  hidden.push("capabilities.integrations");
  expect(await notFound("plugins?section=integrations")).toBe(true);
  expect(await notFound("plugins?open=integration:slack")).toBe(true);
  expect(await notFound("plugins?open=service:github")).toBe(true);
  expect(await notFound("organization?section=integrations")).toBe(false);
  expect(await notFound("plugins?section=plugins")).toBe(false);
});
test("legacy organization and workspace aliases obey section hiding", async () => {
  hidden.push("organization.mcp-clients", "organization.members", "workspace.access");
  expect(await notFound("organization?section=mcp-clients")).toBe(true);
  expect(await notFound("organization?section=members")).toBe(true);
  expect(await notFound("settings?section=members")).toBe(true);
});
test("unknown or malformed hidden section values are refused by name", () => {
  for (const value of ["workspace.access", ["workspace.unknown"], [42]]) {
    expect(() => validateHostExtension({ id: "host", hiddenNativeSections: value })).toThrow("hiddenNativeSections");
  }
});
test("stock console without an extension is unchanged", async () => {
  expect(validateHostExtension({ id: "none" })).toEqual({ id: "none" });
  for (const row of cases) expect(await notFound(row.url)).toBe(false);
});

test("the primary Capabilities link opens Skills when the default Plugins page is hidden", async () => {
  hidden.push("capabilities.plugins");
  const view = await renderInRouter(() => <PrimaryNavExtras />);
  try {
    expect(view.container.querySelector('a[href="/workspaces/w1/plugins?section=skills"]')).not.toBeNull();
    expect(view.container.querySelector('a[href="/workspaces/w1/plugins"]')).toBeNull();
  } finally { await view.done(); }
});
test("catalog and package detail hiding keeps skill details independent", () => {
  expect(isNativeCapabilityDetailHidden("item:id", ["capabilities.integrations"], "mcp")).toBe(true);
  expect(isNativeCapabilityDetailHidden("item:id", ["capabilities.integrations"], "skill")).toBe(false);
  expect(isNativeCapabilityDetailHidden("package:plugin:id", ["capabilities.plugins"])).toBe(true);
  expect(isNativeCapabilityDetailHidden("package:skill:id", ["capabilities.plugins"])).toBe(false);
});
