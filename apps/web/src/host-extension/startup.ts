// The one module that imports this build's host extension (the configured
// bundle, or the stock stub, through the `@opengeni/web-host-extension`
// specifier) and installs it. Only the main entry reaches it, through
// app-host.ts and App.tsx: the descriptor's import() pages then never sit in a
// module that lazy routes import, which would reshuffle the startup chunks.
// registry.test.ts fails when any other console module imports the specifier.
import extension from "@opengeni/web-host-extension";
import { installHostExtension } from "./registry";

/** This build's validated host extension, installed for every console module. */
export const hostExtension = installHostExtension(extension);
