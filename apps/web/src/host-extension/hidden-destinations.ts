// A hidden native destination has no route at all: its URL then matches
// nothing under the workspace and renders the console's not-found page, the
// same as any unknown URL, so it reveals nothing more than stock not-found.
import type { AnyRoute } from "@tanstack/react-router";
import {
  isWorkspaceSegmentHidden,
  type NativeDestination,
} from "@opengeni/react/app/host-extension";

function firstSegment(route: AnyRoute): string {
  const path = (route.options as { path?: string }).path ?? "";
  return path.replace(/^\//, "").split("/")[0] ?? "";
}

/**
 * The workspace's child routes without those whose first segment opens a
 * hidden destination (nested children go with their parent). The result keeps
 * the input's type so the typed route tree still names every native route;
 * links to a hidden one are filtered at their link sources.
 */
export function visibleNativeRoutes<const T extends readonly AnyRoute[]>(
  routes: T,
  hidden: readonly NativeDestination[],
): T {
  if (hidden.length === 0) return routes;
  const visible: readonly AnyRoute[] = routes.filter(
    (route) => !isWorkspaceSegmentHidden(firstSegment(route), hidden),
  );
  return visible as T;
}
