---
"@opengeni/react": minor
---

The web console runs under a host's nonce Content-Security-Policy without `'unsafe-inline'`: when the page carries `<meta property="csp-nonce" nonce="…">` (Vite's convention), an inline bootstrap in `index.html` and the main entry stamp that nonce on every `<style>` element the document creates (sonner, xterm and other style injectors) and set `__webpack_nonce__` for get-nonce (radix's scroll lock), before any module runs. Only `<style>` elements are stamped; scripts stay under the policy's `script-src`. New exports: `nonce()` from `@opengeni/react/app/host-extension` for host extensions, and `installCspNonce`, `readCspNonce` and `cspNonce` from `@opengeni/react/app/lib/csp-nonce`. A page without the meta is unchanged.
