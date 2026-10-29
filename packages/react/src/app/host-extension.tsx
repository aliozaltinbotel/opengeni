// The contract a host product implements to extend the web console: its own
// workspace pages and nav entries, shell providers, brand and tool cards, and
// the native destinations it hides. The console resolves one extension at build
// time through the `@opengeni/web-host-extension` specifier; without one it
// uses EMPTY_HOST_EXTENSION and behaves as stock.
//
// The descriptor (the specifier's default export) is startup code: keep it to
// plain data, small eager components and `import()` thunks. Page bodies
// (`routes[].load`) and tool-card bodies (a `lazy(() => import(…))` behind
// the card's own Suspense) load on demand. The console imports the descriptor
// from its main entry's startup module only, and every other console module
// reads the installed extension at call time: a module with `import()` that
// lazy routes also reach statically would reshuffle the startup chunks.
import type { ComponentType, ReactNode } from "react";
import type { ToolRenderer } from "../timeline";

export { isBuiltInToolCardName } from "./built-in-tool-names";
/**
 * The page's CSP nonce (`<meta property="csp-nonce">`), or undefined: for an
 * extension that injects its own <style> or passes `nonce` to a library. The
 * console already stamps it on every <style> the document creates.
 */
export { cspNonce as nonce } from "./lib/csp-nonce";

export type NativeDestination =
  | "plugins"
  | "state"
  | "automations"
  | "meetings"
  | "artifacts"
  | "insights"
  | "secrets"
  | "rigs"
  | "machines"
  | "computer-use"
  | "playground"
  | "read-only-chats"
  | "variable-sets"
  | "environments";

export type HostExtensionContext = Readonly<{ workspaceId: string; pathname: string }>;
export type HostExtensionPage = ComponentType<{ workspaceId: string }>;
export type HostExtensionRoute = Readonly<{
  /** Relative to workspaces/$workspaceId/, lowercase segments, may contain $params; e.g. "pms" or "pms/reservations/$reservationId". */
  path: string;
  load: () => Promise<{ default: HostExtensionPage }>;
  /** "settings" renders inside the settings-mode shell. Default "rail". */
  mode?: "rail" | "settings";
}>;
/**
 * A host page mounted outside any workspace, at the console's top level (for
 * example "register" or "not-admitted"). It renders inside the extension's
 * `outsideWorkspaceProviders` (never its `shellProviders`, which take a
 * workspace), before any workspace exists.
 *
 * - `access: "public"` renders it before configuration and sign-in, like the
 *   console's reset-password page (a signed-out visitor reaches it).
 * - `access: "signedIn"` (default) renders it once the person is signed in,
 *   before the workspace access and onboarding gates.
 */
export type HostExtensionOutsideWorkspaceRoute = Readonly<{
  /** Lowercase static segments, no params; its first segment is not a native top-level one. */
  path: string;
  load: () => Promise<{ default: ComponentType }>;
  access?: "public" | "signedIn";
}>;
export type HostExtensionNavItem = Readonly<{
  id: string;
  label: string;
  description?: string;
  icon: ComponentType<{ className?: string }>;
  path: string;
  placement: "primary" | Readonly<{ settingsGroup: string }>;
  visible?: (context: HostExtensionContext) => boolean;
}>;
/**
 * A host tool card: the renderer for one exact tool name, ahead of the built-in
 * renderers. Prefixed leaf matching stays off, so a call from another MCP
 * server whose tool name merely ends the same way never renders this card.
 */
export type HostToolRegistryEntry = Readonly<{
  match: "name";
  name: string;
  render: ToolRenderer;
  matchPrefixedLeaf: false;
}>;
/**
 * Native entries a host extension can relabel, move or leave off the rail:
 * the primary rail's entries, and `insights` (the workspace Insights page in
 * the settings rail).
 */
export type NativeNavId =
  | "inbox"
  | "plugins"
  | "state"
  | "automations"
  | "meetings"
  | "artifacts"
  | "insights";
/**
 * Where a native rail entry shows: `peer` (default) with the workspace
 * shortcuts, `chat` in the chat utility group right after "New session"
 * (drawn as a separate group), `hidden` nowhere on the rail (its page and
 * links elsewhere stay; `hiddenNativeDestinations` removes a page).
 */
export type HostExtensionNavGroup = "peer" | "chat" | "hidden";
/**
 * One native entry's override. `settingsGroup` (one of the extension's
 * `settingsGroups`) moves the entry into that group of the settings rail,
 * before the group's own items, and off its native place; it excludes
 * `group`, and the inbox cannot move there. For `insights`, `group` is
 * `peer` (its own place, the default) or `hidden`.
 */
export type HostExtensionNavOverride = Readonly<{
  id: NativeNavId;
  label?: string;
  group?: HostExtensionNavGroup;
  settingsGroup?: string;
}>;
export type HostExtension = Readonly<{
  id: string;
  productName?: string;
  /** Persistent host information above every session and the new-chat page. */
  sessionIndicator?: ComponentType<{ workspaceId: string; sessionId: string | null }>;
  brand?: Readonly<{
    mark: ComponentType<{ className?: string }>;
    wordmark: ComponentType<{ className?: string }>;
  }>;
  routes?: readonly HostExtensionRoute[];
  nav?: readonly HostExtensionNavItem[];
  /**
   * Native rail entries relabelled, moved into the chat group or left off the
   * rail (`composePrimaryNav`); each id at most once.
   */
  navOverrides?: readonly HostExtensionNavOverride[];
  /** Host pages at the console's top level, outside any workspace. */
  outsideWorkspaceRoutes?: readonly HostExtensionOutsideWorkspaceRoute[];
  /**
   * The workspace-relative path the console opens for a workspace (the root
   * redirect and `workspaces/$workspaceId/`): "sessions" or one of the
   * extension's own static routes. Default "sessions".
   */
  landing?: string;
  /** Wrap the `outsideWorkspace` pages, the first outermost (they take no workspace). */
  outsideWorkspaceProviders?: readonly ComponentType<{ children: ReactNode }>[];
  settingsGroups?: readonly Readonly<{ id: string; label: string }>[];
  hiddenNativeDestinations?: readonly NativeDestination[];
  shellProviders?: readonly ComponentType<{ workspaceId: string; children: ReactNode }>[];
  toolRegistryEntries?: readonly HostToolRegistryEntry[];
  workspaceFilter?: (workspace: Readonly<{ id: string; accountId: string }>) => boolean;
  /**
   * Design §12.2 I15: awaited by the console before sign-out and before
   * switching workspace, each bounded (5 s); a rejection or timeout is logged
   * as HOST_LIFECYCLE_HOOK_FAILED and the action goes on.
   *
   * - `onSignOut` runs before every native sign-out request, after the console
   *   has unmounted its authenticated surfaces (the session is still valid).
   * - `onWorkspaceSwitch(from, to)` runs before the console's own switches
   *   navigate (switchers, ⌘K, organization switch, another workspace's chat)
   *   while the shell is still mounted. Any other in-tab change (a raw link,
   *   back and forward, a deep link, an account switch) is caught at the
   *   workspace route's tenant boundary, after the previous shell (and so this
   *   extension's shell providers) has unmounted. Each switch calls it once.
   * - A typed URL or a full reload starts a new page and cannot be hooked.
   *
   * Hooks must not depend on the extension's providers being mounted: hold any
   * session handle they need (for example an embedded provider session) at
   * module level.
   */
  lifecycle?: Readonly<{
    onSignOut?: () => Promise<void>;
    onWorkspaceSwitch?: (from: string, to: string) => Promise<void>;
  }>;
}>;

/**
 * The workspaces a host's `workspaceFilter` keeps, in order. `currentWorkspaceId`
 * (the workspace the person is in) is kept regardless, so a picker still
 * shows where they are. Without a filter the list is returned as it is.
 */
export function hostFilteredWorkspaces<T extends Readonly<{ id: string; accountId: string }>>(
  workspaces: T[],
  filter: HostExtension["workspaceFilter"],
  currentWorkspaceId?: string | null,
): T[] {
  if (!filter) return workspaces;
  return workspaces.filter((workspace) => workspace.id === currentWorkspaceId || filter(workspace));
}

const NO_ITEMS: readonly never[] = Object.freeze([]);

/** Every native rail entry an override may name, in rail order. */
export const NATIVE_NAV_IDS: readonly NativeNavId[] = Object.freeze([
  "inbox",
  "plugins",
  "state",
  "automations",
  "meetings",
  "artifacts",
  "insights",
]);

export function isNativeNavId(value: unknown): value is NativeNavId {
  return typeof value === "string" && (NATIVE_NAV_IDS as readonly string[]).includes(value);
}

/** The native destination a rail entry opens, if hiding a destination can remove it. */
export function nativeNavDestination(id: NativeNavId): NativeDestination | null {
  return id === "inbox" ? null : id;
}

/** A native rail entry as the console lists it: its id and stock label (plus its own fields). */
export type NativeNavEntry = Readonly<{ id: NativeNavId; label: string }>;
export type ComposedPrimaryNav<T extends NativeNavEntry> = Readonly<{
  /** Native entries in the chat group, after "New session", relabelled. */
  chat: readonly T[];
  /** The rail's peers in order: native entries (relabelled), then the host's primary entries. */
  peers: readonly (T | HostExtensionNavItem)[];
}>;

/**
 * The primary rail a host extension composes from the console's native entries
 * (`nativeItems`, in rail order): entries whose destination the extension
 * hides are left out, overrides relabel entries and move them into the chat
 * group or off the rail, and the host's `placement: "primary"` items follow
 * the native peers (each kept unless its `visible` answers false for
 * `context`; with no context every item is kept). Pure: no React, no DOM.
 */
export function composePrimaryNav<T extends NativeNavEntry>(
  extension: Pick<HostExtension, "nav" | "navOverrides" | "hiddenNativeDestinations">,
  nativeItems: readonly T[],
  context?: HostExtensionContext,
): ComposedPrimaryNav<T> {
  const hidden = extension.hiddenNativeDestinations ?? NO_ITEMS;
  const overrides = new Map((extension.navOverrides ?? NO_ITEMS).map((entry) => [entry.id, entry]));
  const chat: T[] = [];
  const peers: (T | HostExtensionNavItem)[] = [];
  for (const item of nativeItems) {
    const destination = nativeNavDestination(item.id);
    if (destination !== null && hidden.includes(destination)) continue;
    const override = overrides.get(item.id);
    const entry = override?.label === undefined ? item : { ...item, label: override.label };
    // An entry moved into a settings group is not on the primary rail.
    if (override?.settingsGroup !== undefined) continue;
    const group = override?.group ?? "peer";
    if (group === "chat") chat.push(entry);
    else if (group === "peer") peers.push(entry);
  }
  for (const item of extension.nav ?? NO_ITEMS) {
    if (item.placement !== "primary") continue;
    if (context && item.visible && !item.visible(context)) continue;
    peers.push(item);
  }
  return { chat, peers };
}

/** The extension's override of one native entry, if it has one. */
export function nativeNavOverride(
  extension: Pick<HostExtension, "navOverrides">,
  id: NativeNavId,
): HostExtensionNavOverride | undefined {
  return extension.navOverrides?.find((entry) => entry.id === id);
}

/**
 * The native entries an extension moves into settings group `groupId`, in
 * native order, leaving out those whose destination it hides.
 */
export function nativeEntriesInSettingsGroup(
  extension: Pick<HostExtension, "navOverrides" | "hiddenNativeDestinations">,
  groupId: string,
): readonly NativeNavId[] {
  const hidden = extension.hiddenNativeDestinations ?? NO_ITEMS;
  return NATIVE_NAV_IDS.filter((id) => {
    const destination = nativeNavDestination(id);
    if (destination !== null && hidden.includes(destination)) return false;
    return nativeNavOverride(extension, id)?.settingsGroup === groupId;
  });
}

/** The workspace-relative path the console opens for a workspace: the extension's `landing`, else "sessions". */
export function workspaceLanding(extension: Pick<HostExtension, "landing">): string {
  return extension.landing ?? "sessions";
}

/** The stock console's extension: no pages, no nav, nothing hidden. */
export const EMPTY_HOST_EXTENSION: HostExtension = { id: "none" };

const NATIVE_DESTINATION_SET: Readonly<Record<NativeDestination, true>> = {
  plugins: true,
  state: true,
  automations: true,
  meetings: true,
  artifacts: true,
  insights: true,
  secrets: true,
  rigs: true,
  machines: true,
  "computer-use": true,
  playground: true,
  "read-only-chats": true,
  "variable-sets": true,
  environments: true,
};

/** Every native destination an extension may hide, in declaration order. */
export const NATIVE_DESTINATIONS = Object.keys(
  NATIVE_DESTINATION_SET,
) as readonly NativeDestination[];

export function isNativeDestination(value: unknown): value is NativeDestination {
  return typeof value === "string" && Object.hasOwn(NATIVE_DESTINATION_SET, value);
}

/**
 * Legacy workspace segments that only redirect into a native destination, and
 * companion segments that also open one. Hiding the destination hides them
 * too, so no old link leads into a not-found by way of a redirect.
 */
const SEGMENT_REDIRECTS: Readonly<Record<string, readonly NativeDestination[]>> = {
  capabilities: ["plugins"],
  schedules: ["automations"],
  documents: ["state"],
  memory: ["state"],
  "variable-sets": ["variable-sets", "secrets"],
  environments: ["environments", "secrets"],
};

/** The native destinations a first segment under workspaces/$workspaceId/ opens. */
export function nativeDestinationsOfSegment(segment: string): readonly NativeDestination[] {
  if (Object.hasOwn(SEGMENT_REDIRECTS, segment)) return SEGMENT_REDIRECTS[segment] ?? [];
  return isNativeDestination(segment) ? [segment] : [];
}

/**
 * Organization settings sections that show a native destination at
 * organization scope. Hiding the destination hides the section too: the
 * settings rail and settings search leave it out, and its URL renders the
 * not-found page.
 */
const ORGANIZATION_SECTION_DESTINATIONS: Readonly<Record<string, NativeDestination>> = {
  insights: "insights",
};

/** Whether an organization settings section shows a destination the host extension hides. */
export function isOrganizationSectionHidden(
  section: string,
  hidden: readonly NativeDestination[],
): boolean {
  const destination = Object.hasOwn(ORGANIZATION_SECTION_DESTINATIONS, section)
    ? ORGANIZATION_SECTION_DESTINATIONS[section]
    : undefined;
  return destination !== undefined && hidden.includes(destination);
}

/** Whether a first workspace segment opens a destination the host extension hides. */
export function isWorkspaceSegmentHidden(
  segment: string,
  hidden: readonly NativeDestination[],
): boolean {
  return (
    hidden.length > 0 &&
    nativeDestinationsOfSegment(segment).some((destination) => hidden.includes(destination))
  );
}
