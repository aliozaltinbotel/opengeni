import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  LearningRefusalActionsProvider,
  LearningRefusalRow,
  type LearningRefusalActions,
} from "./learning-refusal-row";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

function buttonsFor(actions: LearningRefusalActions): number {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <LearningRefusalActionsProvider {...actions}>
        <LearningRefusalRow refusal={{ destination: "knowledge", reason: "not_permitted" }} />
      </LearningRefusalActionsProvider>,
    ),
  );
  const count = container.querySelectorAll("button").length;
  act(() => root.unmount());
  return count;
}

describe("learning refusal row", () => {
  test("links to the place the change can be made", () => {
    expect(buttonsFor({ onOpen: () => undefined })).toBe(1);
  });

  test("offers no link to a place the app does not offer", () => {
    expect(buttonsFor({ onOpen: () => undefined, canOpen: () => false })).toBe(0);
    expect(
      buttonsFor({ onOpen: () => undefined, canOpen: (place) => place.kind !== "knowledge" }),
    ).toBe(0);
    expect(buttonsFor({ onOpen: () => undefined, canOpen: () => true })).toBe(1);
  });
});
