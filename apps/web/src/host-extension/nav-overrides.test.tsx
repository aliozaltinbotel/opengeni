// A host extension's native rail overrides: a relabelled entry keeps its row
// under the new name in every rail form (expanded, collapsed, folded under
// More), an entry moved to chat renders in its own group right after "New
// session" (with a rule before the peers), and an entry left off the rail is
// gone from it. The stock rail is unchanged (nav-stock.test.tsx).
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { HostExtension } from "@opengeni/react/app/host-extension";

import { hostExtensionFixture } from "../../test/fixtures/host-extension-fixture";
import {
  indicators,
  installNavMocks,
  installViewportMatchMedia,
  rail,
  renderInRouter,
  setViewportHeight,
} from "../../test/fixtures/host-extension-nav-harness";

const extension: HostExtension = {
  ...hostExtensionFixture,
  navOverrides: [
    { id: "inbox", label: "Agent requests", group: "chat" },
    { id: "artifacts", group: "chat" },
    { id: "meetings", group: "hidden" },
    { id: "plugins", label: "Agent skills" },
    { id: "state", label: "Know-how" },
  ],
};
void mock.module("@opengeni/web-host-extension", () => ({ default: extension }));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
await installNavMocks();
await import("./startup");
const { PrimaryNavExtras, WorkspaceShortcutLinks } = await import("@/components/rail/primary-nav");

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

function labels(root: Element): string[] {
  return Array.from(root.querySelectorAll("a")).map(
    (link) => link.getAttribute("aria-label") ?? link.textContent ?? "",
  );
}

async function rendered(node: () => React.ReactNode) {
  const view = await renderInRouter(node);
  const container = view.container;
  const chat = container.querySelector('[role="group"][aria-label="Chat"]');
  const separator = container.querySelector('[role="separator"]');
  const result = {
    chat: chat ? labels(chat) : null,
    all: labels(container),
    separatorAfterChat: Boolean(
      chat &&
      separator &&
      chat.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  };
  await view.done();
  return result;
}

describe("native rail overrides", () => {
  test("relabelled entries move to chat, in their own group before a rule; hidden ones leave", async () => {
    const view = await rendered(() => <PrimaryNavExtras />);
    expect(view.chat).toEqual(["Agent requests", "Artifacts"]);
    expect(view.separatorAfterChat).toBe(true);
    expect(view.all).toEqual([
      "Agent requests",
      "Artifacts",
      "Agent skills",
      "Know-how",
      "Automations",
      "Today",
    ]);
  });

  test("the collapsed rail's shortcuts carry the new labels and leave chat and hidden entries out", async () => {
    rail.collapsed = true;
    const view = await rendered(() => <WorkspaceShortcutLinks />);
    expect(view.chat).toBeNull();
    expect(view.all).toEqual(["Agent skills", "Know-how", "Automations", "Today"]);
  });

  test("a short window's folded shortcuts show a waiting entry under its new label", async () => {
    setViewportHeight(600);
    indicators.pendingKnowledge = true;
    const view = await rendered(() => <PrimaryNavExtras />);
    expect(view.chat).toEqual(["Agent requests", "Artifacts"]);
    expect(view.all).toContain("Know-how, needs review");
    expect(view.all).not.toContain("Knowledge, needs review");
  });
});
