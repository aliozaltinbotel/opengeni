// The main entry's first import: installs the page's CSP nonce for style
// injectors (idempotent after index.html's inline bootstrap, which runs first
// in production; this covers the dev server and tests).
import { installCspNonce } from "@opengeni/react/app/lib/csp-nonce";

if (typeof document !== "undefined") installCspNonce(document);
