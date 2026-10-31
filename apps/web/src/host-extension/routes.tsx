// The host extension's pages as children of the workspace route. Each page
// stays behind its own dynamic import, so a configured extension adds no page
// code to the initial load, and the stub adds no routes at all. Paths were
// checked at registration (registry.ts): none shadows a native route.
import { createRoute, lazyRouteComponent, useParams, type AnyRoute } from "@tanstack/react-router";
import type {
  HostExtensionChatPanel,
  HostExtensionOutsideWorkspaceRoute,
  HostExtensionRoute,
} from "@opengeni/react/app/host-extension";
import type { ComponentType, ReactElement, ReactNode } from "react";

import type { ChatPanelSeam } from "./chat-panel-state";
import { validateHostMessageContext } from "./registry";

/** A loaded extension page as a plain function component, the shape the lazy route wants. */
export type HostExtensionPageFunction = (props: { workspaceId: string }) => ReactElement;

/**
 * A rail page renders inside the console's default `ContentPage` scroller. A
 * settings page renders bare: the settings shell already draws that scroller
 * around every page it holds.
 */
async function loadPage(
  route: HostExtensionRoute,
  chatPanel: ChatPanelSeam | undefined,
): Promise<{ default: HostExtensionPageFunction }> {
  if (route.mode === "settings") {
    const { default: Page } = await route.load();
    return { default: ({ workspaceId }) => <Page workspaceId={workspaceId} /> };
  }
  const [{ default: page }, { framedHostExtensionPage }] = await Promise.all([
    route.load(),
    import("./route-frame"),
  ]);
  return { default: framedHostExtensionPage(page, chatPanel) };
}

function hostExtensionWorkspaceRoute(
  parent: AnyRoute,
  route: HostExtensionRoute,
  chatPanel: ChatPanelSeam | undefined,
): AnyRoute {
  const Page = lazyRouteComponent(() => loadPage(route, chatPanel));
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

/**
 * One lazy child route of `parent` per extension route, in declaration order.
 * With the extension's `chatPanel`, each rail page's frame offers the chat
 * panel. It and the console's context check are handed to the frame, not
 * imported there: a lazy module's edge into the startup registry regroups the
 * startup chunks.
 */
export function buildHostExtensionWorkspaceRoutes(
  parent: AnyRoute,
  routes: readonly HostExtensionRoute[] | undefined,
  chatPanel?: HostExtensionChatPanel,
): AnyRoute[] {
  const seam = chatPanel && { panel: chatPanel, validate: validateHostMessageContext };
  return (routes ?? []).map((route) => hostExtensionWorkspaceRoute(parent, route, seam));
}

/** Nests `providers` around `children`, the first outermost. */
function withProviders(
  providers: readonly ComponentType<{ children: ReactNode }>[],
  children: ReactNode,
): ReactNode {
  return providers.reduceRight<ReactNode>(
    (inner, Provider) => <Provider>{inner}</Provider>,
    children,
  );
}

function hostExtensionOutsideWorkspaceRoute(
  parent: AnyRoute,
  route: HostExtensionOutsideWorkspaceRoute,
  providers: readonly ComponentType<{ children: ReactNode }>[],
): AnyRoute {
  // The loaded page as a plain function component, the shape the lazy route wants.
  const Page = lazyRouteComponent(async (): Promise<{ default: () => ReactElement }> => {
    const { default: Loaded } = await route.load();
    return { default: () => <Loaded /> };
  });
  function HostExtensionOutsideWorkspaceRouteComponent() {
    return withProviders(providers, <Page />);
  }
  return createRoute({
    getParentRoute: () => parent,
    path: route.path,
    component: HostExtensionOutsideWorkspaceRouteComponent,
  });
}

/**
 * One lazy child route of the root per outside-workspace page, in declaration
 * order, each inside `providers`. Paths were checked at registration: none
 * shares a first segment with a native top-level route.
 */
export function buildHostExtensionOutsideWorkspaceRoutes(
  parent: AnyRoute,
  routes: readonly HostExtensionOutsideWorkspaceRoute[] | undefined,
  providers: readonly ComponentType<{ children: ReactNode }>[] | undefined,
): AnyRoute[] {
  return (routes ?? []).map((route) =>
    hostExtensionOutsideWorkspaceRoute(parent, route, providers ?? []),
  );
}
