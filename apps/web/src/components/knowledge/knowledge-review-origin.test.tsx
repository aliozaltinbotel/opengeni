// Where a change waiting in Review came from links to its chat or automation,
// except an automation when the host extension hides Automations.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { configurePageAppHost } from "@opengeni/react/app/lib/app-host";
import { renderInRouter } from "../../../test/fixtures/host-extension-nav-harness";
import { OriginLink, type Origin } from "./knowledge-review";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => configurePageAppHost({ hiddenNativeDestinations: undefined }));
afterAll(() => GlobalRegistrator.unregister());

const automation: Origin = { kind: "schedule", name: "Nightly digest", taskId: "t1" };
const chat: Origin = { kind: "chat", name: "Migrate billing", sessionId: "s1" };

async function originLinks(origin: Origin) {
  const view = await renderInRouter(() => <OriginLink workspaceId="w1" origin={origin} />);
  const text = view.container.textContent;
  const hrefs = Array.from(view.container.querySelectorAll("a")).map((link) =>
    link.getAttribute("href"),
  );
  await view.done();
  return { text, hrefs };
}

describe("review origin", () => {
  test("links an automation and a chat in the stock console", async () => {
    expect(await originLinks(automation)).toEqual({
      text: "From automation Nightly digest",
      hrefs: ["/workspaces/w1/automations?taskId=t1"],
    });
    expect((await originLinks(chat)).hrefs).toEqual(["/workspaces/w1/sessions/s1"]);
  });

  test("names a hidden automation as plain text, and still links a chat", async () => {
    configurePageAppHost({ hiddenNativeDestinations: ["automations"] });
    expect(await originLinks(automation)).toEqual({
      text: "From automation Nightly digest",
      hrefs: [],
    });
    expect((await originLinks(chat)).hrefs).toEqual(["/workspaces/w1/sessions/s1"]);
  });
});
