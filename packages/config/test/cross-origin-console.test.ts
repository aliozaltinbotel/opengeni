import { expect, test } from "bun:test";
import { getSettings } from "../src";

const managed = {
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_BETTER_AUTH_SECRET: "console-settings-secret-32-bytes-long",
  OPENGENI_DELEGATION_SECRET: "console-settings-delegation-secret",
  OPENGENI_PUBLIC_BASE_URL: "https://runtime.example.test",
};

test("stock console without an extension is unchanged", () => {
  const settings = getSettings({});
  expect(settings.consoleAllowedOrigins).toBeUndefined();
  expect(settings.betterAuthCookieDomain).toBeUndefined();
});

test("accepts exact console origins and reuses the existing cookie domain", () => {
  expect(
    getSettings({
      ...managed,
      OPENGENI_CONSOLE_ALLOWED_ORIGINS: "https://console.example.test, https://other.example.test",
      OPENGENI_BETTER_AUTH_COOKIE_DOMAIN: ".example.test",
    }),
  ).toMatchObject({
    consoleAllowedOrigins: "https://console.example.test, https://other.example.test",
    betterAuthCookieDomain: ".example.test",
  });
});

test("rejects invalid or wildcard console origins by setting name", () => {
  for (const origin of [
    "*",
    "https://*.example.test",
    "null",
    "file:///tmp/console",
    "https://console.example.test/path",
    "https://console.example.test?",
    "https://console.example.test#",
    "https://user:pass@console.example.test",
    "https://console.example.test/",
    "https://console.example.test:443",
  ]) {
    expect(() => getSettings({ ...managed, OPENGENI_CONSOLE_ALLOWED_ORIGINS: origin })).toThrow(
      "OPENGENI_CONSOLE_ALLOWED_ORIGINS",
    );
  }
});

test("cross-origin consoles require legacy session mode at startup", () => {
  for (const mode of ["dual", "broker"]) {
    expect(() =>
      getSettings({
        ...managed,
        OPENGENI_CONSOLE_ALLOWED_ORIGINS: "https://console.example.test",
        OPENGENI_MANAGED_AUTH_SESSION_SET_MODE: mode,
      }),
    ).toThrow(
      "OPENGENI_CONSOLE_ALLOWED_ORIGINS requires OPENGENI_MANAGED_AUTH_SESSION_SET_MODE=legacy",
    );
    expect(
      getSettings({ ...managed, OPENGENI_MANAGED_AUTH_SESSION_SET_MODE: mode })
        .managedAuthSessionSetMode,
    ).toBe(mode);
  }
});
