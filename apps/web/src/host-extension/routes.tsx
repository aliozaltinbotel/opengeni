// The host extension's pages as children of the workspace route. Each page
// stays behind its own dynamic import, so a configured extension adds no page
// code to the initial load, and the stub adds no routes at all. Paths were
// checked at registration (registry.ts): none shadows a native route.
import { createRoute, lazyRouteComponent, useParams, type AnyRoute } from "@tanstack/react-router";
import type { HostExtensionRoute } from "@opengeni/react/app/host-extension";
import type { ReactElement } from "react";

/** A loaded extension page as a plain function component, the shape the lazy route wants. */
export type HostExtensionPageFunction = (props: { workspaceId: string }) => ReactElement;

/**
 * A rail page renders inside the console's default `ContentPage` scroller. A
 * settings page renders bare: the settings shell already draws that scroller
 * around every page it holds.
 */
async function loadPage(
  route: HostExtensionRoute,
): Promise<{ default: HostExtensionPageFunction }> {
  if (route.mode === "settings") {
    const { default: Page } = await route.load();
    return { default: ({ workspaceId }) => <Page workspaceId={workspaceId} /> };
  }
  const [{ default: page }, { framedHostExtensionPage }] = await Promise.all([
    route.load(),
    import("./route-frame"),
  ]);
  return { default: framedHostExtensionPage(page) };
}

function hostExtensionWorkspaceRoute(parent: AnyRoute, route: HostExtensionRoute): AnyRoute {
  const Page = lazyRouteComponent(() => loadPage(route));
  function HostExtensionRouteComponent() {
    const { workspaceId } = useParams({ strict: false });
    if (workspaceId === undefined) {
      throw new Error(`Host extension route "${route.path}" rendered outside a workspace`);
    }
    return <Page workspaceId={workspaceId} />;
  }
  return createRoute({
    getParentRoute: () => parent,
    path: route.path,
    component: HostExtensionRouteComponent,
  });
}

/** One lazy child route of `parent` per extension route, in declaration order. */
export function buildHostExtensionWorkspaceRoutes(
  parent: AnyRoute,
  routes: readonly HostExtensionRoute[] | undefined,
): AnyRoute[] {
  return (routes ?? []).map((route) => hostExtensionWorkspaceRoute(parent, route));
}
