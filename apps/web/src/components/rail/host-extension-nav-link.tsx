// A host extension's nav item as a rail row or a menu row, styled like the
// native workspace shortcuts (`workspace-config-link.tsx`). Extension paths are
// not in the typed route tree, so the link goes through an untyped `to`.
import { Link } from "@tanstack/react-router";
import type { HostExtensionNavItem } from "@opengeni/react/app/host-extension";

import { cn } from "@opengeni/react/app/lib/utils";

/** The router target of an extension item, relative to its workspace. */
export function hostExtensionNavTarget(item: HostExtensionNavItem): string {
  return `/workspaces/$workspaceId/${item.path}`;
}

/** The item's static path prefix: its path up to the first `$param` segment. */
function staticPath(item: HostExtensionNavItem): string {
  const segments = item.path.split("/");
  const param = segments.findIndex((segment) => segment.startsWith("$"));
  return (param === -1 ? segments : segments.slice(0, param)).join("/");
}

/** Whether the item's page (or one below it) is open. */
export function isHostExtensionNavItemActive(
  pathname: string,
  workspaceId: string,
  item: HostExtensionNavItem,
): boolean {
  const destination = `/workspaces/${workspaceId}/${staticPath(item)}`;
  return pathname === destination || pathname.startsWith(`${destination}/`);
}

export function HostExtensionNavLink(props: {
  item: HostExtensionNavItem;
  workspaceId: string;
  variant: "rail" | "menu";
  active?: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { item, workspaceId, variant, active, collapsed, onNavigate } = props;
  const Icon = item.icon;
  const target = {
    to: hostExtensionNavTarget(item) as never,
    params: { workspaceId } as never,
  };

  if (variant === "menu") {
    return (
      <Link
        {...target}
        data-active={active ? "true" : undefined}
        title={item.description}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
          "hover:bg-hover hover:text-fg",
          active ? "bg-selection text-fg hover:bg-selection" : "text-fg",
        )}
        onClick={onNavigate}
      >
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </Link>
    );
  }

  return (
    <Link
      {...target}
      data-active={active ? "true" : undefined}
      aria-label={collapsed ? item.label : undefined}
      title={
        collapsed ? [item.label, item.description].filter(Boolean).join(" — ") : item.description
      }
      className={cn(
        "group relative flex h-8 items-center rounded-md text-sm font-normal text-fg-label transition-colors pointer-coarse:h-10",
        "hover:bg-hover hover:text-fg",
        "data-[active=true]:bg-selection data-[active=true]:text-fg data-[active=true]:hover:bg-selection",
        collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
      )}
      onClick={onNavigate}
    >
      <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity group-data-[active=true]:opacity-100" />
      <Icon className="size-4 shrink-0" />
      {!collapsed ? <span className="min-w-0 truncate">{item.label}</span> : null}
    </Link>
  );
}
