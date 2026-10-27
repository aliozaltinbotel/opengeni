/* ----------------------------------------------------------------------------
   The session view's tool registry: a host extension's tool cards render for
   their exact tool name only, ahead of the built-in renderers. A call whose
   name merely ends in the same leaf behind another MCP server prefix gets the
   generic renderer. Without host entries, the timeline keeps the shared
   default registry, exactly as stock.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ReactNode } from "react";

import { registerDom, renderComponent } from "../../../test/render-hook";
import { MessageTimeline } from "../../components/message-timeline";
import {
  defaultToolRegistry,
  type ToolCallItem,
  type ToolRegistry,
  type ToolRegistryEntry,
  type ToolRendererProps,
} from "../../timeline";
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

function withHost(entries: readonly ToolRegistryEntry[], node: ReactNode) {
  const host = { toolRegistryEntries: entries } as unknown as AppHost;
  return <AppHostProvider host={host}>{node}</AppHostProvider>;
}

describe("session tool registry", () => {
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

  test("without host entries the timeline keeps the shared default registry", async () => {
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
