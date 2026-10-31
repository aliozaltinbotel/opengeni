import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { cspNonce, installCspNonce, readCspNonce } from "./csp-nonce";

const NONCE = "r4nd0m-n0nce";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

/** A fresh document whose head carries `<meta property="csp-nonce">` (or none). */
function page(nonce: string | null): Document {
  const doc = document.implementation.createHTMLDocument("console");
  if (nonce !== null) {
    const meta = doc.createElement("meta");
    meta.setAttribute("property", "csp-nonce");
    meta.setAttribute("nonce", nonce);
    doc.head.append(meta);
  }
  return doc;
}

describe("CSP nonce", () => {
  test("accepts the name meta supplied by existing host edges", () => {
    const doc = page(null);
    const meta = doc.createElement("meta");
    meta.setAttribute("name", "csp-nonce");
    meta.setAttribute("nonce", NONCE);
    doc.head.append(meta);
    expect(readCspNonce(doc)).toBe(NONCE);
    expect(installCspNonce(doc)).toBe(NONCE);
    expect(doc.createElement("style").getAttribute("nonce")).toBe(NONCE);
  });

  test("with a meta nonce, every <style> the document creates carries it", () => {
    const doc = page(NONCE);
    expect(installCspNonce(doc)).toBe(NONCE);
    const style = doc.createElement("style");
    doc.head.append(style);
    expect(style.getAttribute("nonce")).toBe(NONCE);
    expect(doc.createElement("STYLE").getAttribute("nonce")).toBe(NONCE);
    // Only styles: scripts stay under the policy's own script-src.
    expect(doc.createElement("script").hasAttribute("nonce")).toBe(false);
    expect(doc.createElement("div").hasAttribute("nonce")).toBe(false);
    expect((globalThis as { __webpack_nonce__?: string }).__webpack_nonce__).toBe(NONCE);
    expect(cspNonce(doc)).toBe(NONCE);
  });

  test("a style injected by a library at module load carries the nonce", async () => {
    const meta = document.createElement("meta");
    meta.setAttribute("property", "csp-nonce");
    meta.setAttribute("nonce", NONCE);
    document.head.append(meta);
    installCspNonce(document);
    await import("sonner");
    const injected = Array.from(document.head.querySelectorAll("style")).filter((style) =>
      style.textContent?.includes("[data-sonner-toaster]"),
    );
    expect(injected.length).toBeGreaterThan(0);
    for (const style of injected) expect(style.getAttribute("nonce")).toBe(NONCE);
  });

  test("installing twice keeps one wrapper and the first nonce", () => {
    const doc = page(NONCE);
    installCspNonce(doc);
    const wrapped = doc.createElement;
    expect(installCspNonce(doc)).toBe(NONCE);
    expect(doc.createElement).toBe(wrapped);
  });

  test("without a meta nonce nothing is installed", () => {
    const doc = page(null);
    const create = doc.createElement;
    expect(installCspNonce(doc)).toBeUndefined();
    expect(doc.createElement).toBe(create);
    expect(doc.createElement("style").hasAttribute("nonce")).toBe(false);
    expect(cspNonce(doc)).toBeUndefined();
    expect(readCspNonce(page("  "))).toBeUndefined();
  });
});
