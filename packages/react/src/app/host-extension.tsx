// The contract a host product implements to extend the web console: its own
// workspace pages and nav entries, shell providers, brand and tool cards, and
// the native destinations it hides. The console resolves one extension at build
// time through the `@opengeni/web-host-extension` specifier; without one it
// uses EMPTY_HOST_EXTENSION and behaves as stock.
import type { ComponentType, ReactNode } from "react";
import type { ToolRegistryEntry } from "../timeline";

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
  toolRegistryEntries?: readonly ToolRegistryEntry[];
  workspaceFilter?: (workspace: Readonly<{ id: string; accountId: string }>) => boolean;
  /** Design §12.2 I15: awaited by the console before sign-out and before switching workspace. */
  lifecycle?: Readonly<{
    onSignOut?: () => Promise<void>;
    onWorkspaceSwitch?: (from: string, to: string) => Promise<void>;
  }>;
}>;

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
