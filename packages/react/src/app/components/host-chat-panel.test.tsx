// The console's chat beside a host page (`HostExtension.chatPanel`): the
// person's own chat on the console's client, with the page's context and the
// context the page opened it with as pills sent with each message; the
// extension's tool cards, session indicator and starters; one mounted chat
// (one stream) however often the page opens it; and "Open as a full chat"
// carrying the kept context to that chat's route. The conversation components
// are stand-ins that record what the panel gives them.
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MessageContextItem } from "../lib/message-context";
import type { ToolCallItem, ToolRegistry, ToolRendererProps } from "../../timeline";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "00000000-0000-4000-9000-000000000001";
const pagePath = `/workspaces/${workspaceId}/pms/reservations/r-1`;

const creates: Array<{ workspace: string; request: Record<string, unknown> }> = [];
const navigations: unknown[] = [];
const composerValues: string[] = [];
const conversationProps: Array<Record<string, unknown>> = [];
const conversationMounts = { count: 0 };
let permissions = ["sessions:create"];

mock.module("../app-context", () => ({
  useAppContext: () => ({
    client: {
      createSession: async (workspace: string, request: Record<string, unknown>) => {
        creates.push({ workspace, request });
        return { id: sessionId };
      },
    },
    accessContext: { subjectId: "me", workspaceGrants: [{ workspaceId, permissions }] },
  }),
}));
mock.module("../lib/navigation", () => ({
  useNavigate: () => async (options: unknown) => void navigations.push(options),
  useLocation: () => ({
    pathname: pagePath,
    search: {},
    searchStr: "",
    hash: "",
    href: pagePath,
    state: {},
  }),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
mock.module("../../components/session-conversation", () => ({
  SessionConversation: (props: Record<string, unknown>) => {
    conversationProps.push(props);
    useEffect(() => {
      conversationMounts.count += 1;
    }, []);
    return <div data-conversation={String(props.sessionId)} />;
  },
}));
type Creation = {
  composer: { sending: boolean; setValue: (value: string) => void };
  send: () => Promise<void>;
};
mock.module("../../hooks/use-new-conversation", () => ({
  useNewConversation: (options: {
    createSession: (text: string, key: string, input: object) => Promise<string>;
    onCreated: (created: object) => void;
  }): Creation => ({
    composer: { sending: false, setValue: (value) => void composerValues.push(value) },
    send: async () => {
      const id = await options.createSession("Can they check in early?", "key-1", { model: "m" });
      options.onCreated({
        sessionId: id,
        initialMessage: "Can they check in early?",
        sentAt: "2026-10-31T09:00:00.000Z",
        draft: { text: "" },
      });
    },
  }),
}));
mock.module("../../components/new-conversation", () => ({
  NewConversationView: ({ creation }: { creation: Creation }) => (
    <>
      <textarea data-composer-input="" />
      <button type="button" onClick={() => void creation.send()}>
        Send
      </button>
    </>
  ),
}));
// The menu renders open, as the Site view's tests draw it.
mock.module("../../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

const page = { id: "surface", label: "Reservations", text: "surface: reservations" };
const stay: MessageContextItem = { id: "stay", label: "Stay R-1", text: "reservation: r-1" };
const property: MessageContextItem = { id: "property", label: "Villa", text: "property: p-1" };

function HostCard({ item }: ToolRendererProps) {
  return <p>Host card for {item.name}</p>;
}
function HostIndicator(props: { workspaceId: string; sessionId: string | null }) {
  return <p data-indicator={props.sessionId ?? "new"}>SIMULATION</p>;
}

let appHost: typeof import("../lib/app-host");
let HostChatPanel: typeof import("./host-chat-panel").default;
beforeAll(async () => {
  GlobalRegistrator.register({ url: `https://console.test${pagePath}` });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  appHost = await import("../lib/app-host");
  // What the console installs for a configured extension (app-host.ts).
  appHost.configurePageAppHost({
    extensionMessageContext: () => [page],
    toolRegistryEntries: [
      { match: "name", name: "host-app__check_in", render: HostCard, matchPrefixedLeaf: false },
    ],
    sessionIndicator: HostIndicator,
    starters: () => [
      { id: "early", label: "Early check-in", prompt: "Can this guest check in early?" },
    ],
  });
  HostChatPanel = (await import("./host-chat-panel")).default;
});
afterAll(async () => {
  mock.restore();
  await GlobalRegistrator.unregister();
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  creates.length = 0;
  navigations.length = 0;
  composerValues.length = 0;
  conversationProps.length = 0;
  conversationMounts.count = 0;
  permissions = ["sessions:create"];
});

type Props = {
  context: readonly MessageContextItem[];
  sessionId: string | null;
  openCount: number;
};
const changes: Array<string | null> = [];
let closes = 0;
function render(container: HTMLElement, props: Props) {
  return act(async () =>
    root!.render(
      <HostChatPanel
        workspaceId={workspaceId}
        {...props}
        onSessionChange={(id) => void changes.push(id)}
        onClose={() => void (closes += 1)}
      />,
    ),
  );
}
async function mount(props: Props) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render(container, props);
  return container;
}
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name,
  )!;
const pills = (container: HTMLElement) =>
  [...container.querySelectorAll('[aria-label="Context sent with your message"] > span')].map(
    (pill) => `${pill.textContent}${pill.hasAttribute("data-excluded") ? " (left out)" : ""}`,
  );
const sendExtras = () =>
  (
    conversationProps.at(-1)!.composerOptions as { sendExtras: () => { modelContext?: string } }
  ).sendExtras();

test("a new chat's first message carries the page's context and the context it was opened with", async () => {
  const container = await mount({ context: [stay], sessionId: null, openCount: 1 });
  expect(container.querySelector('aside[aria-label="Chat"]')).not.toBeNull();
  expect(pills(container)).toEqual(["Reservations", "Stay R-1"]);

  await act(async () => button(container, "Send").click());

  expect(creates).toEqual([
    {
      workspace: workspaceId,
      request: {
        initialMessage: "Can they check in early?",
        idempotencyKey: "key-1",
        model: "m",
        modelContext: "surface: reservations\n\nreservation: r-1",
      },
    },
  ]);
  expect(changes.at(-1)).toBe(sessionId);
});

test("the person can leave a pill out of their next messages", async () => {
  const container = await mount({ context: [stay], sessionId, openCount: 1 });
  expect(sendExtras().modelContext).toBe("surface: reservations\n\nreservation: r-1");

  await act(async () => button(container, "Don't send Stay R-1").click());

  expect(pills(container)).toEqual(["Reservations", "Stay R-1 (left out)"]);
  expect(sendExtras().modelContext).toBe("surface: reservations");
});

test("one chat stays mounted (one stream) while the page opens the panel again with new context", async () => {
  const container = await mount({ context: [stay], sessionId, openCount: 1 });
  await render(container, { context: [property], sessionId, openCount: 2 });
  await render(container, { context: [stay, property], sessionId, openCount: 3 });

  expect(conversationMounts.count).toBe(1);
  expect(new Set(conversationProps.map((props) => props.sessionId))).toEqual(new Set([sessionId]));
  expect(pills(container)).toEqual(["Reservations", "Stay R-1", "Villa"]);
  expect(sendExtras().modelContext).toBe(
    "surface: reservations\n\nreservation: r-1\n\nproperty: p-1",
  );
});

test("the extension's tool cards, session indicator and starters apply in the panel", async () => {
  const container = await mount({ context: [], sessionId: null, openCount: 1 });
  expect(container.querySelector("[data-indicator]")?.getAttribute("data-indicator")).toBe("new");
  await act(async () => button(container, "Early check-in").click());
  expect(composerValues).toEqual(["Can this guest check in early?"]);

  await render(container, { context: [], sessionId, openCount: 1 });
  expect(container.querySelector("[data-indicator]")?.getAttribute("data-indicator")).toBe(
    sessionId,
  );
  const registry = conversationProps.at(-1)!.toolRegistry as ToolRegistry;
  const call = { kind: "tool-call", name: "host-app__check_in" } as ToolCallItem;
  expect(registry.resolve(call)).toBe(HostCard);
});

test("a person who may not start chats is told so instead of a composer", async () => {
  permissions = [];
  const container = await mount({ context: [stay], sessionId: null, openCount: 1 });
  expect(container.textContent).toContain("You can’t start chats in this workspace.");
  expect(button(container, "Send")).toBeUndefined();
});

test("Open as a full chat carries the context the person kept to that chat's route", async () => {
  const container = await mount({ context: [stay, property], sessionId, openCount: 1 });
  await act(async () => button(container, "Don't send Villa").click());
  const closed = closes;

  await act(async () => button(container, "Open as a full chat").click());

  expect(closes).toBe(closed + 1);
  expect(navigations).toEqual([
    { to: "/workspaces/$workspaceId/sessions/$sessionId", params: { workspaceId, sessionId } },
  ]);
  // The full chat reads the page host when it renders.
  let host: ReturnType<typeof appHost.useAppHost> = {};
  function FullChatProbe() {
    host = appHost.useAppHost();
    return null;
  }
  await act(async () => root!.render(<FullChatProbe />));
  const fullChat = { workspaceId, pathname: `/workspaces/${workspaceId}/sessions/${sessionId}` };
  expect(host.extensionMessageContext?.(fullChat)).toEqual([page, stay]);
  expect(host.extensionMessageContext?.({ workspaceId, pathname: pagePath })).toEqual([page]);
  expect(
    host.extensionMessageContext?.({
      workspaceId,
      pathname: `/workspaces/${workspaceId}/sessions/other`,
    }),
  ).toEqual([page]);
  window.history.pushState({}, "", fullChat.pathname);
  expect(host.messageContext?.forSend()).toBe("surface: reservations\n\nreservation: r-1");
});
