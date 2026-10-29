import { consoleAllowedOriginEntries } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";

export function allowedCorsOrigin(pattern: string, origin: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(origin);
}

export function validateInteractionRequestOrigin(
  value: string | undefined,
  input: {
    corsAllowOriginRegex: string;
    consoleAllowedOrigins?: string | undefined;
    publicBaseUrl?: string | undefined;
    webBaseUrl?: string | undefined;
  },
): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HTTPException(400, { message: "invalid request origin" });
  }
  if (
    url.origin === "null" ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== value
  ) {
    throw new HTTPException(400, { message: "invalid request origin" });
  }
  if (isConfiguredBrowserOrigin(url.origin, input)) {
    return url.origin;
  }
  throw new HTTPException(403, { message: "request origin is not allowed" });
}

type BrowserOriginSettings = {
  corsAllowOriginRegex: string;
  consoleAllowedOrigins?: string | undefined;
  publicBaseUrl?: string | undefined;
  webBaseUrl?: string | undefined;
};

export function allowedCredentialedCorsOrigin(
  settings: Pick<BrowserOriginSettings, "corsAllowOriginRegex" | "consoleAllowedOrigins">,
  origin: string,
): boolean {
  return (
    allowedCorsOrigin(settings.corsAllowOriginRegex, origin) ||
    consoleAllowedOriginEntries(settings.consoleAllowedOrigins).includes(origin)
  );
}

function isConfiguredBrowserOrigin(origin: string, input: BrowserOriginSettings): boolean {
  return (
    allowedCredentialedCorsOrigin(input, origin) ||
    [input.publicBaseUrl, input.webBaseUrl].some((baseUrl) =>
      baseUrl ? new URL(baseUrl).origin === origin : false,
    )
  );
}

/**
 * Whether a present `Origin` header names a browser origin this deployment
 * serves its web app from: the CORS allowlist, the public base URL, or the
 * separate web base URL. `null` and malformed values are never allowed.
 */
export function isAllowedBrowserOrigin(value: string, input: BrowserOriginSettings): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.origin === "null" ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== value
  ) {
    return false;
  }
  return isConfiguredBrowserOrigin(url.origin, input);
}
