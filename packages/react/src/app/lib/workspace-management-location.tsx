import { parseOrganizationSection, type OrganizationAdminSection } from "./organization-admin";

/**
 * Workspace settings pages, addressed by `?section=` on `/settings`. Settings
 * hold configuration only: the settings rail also links to the Agents and
 * Insights dashboards and the runtime pages, which open as their own pages.
 * Organization settings (`/organization?section=`) share the same settings
 * rail, under its Organization section.
 */
export type WorkspaceSettingsSection =
  | "general"
  | "access"
  | "models"
  | "usage"
  | "api-keys"
  | "developer"
  | "learning";

/**
 * Older `?section=` values. They keep working: Members is now Access, Danger
 * zone is the last row of General, and Capabilities is its own page.
 */
export type LegacyWorkspaceSettingsSection = "members" | "danger" | "plugins" | "capabilities";

export const WORKSPACE_SETTINGS_SECTIONS: readonly WorkspaceSettingsSection[] = [
  "general",
  "access",
  "models",
  "usage",
  "api-keys",
  "developer",
  "learning",
];

const WORKSPACE_PAGE_TARGETS = [
  "/workspaces/$workspaceId/insights",
  "/workspaces/$workspaceId/secrets",
  "/workspaces/$workspaceId/rigs",
  "/workspaces/$workspaceId/machines",
  "/workspaces/$workspaceId/computer-use",
] as const;
export type WorkspacePageTarget = (typeof WORKSPACE_PAGE_TARGETS)[number];

export type WorkspaceManagementLocation =
  /** `section` is null when the URL asks for the settings list itself. */
  | { kind: "settings"; section: WorkspaceSettingsSection | null }
  | { kind: "page"; target: WorkspacePageTarget }
  /** `section` is null when the URL names no (or an unknown) organization page. */
  | { kind: "organization"; section: OrganizationAdminSection | null }
  /** A host extension page registered with `mode: "settings"`; `path` is its registered pattern. */
  | { kind: "extension"; path: string };

/** Parses `?section=`, mapping older names to the page that holds them now. */
export function workspaceSettingsSectionFromSearch(
  value: unknown,
): WorkspaceSettingsSection | null {
  if (WORKSPACE_SETTINGS_SECTIONS.includes(value as WorkspaceSettingsSection)) {
    return value as WorkspaceSettingsSection;
  }
  if (value === "members") return "access";
  if (value === "danger") return "general";
  return null;
}

/**
 * Whether `pathname` is exactly the extension route `path` under the workspace
 * `base`. A `$param` segment matches any one non-empty segment.
 */
function matchesExtensionPath(pathname: string, base: string, path: string): boolean {
  if (!pathname.startsWith(`${base}/`)) return false;
  const actual = pathname.slice(base.length + 1).split("/");
  const expected = path.split("/");
  return (
    actual.length === expected.length &&
    expected.every((segment, index) =>
      segment.startsWith("$") ? actual[index] !== "" : actual[index] === segment,
    )
  );
}

/**
 * Resolve the workspace routes that open in settings mode: the settings rail
 * replaces the main rail. Matching is segment-aware: `/rigs/:rigId` belongs to
 * Sandbox environments, while a future `/rigs-archive` route is not captured.
 * `extensionSettingsPaths` are the host extension's settings-mode route paths;
 * each matches only its own URL, never a deeper one.
 */
export function workspaceManagementLocation(
  pathname: string,
  workspaceId: string,
  settingsSection?: unknown,
  extensionSettingsPaths: readonly string[] = [],
): WorkspaceManagementLocation | null {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  if (pathname === `${base}/settings`) {
    return {
      kind: "settings",
      section: workspaceSettingsSectionFromSearch(settingsSection),
    };
  }
  if (pathname === `${base}/organization`) {
    return { kind: "organization", section: parseOrganizationSection(settingsSection) ?? null };
  }

  for (const target of WORKSPACE_PAGE_TARGETS) {
    const targetPath = target.replace("$workspaceId", encodeURIComponent(workspaceId));
    if (pathname === targetPath || pathname.startsWith(`${targetPath}/`)) {
      return { kind: "page", target };
    }
  }
  const extensionPath = extensionSettingsPaths.find((path) =>
    matchesExtensionPath(pathname, base, path),
  );
  return extensionPath === undefined ? null : { kind: "extension", path: extensionPath };
}

type WorkspaceParams = { workspaceId: string };

/** Where switching to another workspace lands, as navigation options. */
export type WorkspaceSwitchTarget =
  | {
      to: "/workspaces/$workspaceId/settings";
      params: WorkspaceParams;
      search: { section?: WorkspaceSettingsSection };
    }
  | { to: WorkspacePageTarget; params: WorkspaceParams }
  | {
      to: "/workspaces/$workspaceId/organization";
      params: WorkspaceParams;
      search: { section?: OrganizationAdminSection };
    }
  | { to: "/workspaces/$workspaceId/sessions"; params: WorkspaceParams };

/**
 * Where switching to `nextWorkspaceId` lands from `location`: the same settings
 * page, dashboard, organization page or host extension settings page there, or
 * that workspace's sessions outside settings mode. An extension page addressed
 * by its own ids (`$params`) names a record of this workspace, so the next
 * workspace opens on its settings instead.
 */
export function workspaceSwitchTarget(
  location: WorkspaceManagementLocation | null,
  nextWorkspaceId: string,
): WorkspaceSwitchTarget {
  const params = { workspaceId: nextWorkspaceId };
  switch (location?.kind) {
    case "settings":
      return {
        to: "/workspaces/$workspaceId/settings",
        params,
        search: location.section ? { section: location.section } : {},
      };
    case "page":
      return { to: location.target, params };
    case "organization":
      return {
        to: "/workspaces/$workspaceId/organization",
        params,
        search: location.section ? { section: location.section } : {},
      };
    case "extension":
      return location.path.includes("$")
        ? { to: "/workspaces/$workspaceId/settings", params, search: {} }
        : // Extension paths are registered at build time, outside the typed route tree.
          { to: `/workspaces/$workspaceId/${location.path}` as never, params };
    case undefined:
      return { to: "/workspaces/$workspaceId/sessions", params };
  }
}
