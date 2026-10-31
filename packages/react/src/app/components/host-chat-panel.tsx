// The console's own chat beside a host extension's rail page
// (`HostExtension.chatPanel`), loaded when a page first opens it. It is the
// person's chat on the console's own client, credentials and app context, as
// the Site view's chat panel is: the extension's tool cards, session indicator
// and starters apply, and an open chat has its one stream.
//
// What the page opened the panel with shows as pills beside the page's own
// `messageContext` (still resolved at each send) and goes with every message.
// "Open as a full chat" carries the items the person kept to that chat's route.
import { Maximize2Icon, MoreHorizontalIcon, PlusIcon, TextSelectIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from "react";
import type { OpenGeniClient } from "@opengeni/sdk";

import { NewConversationView } from "../../components/new-conversation";
import { SessionConversation } from "../../components/session-conversation";
import {
  useNewConversation,
  type CreatedConversation,
  type NewConversationCreateOptions,
} from "../../hooks/use-new-conversation";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { ResizeHandle } from "../../ui/resize-handle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";
import { useAppContext } from "../app-context";
import type { HostExtensionContext } from "../host-extension";
import { configurePageAppHost, useAppHost, type AppHost } from "../lib/app-host";
import { useHostToolRegistry } from "../lib/host-tool-registry";
import {
  createHostMessageContextStore,
  type MessageContextInput,
  type MessageContextItem,
  type MessageContextStore,
} from "../lib/message-context";
import { useLocation, useNavigate } from "../lib/navigation";
import { hasWorkspacePermission } from "../lib/permissions";
import {
  clampSiteChatWidth,
  readSiteChatPanelLayout,
  SITE_CHAT_DEFAULT_WIDTH,
  SITE_CHAT_MAX_WIDTH,
  SITE_CHAT_MIN_WIDTH,
  SITE_MIN_WIDTH,
  writeSiteChatPanelLayout,
} from "../lib/site-chat-panel";
import { NewSessionStarters } from "./new-session-starters";
import { HostSessionIndicatorFrame } from "./session-indicator";

const WIDTH_VARIABLE = "--og-host-chat-width";
const SESSION_ROUTE = "/workspaces/$workspaceId/sessions/$sessionId";
const NO_ITEMS: readonly MessageContextItem[] = [];

export type HostChatPanelProps = {
  workspaceId: string;
  /** The checked items the page opened the panel with; the latest open wins. */
  context: readonly MessageContextItem[];
  /** The chat in the panel; null composes a new one. */
  sessionId: string | null;
  /** Changes on every open, so the panel focuses its composer. */
  openCount: number;
  onSessionChange: (sessionId: string | null) => void;
  onClose: () => void;
};

function itemsOf(input: MessageContextInput): readonly MessageContextItem[] {
  if (input === undefined || typeof input === "string" || typeof input === "function")
    return NO_ITEMS;
  return Array.isArray(input)
    ? (input as readonly MessageContextItem[])
    : [input as MessageContextItem];
}

/** The page's own items, then `added`: an added item replaces a page item with its id. */
export function withAddedMessageContext(
  page: MessageContextInput,
  added: readonly MessageContextItem[],
): MessageContextInput {
  if (added.length === 0) return page;
  const ids = new Set(added.map((item) => item.id));
  return [...itemsOf(page).filter((item) => !ids.has(item.id)), ...added];
}

export function sessionRoutePath(workspaceId: string, sessionId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`;
}

// Items carried to a full chat, by its route. Installed into the page host on
// the first carry, so a console that never expands a panel keeps its own
// context store as it was.
const carried = new Map<string, readonly MessageContextItem[]>();
let carrying = false;

function carriedAt(pathname: string): readonly MessageContextItem[] {
  for (const [path, items] of carried)
    if (pathname === path || pathname.startsWith(`${path}/`)) return items;
  return NO_ITEMS;
}

function locationContext(): HostExtensionContext {
  const pathname = window.location.pathname;
  const workspaceId = /^\/workspaces\/([^/]+)/.exec(pathname)?.[1] ?? "";
  return { pathname, workspaceId: decodeURIComponent(workspaceId) };
}

/**
 * The full chat at `path` sends `items` beside the page's own context, as the
 * panel did. Its route reads the page host when it renders, so this runs
 * before the navigation.
 */
function carryToFullChat(
  page: AppHost["extensionMessageContext"],
  path: string,
  items: readonly MessageContextItem[],
): void {
  carried.set(path, items);
  if (carrying) return;
  carrying = true;
  const resolve = (context: HostExtensionContext) =>
    withAddedMessageContext(page?.(context), carriedAt(context.pathname));
  configurePageAppHost({
    extensionMessageContext: resolve,
    messageContext: createHostMessageContextStore(resolve, locationContext),
  });
}

/** The page's context (resolved for the page in view at each send) with the panel's own. */
function usePanelContextStore(
  workspaceId: string,
  pathname: string,
  added: readonly MessageContextItem[],
): MessageContextStore {
  const page = useAppHost().extensionMessageContext;
  const current = useRef({ page, pathname, added });
  current.current = { page, pathname, added };
  const store = useMemo(() => {
    const created = createHostMessageContextStore(
      (context) => withAddedMessageContext(current.current.page?.(context), current.current.added),
      () => ({ workspaceId, pathname: current.current.pathname }),
    );
    created.set(
      withAddedMessageContext(
        current.current.page?.({ workspaceId, pathname: current.current.pathname }),
        current.current.added,
      ),
    );
    return created;
  }, [workspaceId]);
  useEffect(() => {
    store.set(withAddedMessageContext(page?.({ workspaceId, pathname }), added));
  }, [store, page, workspaceId, pathname, added]);
  return store;
}

function useAvailableWidth(panel: RefObject<HTMLElement | null>) {
  const [max, setMax] = useState(SITE_CHAT_MAX_WIDTH);
  useLayoutEffect(() => {
    const element = panel.current?.parentElement;
    if (!element) return;
    const measure = () => {
      const { width } = element.getBoundingClientRect();
      setMax(
        width === 0
          ? SITE_CHAT_MAX_WIDTH
          : Math.max(
              SITE_CHAT_MIN_WIDTH,
              Math.min(SITE_CHAT_MAX_WIDTH, Math.floor(width - SITE_MIN_WIDTH)),
            ),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel]);
  return max;
}

/** The panel's width, remembered per person in this browser. */
function usePanelWidth(subjectId: string) {
  const storageId = `og.host-chat-panel:v1:${encodeURIComponent(subjectId)}`;
  const [width, setWidth] = useState(() => readSiteChatPanelLayout(storageId).width);
  const update = useCallback(
    (next: number) => {
      const clamped = clampSiteChatWidth(next);
      writeSiteChatPanelLayout(storageId, { width: clamped, collapsed: false });
      setWidth(clamped);
    },
    [storageId],
  );
  return { width, update };
}

export default function HostChatPanel({
  workspaceId,
  context,
  sessionId,
  openCount,
  onSessionChange,
  onClose,
}: HostChatPanelProps) {
  const app = useAppContext();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const page = useAppHost().extensionMessageContext;
  const toolRegistry = useHostToolRegistry();
  const panelId = useId();
  const panel = useRef<HTMLElement>(null);
  const { width: preferred, update: updateWidth } = usePanelWidth(app.accessContext.subjectId);
  const maxWidth = useAvailableWidth(panel);
  const width = Math.min(preferred, maxWidth);
  const store = usePanelContextStore(workspaceId, pathname, context);
  const [handoff, setHandoff] = useState<CreatedConversation | null>(null);
  const canCreate = hasWorkspacePermission(app.accessContext, workspaceId, "sessions:create");

  // Each open (and each new chat) focuses the composer once it can be used.
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => setFocusRequest((request) => request + 1), [openCount]);
  useEffect(() => {
    if (focusRequest === 0) return;
    let animation = 0;
    let tries = 0;
    const attempt = () => {
      const input = panel.current?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])");
      if (input) input.focus({ preventScroll: true });
      else if ((tries += 1) < 60) animation = requestAnimationFrame(attempt);
    };
    animation = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(animation);
  }, [focusRequest]);

  const openSession = (id: string) =>
    void navigate({ to: SESSION_ROUTE, params: { workspaceId, sessionId: id } });
  const expand = () => {
    if (!sessionId) return;
    const left = store.pills().filter((pill) => pill.excluded);
    const kept = context.filter(
      (item) => !left.some((pill) => pill.id === item.id && pill.label === item.label),
    );
    carryToFullChat(page, sessionRoutePath(workspaceId, sessionId), kept);
    onClose();
    openSession(sessionId);
  };
  const startNew = () => {
    setHandoff(null);
    onSessionChange(null);
    setFocusRequest((request) => request + 1);
  };
  const sendExtras = useCallback(() => {
    const modelContext = store.forSend();
    return modelContext ? { modelContext } : {};
  }, [store]);
  const handedOff = handoff !== null && handoff.sessionId === sessionId ? handoff : null;

  return (
    <aside
      ref={panel}
      id={panelId}
      aria-label="Chat"
      data-host-chat-panel=""
      style={{ [WIDTH_VARIABLE]: `${width}px` } as CSSProperties}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-bg lg:w-(--og-host-chat-width) max-lg:h-[55%] max-lg:w-full max-lg:border-t max-lg:border-l-0"
    >
      <ResizeHandle
        label="Resize chat"
        controls={panelId}
        value={width}
        min={SITE_CHAT_MIN_WIDTH}
        max={maxWidth}
        edge="start"
        onResize={(next) => panel.current?.style.setProperty(WIDTH_VARIABLE, `${next}px`)}
        onResizeEnd={(next) => {
          panel.current?.style.setProperty(WIDTH_VARIABLE, `${next}px`);
          updateWidth(next);
        }}
        onReset={() => updateWidth(SITE_CHAT_DEFAULT_WIDTH)}
        onCollapse={onClose}
        className="max-lg:hidden"
      />
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">Chat</h2>
        {canCreate && sessionId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={startNew}
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
            New
          </Button>
        ) : null}
        {sessionId ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="More"
                title="More"
                className="text-fg-muted hover:text-fg pointer-coarse:size-11"
              >
                <MoreHorizontalIcon aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={expand}>
                <Maximize2Icon aria-hidden="true" />
                Open as a full chat
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close chat"
          title="Close chat"
          className="text-fg-muted hover:text-fg pointer-coarse:size-11"
          onClick={onClose}
        >
          <XIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <HostSessionIndicatorFrame workspaceId={workspaceId} sessionId={sessionId}>
        <PanelContextPills store={store} />
        {/* The regular chat's inset, so the composer sits as it does in a full chat. */}
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          {sessionId ? (
            <SessionConversation
              key={sessionId}
              sessionId={sessionId}
              modelPicker
              viewerSubjectId={app.accessContext.subjectId}
              toolRegistry={toolRegistry}
              {...(handedOff?.initialMessage
                ? { pendingPrompt: { text: handedOff.initialMessage, sentAt: handedOff.sentAt } }
                : {})}
              composerOptions={{
                ...(handedOff ? { initialDraft: handedOff.draft } : {}),
                sendExtras,
              }}
              onOpenSession={openSession}
              className="min-h-0 flex-1"
            />
          ) : canCreate ? (
            <PanelNewConversation
              key={`new:${workspaceId}`}
              client={app.client}
              workspaceId={workspaceId}
              store={store}
              onCreated={(created) => {
                setHandoff(created);
                onSessionChange(created.sessionId);
              }}
            />
          ) : (
            <p className="py-4 pl-1 text-sm text-fg-muted">
              You can’t start chats in this workspace.
            </p>
          )}
        </div>
      </HostSessionIndicatorFrame>
    </aside>
  );
}

/** A new chat whose first message carries the panel's context, with the host's starters. */
function PanelNewConversation({
  client,
  workspaceId,
  store,
  onCreated,
}: {
  client: Pick<OpenGeniClient, "createSession">;
  workspaceId: string;
  store: MessageContextStore;
  onCreated: (created: CreatedConversation) => void;
}) {
  const createSession = useCallback(
    async (
      initialMessage: string,
      idempotencyKey: string,
      options: NewConversationCreateOptions,
    ) => {
      const modelContext = store.forSend();
      const created = await client.createSession(workspaceId, {
        ...(options.startMode === "realtime" ? {} : { initialMessage }),
        idempotencyKey,
        ...options,
        ...(modelContext ? { modelContext } : {}),
      } as Parameters<OpenGeniClient["createSession"]>[1]);
      return created.id;
    },
    [client, store, workspaceId],
  );
  const creation = useNewConversation({
    createSession,
    onCreated,
    modelPicker: true,
    // A panel's new chat takes text and a model; files can be added once it has started.
    attachments: false,
    realtimeVoice: false,
  });
  const form = useRef<HTMLDivElement>(null);
  return (
    <div ref={form} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <NewConversationView creation={creation} height="auto" className="min-h-0" />
      <NewSessionStarters
        workspaceId={workspaceId}
        disabled={creation.composer.sending}
        onSelect={(prompt) => {
          creation.composer.setValue(prompt);
          form.current?.querySelector("textarea")?.focus({ preventScroll: true });
        }}
      />
    </div>
  );
}

/** The panel's context as pills: the page's and what it opened the panel with. */
function PanelContextPills({ store }: { store: MessageContextStore }) {
  const pills = useSyncExternalStore(store.subscribe, store.pills, store.pills);
  if (pills.length === 0) return null;
  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="flex shrink-0 flex-wrap gap-1.5 px-4 pt-2.5"
        role="group"
        aria-label="Context sent with your message"
      >
        {pills.map((pill) => (
          <span
            key={pill.id}
            data-excluded={pill.excluded || undefined}
            className={cn(
              "inline-flex min-w-0 max-w-full items-center gap-1 rounded-og-md border py-0.5 pr-0.5 pl-1.5 text-og-sm transition-colors",
              pill.excluded
                ? "border-dashed border-og-border bg-transparent text-og-fg-subtle"
                : "border-og-border bg-og-surface-2 text-og-fg-muted",
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex min-w-0 items-center gap-1" tabIndex={0}>
                  <TextSelectIcon className="size-3 shrink-0" aria-hidden />
                  <span className={cn("truncate", pill.excluded && "line-through")}>
                    {pill.label}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {pill.excluded
                  ? `Not sent with your messages: ${pill.label}`
                  : `Sent with your messages${pill.detail ? `: ${pill.detail}` : ""}`}
              </TooltipContent>
            </Tooltip>
            <button
              type="button"
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-og-sm hover:bg-og-surface-3 hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent"
              onClick={() => (pill.excluded ? store.include(pill.id) : store.exclude(pill.id))}
              aria-label={pill.excluded ? `Send ${pill.label} again` : `Don't send ${pill.label}`}
            >
              {pill.excluded ? <PlusIcon className="size-3" /> : <XIcon className="size-3" />}
            </button>
          </span>
        ))}
      </div>
    </TooltipProvider>
  );
}
