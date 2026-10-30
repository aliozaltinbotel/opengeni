/* ----------------------------------------------------------------------------
   The session view's tool registry: a host extension's tool cards render for
   their exact tool name only, ahead of the built-in renderers. A call whose
   name merely ends in the same leaf behind another MCP server prefix gets the
   generic renderer. Without host entries, the timeline keeps the shared
   default registry, exactly as stock. A host loader's cards arrive on demand:
   until it settles an unknown call shows the generic renderer, then open
   chats redraw with the loaded card.
   -------------------------------------------------------------------------- */
import { describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { act, type ReactNode } from "react";

import {
  createHostExtensionSlot,
  createHostToolRegistryLoader,
} from "../../../../../apps/web/src/host-extension/registry";

import { registerDom, renderComponent } from "../../../test/render-hook";
import { MessageTimeline } from "../../components/message-timeline";
import {
  defaultToolRegistry,
  type ToolCallItem,
  type ToolRegistry,
  type ToolRegistryEntry,
  type ToolRendererProps,
} from "../../timeline";
import type { HostToolRegistryEntry } from "../host-extension";
import { AppHostProvider, type AppHost } from "../lib/app-host";
import { useHostToolRegistry } from "../lib/host-tool-registry";

registerDom();

const HOST_TOOL = "host-app__get_onboarding_status";

function FixtureCard({ item }: ToolRendererProps) {
  return <p data-testid="fixture-card">Fixture card for {item.name}</p>;
}

const fixtureEntry: ToolRegistryEntry = {
  match: "name",
  name: HOST_TOOL,
  render: FixtureCard,
  matchPrefixedLeaf: false,
};

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

/**
 * Each `<name …>` opening tag in a TSX source, up to the `>` that closes it:
 * a `>` inside a `{…}` prop expression (an arrow, a comparison) or inside a
 * quoted attribute value does not end the tag.
 */
function openingTags(source: string, name: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(new RegExp(`<${name}(?=[\\s/>])`, "g"))) {
    let depth = 0;
    let quote: string | null = null;
    for (let index = match.index + match[0].length; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      } else if (depth === 0 && (char === '"' || char === "'")) {
        quote = char;
      } else if (depth === 0 && char === ">") {
        tags.push(source.slice(match.index, index + 1));
        break;
      }
    }
  }
  return tags;
}

function SessionTimeline({ items }: { items: ToolCallItem[] }) {
  return <MessageTimeline items={items} toolRegistry={useHostToolRegistry()} />;
}

function withHost(
  entries: readonly ToolRegistryEntry[],
  node: ReactNode,
  toolRegistryLoader?: AppHost["toolRegistryLoader"],
) {
  const host = { toolRegistryEntries: entries, toolRegistryLoader } as unknown as AppHost;
  return <AppHostProvider host={host}>{node}</AppHostProvider>;
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets a settled loader reach the store and the timeline re-render. */
async function settleLoader(): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

function fixtureCards(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="fixture-card"]')].map(
    (card) => card.textContent ?? "",
  );
}

describe("session tool registry", () => {
  test("an exact host-prefixed entry for a built-in leaf installs and renders the host card", async () => {
    for (const leaf of ["knowledge_search", "memory_propose"]) {
      const name = `mcp_0123456789abcdef__${leaf}`;
      const slot = createHostExtensionSlot();
      slot.install({ id: "fixture", toolRegistryEntries: [{ ...fixtureEntry, name }] });
      const view = await renderComponent(
        withHost(
          slot.current().toolRegistryEntries ?? [],
          <SessionTimeline items={[toolCall(name)]} />,
        ),
      );
      try {
        expect(view.container.querySelector('[data-testid="fixture-card"]')?.textContent).toBe(
          `Fixture card for ${name}`,
        );
      } finally {
        await view.unmount();
      }
    }
  });

  test("bare knowledge_search still renders the built-in card", async () => {
    let resolved: ToolRegistry | undefined;
    function Probe() {
      resolved = useHostToolRegistry();
      return null;
    }
    const slot = createHostExtensionSlot();
    slot.install({
      id: "fixture",
      toolRegistryEntries: [
        {
          ...fixtureEntry,
          name: "mcp_0123456789abcdef__knowledge_search",
        },
        { ...fixtureEntry, name: "mcp_0123456789abcdef__memory_propose" },
      ],
    });
    const names = [
      "knowledge_search",
      "memory_propose",
      "mcp_fedcba9876543210__knowledge_search",
      "mcp_fedcba9876543210__memory_propose",
    ];
    const view = await renderComponent(
      withHost(
        slot.current().toolRegistryEntries ?? [],
        <>
          <Probe />
          <SessionTimeline items={names.map(toolCall)} />
        </>,
      ),
    );
    try {
      for (const name of names) {
        const native = defaultToolRegistry.resolve(toolCall(name));
        expect(native).not.toBe(defaultToolRegistry.fallback);
        expect(resolved?.resolve(toolCall(name))).toBe(native);
      }
      expect(view.container.querySelector('[data-testid="fixture-card"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("a host entry renders its card for that exact tool call", async () => {
    const view = await renderComponent(
      withHost([fixtureEntry], <SessionTimeline items={[toolCall(HOST_TOOL)]} />),
    );
    try {
      const card = view.container.querySelector('[data-testid="fixture-card"]');
      expect(card?.textContent).toBe(`Fixture card for ${HOST_TOOL}`);
    } finally {
      await view.unmount();
    }
  });

  test.each(["evil__get_onboarding_status", `evil__${HOST_TOOL}`])(
    "a call named %s renders the generic renderer",
    async (name) => {
      let resolved: ToolRegistry | undefined;
      function Probe() {
        resolved = useHostToolRegistry();
        return null;
      }
      const view = await renderComponent(
        withHost(
          [fixtureEntry],
          <>
            <Probe />
            <SessionTimeline items={[toolCall(name)]} />
          </>,
        ),
      );
      try {
        expect(resolved?.resolve(toolCall(name))).toBe(defaultToolRegistry.fallback);
        expect(view.container.querySelector('[data-testid="fixture-card"]')).toBeNull();
      } finally {
        await view.unmount();
      }
    },
  );

  test("stock console without an extension is unchanged", async () => {
    const seen: ToolRegistry[] = [];
    function Probe() {
      seen.push(useHostToolRegistry());
      return null;
    }
    const view = await renderComponent(
      <>
        <Probe />
        {withHost([], <Probe />)}
      </>,
    );
    try {
      expect(seen.length).toBeGreaterThanOrEqual(2);
      for (const registry of seen) expect(registry).toBe(defaultToolRegistry);
    } finally {
      await view.unmount();
    }
  });

  test("the session page passes the host tool registry to its timeline", async () => {
    const source = await readFile(new URL("./session.tsx", import.meta.url), "utf8");
    expect(source).toContain("const toolRegistry = useHostToolRegistry();");
    const tags = openingTags(source, "MessageTimeline");
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toMatch(/\stoolRegistry=\{toolRegistry\}/);
  });

  test("the opening-tag scan reads past arrow props and stops before the children", () => {
    const [afterArrow] = openingTags(
      "<MessageTimeline\n  onOpen={() => open(a > b)}\n  toolRegistry={toolRegistry}\n/>",
      "MessageTimeline",
    );
    expect(afterArrow).toMatch(/\stoolRegistry=\{toolRegistry\}/);
    const [withChild] = openingTags(
      '<MessageTimeline items={items} label="a > b">\n  <Inner toolRegistry={toolRegistry} />\n</MessageTimeline>',
      "MessageTimeline",
    );
    expect(withChild).toBe('<MessageTimeline items={items} label="a > b">');
  });
});

describe("lazily loaded tool cards", () => {
  test("a lazily loaded entry renders its card", async () => {
    const loader = async () => [fixtureEntry];
    const view = await renderComponent(
      withHost([], <SessionTimeline items={[toolCall(HOST_TOOL)]} />, loader),
    );
    try {
      await settleLoader();
      expect(fixtureCards(view.container)).toEqual([`Fixture card for ${HOST_TOOL}`]);
    } finally {
      await view.unmount();
    }
  });

  test("a loaded entry colliding with a built-in is refused like an install-time one", async () => {
    const colliding = [
      { ...fixtureEntry, name: "knowledge_search" },
      { ...fixtureEntry, name: "opengeni__knowledge_save" },
      { ...fixtureEntry, name: "other__exec_command" },
      { ...fixtureEntry, matchPrefixedLeaf: true },
    ];
    for (const [index, entry] of colliding.entries()) {
      expect(() =>
        createHostExtensionSlot().install({ id: "fixture", toolRegistryEntries: [entry] }),
      ).toThrow(
        `HOST_EXTENSION_INVALID: toolRegistryEntries[0].${index < 3 ? "name" : "matchPrefixedLeaf"}`,
      );
    }
    const loaded = [
      ...colliding,
      { ...fixtureEntry, name: `mcp_0123456789abcdef__memory_propose` },
    ];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let resolved: ToolRegistry | undefined;
    function Probe() {
      resolved = useHostToolRegistry();
      return null;
    }
    // A built bundle is untyped at runtime: it can return entries its types rule out.
    const loader = createHostToolRegistryLoader(
      async () => loaded as unknown as readonly HostToolRegistryEntry[],
      [],
    );
    const names = [
      "knowledge_search",
      "opengeni__knowledge_save",
      "other__exec_command",
      HOST_TOOL,
    ];
    const view = await renderComponent(
      withHost(
        [],
        <>
          <Probe />
          <SessionTimeline
            items={[...names, "mcp_0123456789abcdef__memory_propose"].map(toolCall)}
          />
        </>,
        loader,
      ),
    );
    try {
      await settleLoader();
      for (const name of names) {
        expect(resolved?.resolve(toolCall(name))).toBe(defaultToolRegistry.resolve(toolCall(name)));
      }
      expect(fixtureCards(view.container)).toEqual([
        "Fixture card for mcp_0123456789abcdef__memory_propose",
      ]);
      expect(warn.mock.calls).toEqual([
        [
          "HOST_TOOL_REGISTRY_ENTRY_REFUSED",
          [
            "toolRegistryLoader[0].name",
            "toolRegistryLoader[1].name",
            "toolRegistryLoader[2].name",
            "toolRegistryLoader[3].matchPrefixedLeaf",
          ],
        ],
      ]);
    } finally {
      warn.mockRestore();
      await view.unmount();
    }
  });

  test("no loader means today's behaviour", async () => {
    const seen: ToolRegistry[] = [];
    function Probe() {
      seen.push(useHostToolRegistry());
      return null;
    }
    const entries = [fixtureEntry];
    const tree = (
      <>
        {withHost([], <Probe />)}
        {withHost(entries, <Probe />)}
      </>
    );
    const view = await renderComponent(tree);
    try {
      await view.rerender(tree);
      const stock = seen.filter((_, index) => index % 2 === 0);
      const hosted = seen.filter((_, index) => index % 2 === 1);
      for (const registry of stock) expect(registry).toBe(defaultToolRegistry);
      for (const registry of hosted) expect(registry).toBe(hosted[0] as ToolRegistry);
      const registry = hosted[0];
      expect(registry?.resolve(toolCall(HOST_TOOL))).toBe(FixtureCard);
      expect(registry?.resolve(toolCall("evil__get_onboarding_status"))).toBe(
        defaultToolRegistry.fallback,
      );
      const leaf = "mcp_fedcba9876543210__knowledge_search";
      expect(registry?.resolve(toolCall(leaf))).toBe(defaultToolRegistry.resolve(toolCall(leaf)));
    } finally {
      await view.unmount();
    }
  });

  test("a failing loader falls back once and warns", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const loader = () => {
      calls += 1;
      return Promise.reject(new Error("secret host detail"));
    };
    let resolved: ToolRegistry | undefined;
    function Probe() {
      resolved = useHostToolRegistry();
      return null;
    }
    const first = (
      <>
        <Probe />
        <SessionTimeline items={[toolCall(HOST_TOOL)]} />
      </>
    );
    const view = await renderComponent(withHost([], first, loader));
    try {
      await settleLoader();
      await view.rerender(
        withHost(
          [],
          <>
            <Probe />
            <SessionTimeline items={[toolCall(HOST_TOOL), toolCall("other__unknown_tool")]} />
          </>,
          loader,
        ),
      );
      await settleLoader();
      expect(resolved?.resolve(toolCall(HOST_TOOL))).toBe(defaultToolRegistry.fallback);
      expect(fixtureCards(view.container)).toEqual([]);
      expect(calls).toBe(1);
      expect(warn.mock.calls).toEqual([["HOST_TOOL_REGISTRY_LOADER_FAILED"]]);
    } finally {
      warn.mockRestore();
      await view.unmount();
    }
  });

  test("an open chat updates when the loader resolves", async () => {
    const pending = deferred<readonly ToolRegistryEntry[]>();
    const hashedLeaf = "mcp_0123456789abcdef__knowledge_search";
    let resolved: ToolRegistry | undefined;
    function Probe() {
      resolved = useHostToolRegistry();
      return null;
    }
    const view = await renderComponent(
      withHost(
        [],
        <>
          <Probe />
          <SessionTimeline items={[toolCall(HOST_TOOL), toolCall(hashedLeaf)]} />
        </>,
        () => pending.promise,
      ),
    );
    try {
      // While pending, both show the generic renderer: not the built-in
      // knowledge card the hashed name would leaf-match, then the host card.
      expect(resolved?.resolve(toolCall(HOST_TOOL))).toBe(defaultToolRegistry.fallback);
      expect(resolved?.resolve(toolCall(hashedLeaf))).toBe(defaultToolRegistry.fallback);
      expect(resolved?.resolve(toolCall("exec_command"))).toBe(
        defaultToolRegistry.resolve(toolCall("exec_command")),
      );
      expect(fixtureCards(view.container)).toEqual([]);
      pending.resolve([fixtureEntry, { ...fixtureEntry, name: hashedLeaf }]);
      await settleLoader();
      expect(fixtureCards(view.container)).toEqual([
        `Fixture card for ${HOST_TOOL}`,
        `Fixture card for ${hashedLeaf}`,
      ]);
    } finally {
      await view.unmount();
    }
  });

  test("the loader is called at most once", async () => {
    const pending = deferred<readonly ToolRegistryEntry[]>();
    let calls = 0;
    const loader = () => {
      calls += 1;
      return pending.promise;
    };
    const chat = (names: string[]) =>
      withHost([], <SessionTimeline items={names.map(toolCall)} />, loader);
    const view = await renderComponent(
      <>
        {chat([HOST_TOOL, "other__unknown_tool"])}
        {chat(["another__unknown_tool"])}
      </>,
    );
    try {
      await view.rerender(
        <>
          {chat([HOST_TOOL, "other__unknown_tool", "third__unknown_tool"])}
          {chat(["another__unknown_tool"])}
        </>,
      );
      expect(calls).toBe(1);
      pending.resolve([fixtureEntry]);
      await settleLoader();
      await view.rerender(
        <>
          {chat([HOST_TOOL, "fourth__unknown_tool"])}
          {chat(["another__unknown_tool"])}
        </>,
      );
      expect(fixtureCards(view.container)).toEqual([`Fixture card for ${HOST_TOOL}`]);
      expect(calls).toBe(1);
    } finally {
      await view.unmount();
    }
  });
});
