// index.html's inline nonce bootstrap runs before any module: with a meta
// nonce ahead of it, every <style> the page creates carries the nonce, and
// the module install afterwards changes nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFile } from "node:fs/promises";

import { installCspNonce } from "@opengeni/react/app/lib/csp-nonce";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

async function bootstrapSource(): Promise<string> {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  const match = html.match(/<script id="opengeni-csp-nonce-bootstrap">([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("index.html has no CSP nonce bootstrap");
  return match[1];
}

describe("index.html CSP nonce bootstrap", () => {
  test("stamps the meta nonce on created styles before any module, and the module agrees", async () => {
    const meta = document.createElement("meta");
    meta.setAttribute("property", "csp-nonce");
    meta.setAttribute("nonce", "inline-n0nce");
    document.head.append(meta);
    new Function(await bootstrapSource())();
    const wrapped = document.createElement;
    expect(document.createElement("style").getAttribute("nonce")).toBe("inline-n0nce");
    expect(document.createElement("script").hasAttribute("nonce")).toBe(false);
    expect((globalThis as { __webpack_nonce__?: string }).__webpack_nonce__).toBe("inline-n0nce");
    expect(installCspNonce(document)).toBe("inline-n0nce");
    expect(document.createElement).toBe(wrapped);
  });

  test("the bootstrap follows the setup-account bootstrap, which stays first", async () => {
    const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
    const scripts = Array.from(html.matchAll(/<script id="([^"]+)"/g), (match) => match[1]);
    expect(scripts[0]).toBe("opengeni-setup-account-bootstrap");
    expect(scripts).toContain("opengeni-csp-nonce-bootstrap");
  });
});
