import { expect, test } from "bun:test";
import { getSettings } from "../src";

const managed = {
  OPENGENI_PRODUCT_ACCESS_MODE: "managed",
  OPENGENI_BETTER_AUTH_SECRET: "host-token-settings-secret-32-bytes",
  OPENGENI_DELEGATION_SECRET: "host-token-settings-delegation-secret",
  OPENGENI_PUBLIC_BASE_URL: "http://localhost:3000",
};

test("the host session token is off unless an audience is configured", () => {
  const settings = getSettings({});
  expect(settings.hostTokenAudience).toBeUndefined();
  expect(settings.hostTokenTtlSeconds).toBe(300);
});

test("an audience enables the token with a bounded lifetime", () => {
  const settings = getSettings({
    ...managed,
    OPENGENI_HOST_TOKEN_AUDIENCE: " https://host.example.test/api ",
    OPENGENI_HOST_TOKEN_TTL_SECONDS: "900",
  });
  expect(settings.hostTokenAudience).toBe("https://host.example.test/api");
  expect(settings.hostTokenTtlSeconds).toBe(900);
  for (const ttl of ["901", "0", "12.5"]) {
    expect(() =>
      getSettings({
        ...managed,
        OPENGENI_HOST_TOKEN_AUDIENCE: "https://host.example.test/api",
        OPENGENI_HOST_TOKEN_TTL_SECONDS: ttl,
      }),
    ).toThrow();
  }
});

test("an audience requires managed product access", () => {
  expect(() =>
    getSettings({ OPENGENI_HOST_TOKEN_AUDIENCE: "https://host.example.test/api" }),
  ).toThrow("OPENGENI_HOST_TOKEN_AUDIENCE requires OPENGENI_PRODUCT_ACCESS_MODE=managed");
});
