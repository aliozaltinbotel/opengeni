// Build-time resolution of the console's host extension. The console imports
// the fixed specifier `@opengeni/web-host-extension` (and its `/style.css`);
// OPENGENI_WEB_HOST_EXTENSION names an absolute directory holding a built
// `index.js` and `style.css`. Unset or empty, the stock no-op stub is used, so
// the console builds exactly as stock.
import { statSync } from "node:fs";
import path from "node:path";

import type { Alias } from "vite";

export type HostExtensionFiles = Readonly<{ entry: string; style: string }>;

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The extension entry and stylesheet for this build: the configured directory's
 * `index.js` and `style.css`, or the stub's when nothing is configured.
 * Throws `HOST_EXTENSION_INCOMPLETE` for a configured directory that is not
 * absolute or lacks either file, rather than silently building stock.
 */
export function resolveHostExtensionFiles(
  configured: string | undefined,
  stubDirectory: string,
): HostExtensionFiles {
  const directory = configured?.trim();
  if (!directory) {
    return {
      entry: path.join(stubDirectory, "index.ts"),
      style: path.join(stubDirectory, "style.css"),
    };
  }
  if (!path.isAbsolute(directory)) {
    throw new Error(
      `HOST_EXTENSION_INCOMPLETE: OPENGENI_WEB_HOST_EXTENSION must be an absolute directory, got "${directory}"`,
    );
  }
  const files = {
    entry: path.join(directory, "index.js"),
    style: path.join(directory, "style.css"),
  };
  const missing = [files.entry, files.style].filter((file) => !isFile(file));
  if (missing.length > 0) {
    throw new Error(
      `HOST_EXTENSION_INCOMPLETE: OPENGENI_WEB_HOST_EXTENSION "${directory}" has no ${missing
        .map((file) => path.basename(file))
        .join(" or ")}`,
    );
  }
  return files;
}

/** Exact-match aliases, so the stylesheet specifier never resolves under the entry. */
export function hostExtensionAliases(files: HostExtensionFiles): Alias[] {
  return [
    { find: /^@opengeni\/web-host-extension\/style\.css$/, replacement: files.style },
    { find: /^@opengeni\/web-host-extension$/, replacement: files.entry },
  ];
}

/**
 * The build-time flag the console reads as
 * `import.meta.env.OPENGENI_WEB_HOST_EXTENSION_STOCK`: the string "true" when no
 * extension is configured (env values are strings). Code that only checks an extension (for example its tool-card
 * names against the built-in cards) is then dead in a stock build and is
 * dropped from the startup bundle. Outside a Vite build the property is
 * undefined, so those checks run.
 */
export const HOST_EXTENSION_STOCK_DEFINE = "import.meta.env.OPENGENI_WEB_HOST_EXTENSION_STOCK";

/** Vite `define` entries for this build's host extension setting. */
export function hostExtensionDefine(configured: string | undefined): Record<string, string> {
  return { [HOST_EXTENSION_STOCK_DEFINE]: JSON.stringify(String(!configured?.trim())) };
}
