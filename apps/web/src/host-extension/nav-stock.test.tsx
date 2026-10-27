// With the stock stub (no extension configured) the primary nav and the
// settings rail are exactly the stock ones. The snapshots were recorded from
// the console before the host extension nav existed.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  describeSections,
  indicators,
  installNavMocks,
  installViewportMatchMedia,
  rail,
  renderInRouter,
  setViewportHeight,
  settingsRailSections,
} from "../../test/fixtures/host-extension-nav-harness";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await installNavMocks();
const { PrimaryNavExtras, WorkspaceShortcutLinks } = await import("@/components/rail/primary-nav");
const { useSettingsRail } = await import("@/components/settings/settings-rail");
const { settingsSearchEntries } = await import("@/components/settings/settings-search");

let restoreMatchMedia: () => void = () => undefined;
beforeAll(() => {
  restoreMatchMedia = installViewportMatchMedia();
});
afterAll(() => {
  restoreMatchMedia();
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  setViewportHeight(900);
  rail.collapsed = false;
  indicators.pendingKnowledge = false;
  indicators.scheduleAttention = false;
});

async function html(node: () => React.ReactNode): Promise<string> {
  const view = await renderInRouter(node);
  const markup = view.container.innerHTML;
  await view.done();
  return markup;
}

describe("stock primary nav and settings rail", () => {
  test("the expanded primary nav is the stock one", async () => {
    expect(await html(() => <PrimaryNavExtras />)).toMatchSnapshot();
  });

  test("the collapsed rail's shortcuts are the stock ones", async () => {
    rail.collapsed = true;
    expect(await html(() => <WorkspaceShortcutLinks />)).toMatchSnapshot();
  });

  test("a short window's folded shortcuts, with knowledge and automations waiting, are the stock ones", async () => {
    setViewportHeight(600);
    indicators.pendingKnowledge = true;
    indicators.scheduleAttention = true;
    expect(await html(() => <PrimaryNavExtras />)).toMatchSnapshot();
  });

  test("the settings rail and its search are the stock ones", async () => {
    const sections = await settingsRailSections(useSettingsRail);
    expect(describeSections(sections)).toMatchSnapshot();
    expect(settingsSearchEntries(sections).map((entry) => entry.id)).toMatchSnapshot();
  });
});
