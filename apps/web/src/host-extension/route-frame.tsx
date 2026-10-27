// Loaded with the first extension rail page, never eagerly.
import type { HostExtensionPage } from "@opengeni/react/app/host-extension";
import { ContentPage } from "@opengeni/react/ui/content-layout";

import type { HostExtensionPageFunction } from "./routes";

/** The page inside the console's canonical page scroller (the default scroll contract). */
export function framedHostExtensionPage(Page: HostExtensionPage): HostExtensionPageFunction {
  function FramedHostExtensionPage({ workspaceId }: { workspaceId: string }) {
    return (
      <ContentPage>
        <Page workspaceId={workspaceId} />
      </ContentPage>
    );
  }
  return FramedHostExtensionPage;
}
