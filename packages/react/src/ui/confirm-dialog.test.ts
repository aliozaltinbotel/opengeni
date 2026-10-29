import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniMessagesProvider } from "../messages/runtime";

let ConfirmDialog: typeof import("./confirm-dialog").ConfirmDialog;
let destructiveActionFocusTarget: typeof import("./confirm-dialog").destructiveActionFocusTarget;

beforeAll(async () => {
  GlobalRegistrator.register();
  // Radix selects its portal lifecycle when imported, after the DOM exists.
  ({ ConfirmDialog, destructiveActionFocusTarget } = await import("./confirm-dialog"));
});
afterAll(() => GlobalRegistrator.unregister());

test("startup dialog defaults render immediately and nested host copy still wins", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let finish: (() => void) | undefined;
  const dialog = createElement(ConfirmDialog, {
    open: true,
    onOpenChange: () => undefined,
    title: "Archive chat",
    description: "Pause this fixture chat.",
    confirmLabel: "Archive",
    onConfirm: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  try {
    await act(async () => root.render(dialog));
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toContain(
      "Cancel",
    );
    await act(async () =>
      root.render(
        createElement(
          OpenGeniMessagesProvider,
          {
            messages: {
              "formDialog.cancel": "Outer cancel",
              "formDialog.working": "Outer working",
            },
          },
          createElement(
            OpenGeniMessagesProvider,
            { messages: { "formDialog.cancel": "Inner cancel" } },
            dialog,
          ),
        ),
      ),
    );
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toContain(
      "Inner cancel",
    );
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Archive",
    );
    expect(confirm).toBeDefined();
    await act(async () => confirm?.click());
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toContain(
      "Outer working",
    );
    await act(async () => finish?.());
  } finally {
    finish?.();
    await act(async () => root.unmount());
    container.remove();
  }
});

describe("destructive action focus restoration", () => {
  test("returns the surviving trigger when the destructive action keeps it mounted", () => {
    const trigger = document.createElement("button");
    const fallback = document.createElement("section");
    document.body.append(trigger, fallback);

    expect(destructiveActionFocusTarget(trigger, fallback)).toBe(trigger);

    trigger.remove();
    fallback.remove();
  });

  test("returns a stable logical fallback after the focused trigger is removed", () => {
    const trigger = document.createElement("button");
    const fallback = document.createElement("section");
    fallback.tabIndex = -1;
    document.body.append(trigger, fallback);
    trigger.focus();
    trigger.remove();

    const target = destructiveActionFocusTarget(trigger, fallback);
    target?.focus();

    expect(target).toBe(fallback);
    expect(document.activeElement).toBe(fallback);

    fallback.remove();
  });

  test("uses the logical fallback when the surviving trigger becomes disabled", () => {
    const trigger = document.createElement("button");
    const fallback = document.createElement("section");
    fallback.tabIndex = -1;
    document.body.append(trigger, fallback);
    trigger.disabled = true;

    expect(destructiveActionFocusTarget(trigger, fallback)).toBe(fallback);

    trigger.remove();
    fallback.remove();
  });
});
