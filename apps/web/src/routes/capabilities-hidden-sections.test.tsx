import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { LineTabs, LineTabsList, LineTabsTrigger } from "@opengeni/react/ui/line-tabs";
import type { NativeSectionId } from "@opengeni/react/app/host-extension";
import * as capabilities from "./capabilities";

beforeAll(() => { GlobalRegistrator.register(); globalThis.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => GlobalRegistrator.unregister());
async function tabs(hidden: readonly NativeSectionId[], selected = "all") {
  expect(capabilities).toHaveProperty("CapabilitiesTabList");
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<LineTabs value={selected}><capabilities.CapabilitiesTabList hidden={hidden} /></LineTabs>));
  return { container, done: async () => { await act(async () => root.unmount()); } };
}
test("hidden Connections and Plugins tabs are independent and Skills remains available", async () => {
  for (const [hidden, labels] of [
    [["capabilities.integrations"], ["All", "Skills", "Plugins"]],
    [["capabilities.plugins"], ["Connections", "Skills"]],
    [["capabilities.integrations", "capabilities.plugins"], ["Skills"]],
  ] as const) {
    const view = await tabs(hidden, "skills");
    try { expect([...view.container.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([...labels]); }
    finally { await view.done(); }
  }
});
test("the default Plugins view keeps all native tabs and All selected", async () => {
  const view = await tabs([]);
  const reference = document.createElement("div");
  const root = createRoot(reference);
  try {
    await act(async () => root.render(<LineTabs value="all"><LineTabsList aria-label="Capability types"><LineTabsTrigger value="all">All</LineTabsTrigger><LineTabsTrigger value="connections">Connections</LineTabsTrigger><LineTabsTrigger value="skills">Skills</LineTabsTrigger><LineTabsTrigger value="plugins">Plugins</LineTabsTrigger></LineTabsList></LineTabs>));
    const normalize = (html: string) => html.replace(/\s(?:id|aria-controls|aria-labelledby)="[^"]*"/g, "");
    expect(normalize(view.container.innerHTML)).toBe(normalize(reference.innerHTML));
    expect(view.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("All");
  } finally { await view.done(); await act(async () => root.unmount()); }
});
test("a tab change replaces the URL while preserving unrelated search parameters", () => {
  expect(capabilities).toHaveProperty("capabilitiesTabNavigation");
  expect(capabilities.capabilitiesTabNavigation("/workspaces/w1/plugins", "?query=hello", "connections")).toEqual({ href: "/workspaces/w1/plugins?query=hello&section=connections", replace: true });
  expect(capabilities.capabilitiesTabNavigation("/workspaces/w1/plugins", "?section=skills&query=hello", "all")).toEqual({ href: "/workspaces/w1/plugins?query=hello", replace: true });
});
