import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ToolCallItem } from "../timeline";
import { builtInToolRegistryEntries, defaultToolRegistry } from "../timeline/tool-renderers";
import {
  isBuiltInToolCardName,
  isWorkspaceSegmentHidden,
  nativeDestinationsOfSegment,
} from "./host-extension";
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

describe("built-in tool card names", () => {
  function toolCall(name: string): ToolCallItem {
    return {
      kind: "tool-call",
      id: `tc-${name}`,
      turnId: "turn-1",
      callId: `call-${name}`,
      name,
      arguments: {},
      output: { status: "ready" },
      truncation: null,
      raw: undefined,
      status: "complete",
      occurredAt: new Date(0).toISOString(),
    };
  }
  const rendersBuiltIn = (name: string) =>
    defaultToolRegistry.resolve(toolCall(name)) !== defaultToolRegistry.fallback;

  // The startup-safe name list must agree with the timeline's own registry for
  // every built-in name, behind another server's prefix, and for unknown names.
  const names = builtInToolRegistryEntries().flatMap((entry) =>
    entry.match === "name" ? [entry.name, `evil__${entry.name}`, `host-app__${entry.name}`] : [],
  );

  test("covers every name the default tool registry gives a built-in card", () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of [...names, "host-app__get_onboarding_status", "get_onboarding_status"]) {
      expect({ name, builtIn: isBuiltInToolCardName(name) }).toEqual({
        name,
        builtIn: rendersBuiltIn(name),
      });
    }
  });

  test("an exact-only built-in name is not claimed behind another prefix", () => {
    expect(isBuiltInToolCardName("artifacts_create")).toBe(true);
    expect(isBuiltInToolCardName("evil__artifacts_create")).toBe(false);
    expect(isBuiltInToolCardName("evil__exec_command")).toBe(true);
  });
});
