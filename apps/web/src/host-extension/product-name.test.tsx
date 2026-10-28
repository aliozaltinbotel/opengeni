// A host extension's productName names the console where it would say
// "Opengeni": the document title and link-preview tags, the panel that asks to
// reload after a new version, and voice's reload message.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { HostExtension } from "@opengeni/react/app/host-extension";

const extension: HostExtension = { id: "acme", productName: "Acme" };
void mock.module("@opengeni/web-host-extension", () => ({ default: extension }));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// index.html's static title and link-preview tags, before the startup module runs.
document.title = "Opengeni";
for (const property of ["og:title", "og:site_name"]) {
  const meta = document.createElement("meta");
  meta.setAttribute("property", property);
  meta.setAttribute("content", "Opengeni");
  document.head.append(meta);
}
await import("@/app-host");
const { RouteErrorPanel } = await import("@/components/route-error");
const { withVoiceDeploymentGuard } = await import("@/lib/voice-deployment-guard");
const { currentHostExtension } = await import("@/host-extension/registry");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("a host extension's productName", () => {
  test("names the document title and the link-preview title and site name", () => {
    expect(document.title).toBe("Acme");
    for (const property of ["og:title", "og:site_name"])
      expect(
        document.head.querySelector(`meta[property="${property}"]`)?.getAttribute("content"),
      ).toBe("Acme");
  });

  test("names the voice reload message", async () => {
    const guarded = withVoiceDeploymentGuard(
      { beginSessionRealtime: async () => ({ ok: true }) },
      {
        decide: async () => "reload",
        relaunch: () => undefined,
        prompt: () => undefined,
        productName: () => currentHostExtension().productName,
      },
    );
    await expect(guarded.beginSessionRealtime()).rejects.toThrow(
      "Acme was updated. Reloading to start voice…",
    );
  });

  test("names the update panel", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <RouteErrorPanel
          error={
            new TypeError(
              "Failed to fetch dynamically imported module: https://app.example.test/assets/page-1.js",
            )
          }
          reload={() => undefined}
        />,
      ),
    );
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("Acme has been updated");
      expect(text).toContain("an older version of Acme");
      expect(text).not.toContain("Opengeni");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
