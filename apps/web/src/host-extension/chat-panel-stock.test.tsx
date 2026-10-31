// The stock console (the stub extension, no chatPanel) is unchanged by the
// chat panel seam: nothing offers a panel, `openChatPanel` changes nothing,
// and a rail page renders in exactly the frame it did before.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostExtensionPage } from "@opengeni/react/app/host-extension";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const Page: HostExtensionPage = ({ workspaceId }) => (
  <p data-testid="page">Page for {workspaceId}</p>
);

test("the stock console has no chat panel and openChatPanel changes nothing", async () => {
  const { hostExtension } = await import("./startup");
  const { openChatPanel } = await import("@opengeni/react/app/chat-panel");
  const { chatPanelState } = await import("./chat-panel-state");
  expect(hostExtension.id).toBe("none");
  expect(hostExtension.chatPanel).toBeUndefined();
  const before = chatPanelState();
  expect(openChatPanel([{ id: "stay", label: "Stay", text: "reservation: r-1" }])).toBe(false);
  expect(chatPanelState()).toBe(before);
  expect(before.open).toBe(false);
});

test("a rail page without a chat panel renders in the unchanged ContentPage frame", async () => {
  const { framedHostExtensionPage } = await import("./route-frame");
  const Framed = framedHostExtensionPage(Page);
  expect(renderToStaticMarkup(<Framed workspaceId="w1" />)).toBe(
    renderToStaticMarkup(
      <ContentPage>
        <Page workspaceId="w1" />
      </ContentPage>,
    ),
  );
});
