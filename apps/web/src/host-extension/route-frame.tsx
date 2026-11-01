// Loaded with the first extension rail page, never eagerly.
import { setChatPanelOpener } from "@opengeni/react/app/chat-panel";
import type { HostExtensionPage } from "@opengeni/react/app/host-extension";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { useLocation } from "@tanstack/react-router";
import { lazy, Suspense, useLayoutEffect, useSyncExternalStore } from "react";

import {
  chatPanelState,
  closeChatPanel,
  openChatPanelIn,
  showChatPanelSession,
  subscribeToChatPanel,
  type ChatPanelSeam,
} from "./chat-panel-state";
import type { HostExtensionPageFunction } from "./routes";

// The conversation code loads when a page first opens the panel, from the Site
// view's chunk, which already holds the same side chat: a lazy entry of its
// own would regroup the shared code-split chunks.
const HostChatPanel = lazy(() =>
  import("@opengeni/react/app/routes/site-view").then((module) => ({
    default: module.HostChatPanel,
  })),
);

/** The page inside the console's canonical page scroller (the default scroll contract). */
export function framedHostExtensionPage(
  Page: HostExtensionPage,
  chatPanel?: ChatPanelSeam,
): HostExtensionPageFunction {
  if (!chatPanel) {
    return function FramedHostExtensionPage({ workspaceId }: { workspaceId: string }) {
      return (
        <ContentPage>
          <Page workspaceId={workspaceId} />
        </ContentPage>
      );
    };
  }
  // With a chat panel the page and the panel share a row; the page keeps its
  // own scroller and the row is there whether or not the panel is open, so
  // opening it never remounts the page.
  return function FramedHostExtensionPageWithChat({ workspaceId }: { workspaceId: string }) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 max-lg:flex-col">
        <ContentPage>
          <Page workspaceId={workspaceId} />
        </ContentPage>
        <ChatPanelSlot seam={chatPanel} workspaceId={workspaceId} />
      </div>
    );
  };
}

let enabledReported = false;

function panelEnabled(
  panel: ChatPanelSeam["panel"],
  workspaceId: string,
  pathname: string,
): boolean {
  try {
    return panel.enabled({ workspaceId, pathname }) === true;
  } catch {
    if (!enabledReported) {
      enabledReported = true;
      console.warn("HOST_CHAT_PANEL_ENABLED_FAILED");
    }
    return false;
  }
}

/** Offers the panel while `chatPanel.enabled` answers true for this page, and shows it once opened. */
function ChatPanelSlot({ seam, workspaceId }: { seam: ChatPanelSeam; workspaceId: string }) {
  const { pathname } = useLocation();
  const enabled = panelEnabled(seam.panel, workspaceId, pathname);
  // Before the page's own effects run, so a page may open the panel as it mounts.
  useLayoutEffect(() => {
    if (!enabled) return;
    return setChatPanelOpener((context) => {
      openChatPanelIn(seam.validate, workspaceId, context);
      return true;
    });
  }, [enabled, seam, workspaceId]);
  const state = useSyncExternalStore(subscribeToChatPanel, chatPanelState, chatPanelState);
  if (!enabled || !state.open || state.workspaceId !== workspaceId) return null;
  return (
    <Suspense fallback={null}>
      <HostChatPanel
        workspaceId={workspaceId}
        context={state.context}
        sessionId={state.sessionId}
        openCount={state.openCount}
        onSessionChange={showChatPanelSession}
        onClose={closeChatPanel}
      />
    </Suspense>
  );
}
