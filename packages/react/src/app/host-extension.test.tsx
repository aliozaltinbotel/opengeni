import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ToolCallItem } from "../timeline";
import { builtInToolRegistryEntries, defaultToolRegistry } from "../timeline/tool-renderers";
import { builtInToolCardNames } from "./built-in-tool-names";
import {
  composePrimaryNav,
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

  test("lists no name the default tool registry has no built-in card for", () => {
    const listed = [...builtInToolCardNames()];
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed)
      expect({ name, builtIn: rendersBuiltIn(name) }).toEqual({ name, builtIn: true });
  });

  test("an exact-only built-in name is not claimed behind another prefix", () => {
    expect(isBuiltInToolCardName("artifacts_create")).toBe(true);
    expect(isBuiltInToolCardName("evil__artifacts_create")).toBe(false);
    expect(isBuiltInToolCardName("evil__exec_command")).toBe(true);
  });
});

describe("composePrimaryNav", () => {
  const Icon = () => null;
  const native = [
    { id: "inbox", label: "Inbox" },
    { id: "plugins", label: "Capabilities" },
    { id: "state", label: "Knowledge" },
    { id: "automations", label: "Automations" },
    { id: "meetings", label: "Meetings" },
    { id: "artifacts", label: "Artifacts" },
  ] as const;
  const labels = (entries: readonly { label: string }[]) => entries.map((entry) => entry.label);

  test("stock: every native entry is a peer, in rail order", () => {
    const composed = composePrimaryNav({}, native);
    expect(composed.chat).toEqual([]);
    expect(composed.peers).toEqual([...native]);
  });

  test("an override relabels an entry and keeps its other fields", () => {
    const composed = composePrimaryNav(
      { navOverrides: [{ id: "plugins", label: "Agent skills" }] },
      [{ id: "plugins", label: "Capabilities", to: "/plugins" }],
    );
    expect(composed.peers).toEqual([{ id: "plugins", label: "Agent skills", to: "/plugins" }]);
  });

  test("chat moves entries next to New session in rail order; hidden leaves the rail", () => {
    const composed = composePrimaryNav(
      {
        navOverrides: [
          { id: "artifacts", group: "chat" },
          { id: "inbox", label: "Agent requests", group: "chat" },
          { id: "meetings", group: "hidden" },
        ],
      },
      native,
    );
    expect(labels(composed.chat)).toEqual(["Agent requests", "Artifacts"]);
    expect(labels(composed.peers)).toEqual(["Capabilities", "Knowledge", "Automations"]);
  });

  test("hidden destinations are left out and host primary items follow the native peers", () => {
    const composed = composePrimaryNav(
      {
        hiddenNativeDestinations: ["automations", "meetings"],
        nav: [
          { id: "ops", label: "Operations", icon: Icon, path: "operations", placement: "primary" },
          {
            id: "setup",
            label: "Setup",
            icon: Icon,
            path: "setup",
            placement: { settingsGroup: "host" },
          },
          {
            id: "later",
            label: "Later",
            icon: Icon,
            path: "later",
            placement: "primary",
            visible: () => false,
          },
        ],
      },
      native,
      { workspaceId: "w1", pathname: "/workspaces/w1/sessions" },
    );
    expect(labels(composed.peers)).toEqual([
      "Inbox",
      "Capabilities",
      "Knowledge",
      "Artifacts",
      "Operations",
    ]);
  });
});

describe("the resolvers outside a DOM", () => {
  test("a child process with no DOM composes the rail from the contract module", () => {
    const script = `
      const { composePrimaryNav } = await import(${JSON.stringify(
        new URL("./host-extension.tsx", import.meta.url).pathname,
      )});
      const composed = composePrimaryNav(
        { navOverrides: [{ id: "inbox", label: "Agent requests", group: "chat" }] },
        [{ id: "inbox", label: "Inbox" }, { id: "state", label: "Knowledge" }],
      );
      console.log(JSON.stringify({ composed }));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], { stderr: "pipe" });
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString())).toEqual({
      composed: {
        chat: [{ id: "inbox", label: "Agent requests" }],
        peers: [{ id: "state", label: "Knowledge" }],
      },
    });
  });
});
