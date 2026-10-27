import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { isWorkspaceSegmentHidden, nativeDestinationsOfSegment } from "./host-extension";
import { AppHostProvider, useNativeDestinationVisible, type AppHost } from "./lib/app-host";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

describe("hidden native destinations", () => {
  test("a destination's own segment opens it", () => {
    expect(nativeDestinationsOfSegment("automations")).toEqual(["automations"]);
    expect(nativeDestinationsOfSegment("computer-use")).toEqual(["computer-use"]);
  });

  test("a legacy segment opens the destination it redirects to", () => {
    expect(nativeDestinationsOfSegment("schedules")).toEqual(["automations"]);
    expect(nativeDestinationsOfSegment("capabilities")).toEqual(["plugins"]);
    expect(nativeDestinationsOfSegment("documents")).toEqual(["state"]);
    expect(nativeDestinationsOfSegment("memory")).toEqual(["state"]);
    expect(nativeDestinationsOfSegment("variable-sets")).toEqual(["variable-sets", "secrets"]);
    expect(nativeDestinationsOfSegment("environments")).toEqual(["environments", "secrets"]);
  });

  test("sessions, settings and unknown segments open no hideable destination", () => {
    for (const segment of ["sessions", "settings", "organization", "inbox", "sites", "pms", ""]) {
      expect(nativeDestinationsOfSegment(segment)).toEqual([]);
    }
  });

  test("a segment is hidden when any destination it opens is", () => {
    expect(isWorkspaceSegmentHidden("schedules", ["automations"])).toBe(true);
    expect(isWorkspaceSegmentHidden("variable-sets", ["secrets"])).toBe(true);
    expect(isWorkspaceSegmentHidden("secrets", ["variable-sets"])).toBe(false);
    expect(isWorkspaceSegmentHidden("sessions", ["automations", "secrets"])).toBe(false);
    expect(isWorkspaceSegmentHidden("automations", [])).toBe(false);
  });

  test("the session UI reads the hidden set from its app host, nothing hidden by default", () => {
    const seen: Record<string, boolean> = {};
    function Capture() {
      seen.automations = useNativeDestinationVisible("automations");
      seen.secrets = useNativeDestinationVisible("secrets");
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Capture />));
    expect(seen).toEqual({ automations: true, secrets: true });
    act(() =>
      root.render(
        <AppHostProvider host={{ hiddenNativeDestinations: ["secrets"] } as unknown as AppHost}>
          <Capture />
        </AppHostProvider>,
      ),
    );
    expect(seen).toEqual({ automations: true, secrets: false });
    act(() => root.unmount());
  });
});
