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
export type HostExtension = Readonly<{
  id: string;
  productName?: string;
  brand?: Readonly<{
    mark: ComponentType<{ className?: string }>;
    wordmark: ComponentType<{ className?: string }>;
  }>;
  routes?: readonly HostExtensionRoute[];
  nav?: readonly HostExtensionNavItem[];
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
