// The page's Content-Security-Policy nonce, for libraries that inject <style>
// elements at run time. A host that serves the console under a nonce CSP (no
// 'unsafe-inline') puts the nonce in `<meta property="csp-nonce" nonce="…">`,
// the convention Vite's own preload helper reads. Installing it:
//
// - stamps the nonce on every <style> element the document creates
//   (`document.createElement`), which covers sonner's stylesheet injected at
//   module load, xterm's renderer styles and any other injector;
// - sets the global `__webpack_nonce__`, which get-nonce (and so
//   react-style-singleton under radix's scroll lock) reads.
//
// Only <style> is stamped: a <script> a page creates stays under the policy's
// own script-src. Parser-made elements (HTML strings) are never stamped.
// index.html runs the same steps inline before any module (keep in sync with
// its `opengeni-csp-nonce-bootstrap`), because bundled chunks can evaluate a
// library ahead of the entry's own first import.

type NonceDocument = Document & { __opengeniCspNonce?: string };

/** The nonce in `<meta property="csp-nonce">`, or undefined. */
export function readCspNonce(doc: Document): string | undefined {
  const meta = doc.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
  // Browsers hide a nonce attribute's value from getAttribute once applied.
  const value = meta?.nonce || meta?.getAttribute("nonce") || "";
  return value.trim() === "" ? undefined : value;
}

/**
 * Reads the page's nonce and installs it for style injectors; returns it, or
 * undefined (and changes nothing) when the page has none. Idempotent.
 */
export function installCspNonce(doc: Document = document): string | undefined {
  const target = doc as NonceDocument;
  if (target.__opengeniCspNonce) return target.__opengeniCspNonce;
  const nonce = readCspNonce(doc);
  if (!nonce) return undefined;
  const create: (this: Document, tagName: string, options?: ElementCreationOptions) => HTMLElement =
    doc.createElement;
  Object.defineProperty(doc, "createElement", {
    configurable: true,
    writable: true,
    value: function createElement(
      this: Document,
      tagName: string,
      options?: ElementCreationOptions,
    ): HTMLElement {
      const element = create.call(this, tagName, options);
      if (element.localName === "style") element.setAttribute("nonce", nonce);
      return element;
    },
  });
  Object.defineProperty(target, "__opengeniCspNonce", { configurable: true, value: nonce });
  (globalThis as { __webpack_nonce__?: string }).__webpack_nonce__ = nonce;
  return nonce;
}

/**
 * The page's CSP nonce for a host extension that injects its own <style> or
 * passes a `nonce` prop to a library; undefined when the page has none.
 */
export function cspNonce(doc: Document | undefined = globalThis.document): string | undefined {
  if (!doc) return undefined;
  return (doc as NonceDocument).__opengeniCspNonce ?? readCspNonce(doc);
}
