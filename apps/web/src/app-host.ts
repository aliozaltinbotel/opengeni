// The web app backs the shared session UI with its own router, API helpers and
// optional heavy surfaces, as the page that owns the document. main.tsx
// imports this first, before any session surface renders.
import { apiBaseUrl, request, requestResponse, voiceRealtimeClient } from "@/api";
// Configures navigation itself, so tests can import only the router part.
import "@/navigation-host";
import type { AppApiHost } from "@opengeni/react/app/lib/app-api";
import { configurePageAppHost } from "@opengeni/react/app/lib/app-host";
import { lazySurface } from "@opengeni/react/app/lib/app-surfaces";
import type { HostExtensionContext } from "@opengeni/react/app/host-extension";
import { createHostMessageContextStore } from "@opengeni/react/app/lib/message-context";
import { createHostMessageContextResolver, createHostStartersResolver } from "@/host-extension/registry";
import { guardHostSessionIndicator } from "@opengeni/react/app/components/session-indicator";
import { hostExtension } from "@/host-extension/startup";

export const webAppApiHost: AppApiHost = {
  apiBaseUrl,
  request,
  requestResponse,
  voiceRealtimeClient,
};

const extensionMessageContext = hostExtension.messageContext
  ? createHostMessageContextResolver(hostExtension.messageContext)
  : undefined;

configurePageAppHost({
  api: webAppApiHost,
  toolRegistryEntries: hostExtension.toolRegistryEntries,
  hiddenNativeDestinations: hostExtension.hiddenNativeDestinations,
  brand: hostExtension.brand,
  productName: hostExtension.productName,
  workspaceFilter: hostExtension.workspaceFilter,
  lifecycle: hostExtension.lifecycle,
  extensionMessageContext,
  // New-chat creation runs above the workspace provider and reads this shared store.
  messageContext: extensionMessageContext
    ? createHostMessageContextStore(extensionMessageContext, (): HostExtensionContext => {
        const pathname = window.location.pathname;
        const workspaceId = /^\/workspaces\/([^/]+)/.exec(pathname)?.[1] ?? "";
        return { pathname, workspaceId: decodeURIComponent(workspaceId) };
      })
    : undefined,
  starters: hostExtension.starters ? createHostStartersResolver(hostExtension.starters) : undefined,
  sessionIndicator: hostExtension.sessionIndicator ? guardHostSessionIndicator(hostExtension.sessionIndicator) : undefined,
  surfaces: {
    pdfPreview: lazySurface(() => import("@/components/artifacts/pdf-file-preview")),
    codexSubscriptions: lazySurface(async () => ({
      default: (await import("@/components/models/codex-models")).CodexSubscriptionsCard,
    })),
    editableArtifact: lazySurface(() =>
      import("@/routes/editable-artifact").then((module) => ({
        default: module.EditableArtifactRoute,
      })),
    ),
  },
});

// index.html names the stock product; a host extension's product names the
// tab and the page's link-preview title and site name.
if (hostExtension.productName && typeof document !== "undefined") {
  const productName = hostExtension.productName;
  document.title = productName;
  for (const property of ["og:title", "og:site_name"])
    document.head
      .querySelector(`meta[property="${property}"]`)
      ?.setAttribute("content", productName);
}
