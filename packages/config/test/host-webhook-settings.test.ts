import { expect, test } from "bun:test";
import { getSettings } from "../src";

const url = "OPENGENI_HOST_WEBHOOK_MCP_CONNECTION_REVOKED_URL";
const secret = "OPENGENI_HOST_WEBHOOK_MCP_CONNECTION_REVOKED_SECRET";

test("the MCP connection revoked host webhook is off unless configured", () => {
  expect(getSettings({}).hostWebhooks).toBeUndefined();
});

test("its URL and secret configure it together", () => {
  const settings = getSettings({
    [url]: "https://host.example.test/hooks/opengeni",
    [secret]: "host-webhook-secret-of-at-least-32-chars",
  });
  expect(settings.hostWebhooks?.mcpConnectionRevoked).toEqual({
    url: "https://host.example.test/hooks/opengeni",
    secret: "host-webhook-secret-of-at-least-32-chars",
  });
  expect(() => getSettings({ [url]: "https://host.example.test/hooks" })).toThrow();
  expect(() => getSettings({ [secret]: "host-webhook-secret-of-at-least-32-chars" })).toThrow();
  expect(() =>
    getSettings({ [url]: "https://host.example.test/hooks", [secret]: "short" }),
  ).toThrow();
  expect(() =>
    getSettings({ [url]: "ftp://host.example.test/hooks", [secret]: "x".repeat(32) }),
  ).toThrow();
});

test("a plain http URL is refused at startup outside local/test, and allowed in local and test", () => {
  const http = {
    [url]: "http://host.internal/hooks",
    [secret]: "host-webhook-secret-of-at-least-32-chars",
  };
  expect(() => getSettings({ ...http, OPENGENI_ENVIRONMENT: "production" })).toThrow(
    "HOST_WEBHOOK_URL_HTTPS_REQUIRED",
  );
  for (const environment of ["local", "test"])
    expect(getSettings({ ...http, OPENGENI_ENVIRONMENT: environment }).hostWebhooks).toBeDefined();
  expect(
    getSettings({
      ...http,
      [url]: "https://host.example.test/hooks",
      OPENGENI_ENVIRONMENT: "production",
    }).hostWebhooks,
  ).toBeDefined();
});
