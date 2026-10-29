// What the session UI asks of the page that renders it: routing, the API calls
// it makes outside the SDK client, optional heavy surfaces and per-message
// context. There is one host per app. The page that owns the document (the
// web app) configures its host once with `configurePageAppHost`; an embedded
// app passes its own through `AppHostProvider`, so two embeds on one page never
// share one, and an embed never touches the page around it (its title, its
// URL, its find shortcut).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SessionEvent, SessionStatus } from "@opengeni/sdk";

import type { ToolRegistryEntry } from "../../timeline";
import type { HostExtension, HostExtensionContext, HostExtensionStarter, NativeDestination, NativeSectionId } from "../host-extension";
import type { AppApiHost } from "./app-api";
import type { AppSurfaces } from "./app-surfaces";
import { createHostMessageContextStore, type MessageContextPill, type MessageContextStore } from "./message-context";
import type { NavigationHost } from "./navigation";

/** The open chat as its page holds it, for a host that reacts to its progress. */
export type SessionViewState = Readonly<{
  sessionId: string;
  /** The latest status in the chat's event log; null before one is loaded. */
  status: SessionStatus | null;
  /**
   * The events the page holds, ordered by sequence: its own window of the
   * chat's history, with a turn's steps while the turn is live. Not the full
   * history of a long chat.
   */
  events: readonly SessionEvent[];
  /** True until the first page of history has loaded. */
  initialLoading: boolean;
}>;

export type AppHost = Readonly<{
  navigation: NavigationHost;
  api: AppApiHost;
  /** Optional surfaces; an absent one renders its plain fallback or nothing. */
  surfaces?: Partial<AppSurfaces> | undefined;
  /**
   * Model context the page adds to each new chat and message (where the person
   * is writing from, such as an open workbook, and what they selected there).
   * Labeled items show as pills above the composer. Context, never
   * instructions.
   */
  messageContext?: MessageContextStore | undefined;
  extensionMessageContext?: HostExtension["messageContext"] | undefined;
  /**
   * Receives the open chat's state each time it changes, read from the
   * page's own event stream (no second connection).
   */
  onSessionState?: ((state: SessionViewState) => void) | undefined;
  /** The host extension's tool cards, ahead of the built-in renderers. */
  toolRegistryEntries?: readonly ToolRegistryEntry[] | undefined;
  /** Native destinations the host extension hides from every link source. */
  hiddenNativeDestinations?: readonly NativeDestination[] | undefined;
  hiddenNativeSections?: readonly NativeSectionId[] | undefined;
  /** The host extension's mark and wordmark, in place of the stock brand. */
  brand?: HostExtension["brand"] | undefined;
  /** The product name the console shows in place of the stock one. */
  productName?: string | undefined;
  starters?: ((context: HostExtensionContext) => readonly HostExtensionStarter[] | undefined) | undefined;
  sessionIndicator?: HostExtension["sessionIndicator"] | undefined;
  /** Narrows the workspaces the console's pickers and landing offer (see `hostFilteredWorkspaces`). */
  workspaceFilter?: HostExtension["workspaceFilter"] | undefined;
  /** The host extension's hooks, awaited (bounded) before sign-out and workspace switches. */
  lifecycle?: HostExtension["lifecycle"] | undefined;
}>;

const AppHostContext = createContext<AppHost | null>(null);

let pageHost: Partial<AppHost> = {};

/**
 * Sets the host of the page that owns the document, before the session UI
 * renders. Parts merge into what is set (tests set only the parts they use).
 */
export function configurePageAppHost(host: Partial<AppHost>): void {
  pageHost = {
    ...pageHost,
    ...host,
    surfaces: { ...pageHost.surfaces, ...host.surfaces },
  };
}

export function AppHostProvider(props: { host: AppHost; children?: ReactNode }) {
  return <AppHostContext.Provider value={props.host}>{props.children}</AppHostContext.Provider>;
}

/** This app's host: the embed's own, or the page's. */
export function useAppHost(): Partial<AppHost> {
  return useContext(AppHostContext) ?? pageHost;
}

const NOTHING_HIDDEN: readonly NativeDestination[] = [];

/** The native destinations the host extension hides; none in the stock console. */
export function useHiddenNativeDestinations(): readonly NativeDestination[] {
  return useAppHost().hiddenNativeDestinations ?? NOTHING_HIDDEN;
}

const NO_HIDDEN_SECTIONS: readonly NativeSectionId[] = [];
export function useHiddenNativeSections(): readonly NativeSectionId[] {
  return useAppHost().hiddenNativeSections ?? NO_HIDDEN_SECTIONS;
}

/** Whether a link to this native destination may be offered. */
export function useNativeDestinationVisible(destination: NativeDestination): boolean {
  return !useHiddenNativeDestinations().includes(destination);
}

/** Whether this app is embedded in a page it does not own. */
export function useEmbedded(): boolean {
  return useContext(AppHostContext) !== null;
}

/** Tells the host the open chat's state each time it changes. */
export function useReportSessionState(state: SessionViewState): void {
  const report = useAppHost().onSessionState;
  const { sessionId, status, events, initialLoading } = state;
  useEffect(() => {
    report?.({ sessionId, status, events, initialLoading });
  }, [events, initialLoading, report, sessionId, status]);
}

const HostMessageContext = createContext<MessageContextStore | null>(null);

/** A workspace-scoped context store shared by sends, realtime and composer pills. */
export function HostMessageContextProvider({
  context,
  resolve,
  children,
}: {
  context: HostExtensionContext;
  resolve: HostExtension["messageContext"] | undefined;
  children: ReactNode;
}) {
  const current = useRef({ context, resolve });
  current.current = { context, resolve };
  // The page store also serves new-chat creation above this workspace boundary.
  const pageStore = useAppHost().messageContext;
  const { workspaceId, pathname } = context;
  const store = useMemo(() => {
    if (!resolve) return null;
    if (pageStore) return pageStore;
    return createHostMessageContextStore(
      (sourceContext) => current.current.resolve?.(sourceContext),
      () => ({ ...current.current.context, workspaceId }),
    );
    // A workspace change retires all exclusions; ordinary renders retain them.
  }, [workspaceId, resolve, pageStore]);
  useEffect(() => {
    store?.set(resolve?.({ workspaceId, pathname }));
  }, [store, resolve, workspaceId, pathname]);
  return (
    <HostMessageContext.Provider value={store}>
      {children}
    </HostMessageContext.Provider>
  );
}

function useContextStore(): MessageContextStore | undefined {
  const supplied = useContext(HostMessageContext);
  const host = useAppHost();
  return supplied ?? host.messageContext;
}

/** Reads the host's per-message model context at send time, if it supplies one. */
export function useHostMessageContext(): (() => string | undefined) | undefined {
  const store = useContextStore();
  const read = useCallback(() => store?.forSend(), [store]);
  return store ? read : undefined;
}

const NO_PILLS: readonly MessageContextPill[] = [];
const noSubscription = () => () => {};

/** The host's context pills for the composer, with the controls to leave one out. */
export function useMessageContextPills(): {
  pills: readonly MessageContextPill[];
  exclude: (id: string) => void;
  include: (id: string) => void;
} {
  const store = useContextStore();
  const pills = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.pills ?? (() => NO_PILLS),
    store?.pills ?? (() => NO_PILLS),
  );
  return {
    pills,
    exclude: (id) => store?.exclude(id),
    include: (id) => store?.include(id),
  };
}
