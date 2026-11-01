import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AccessGrant, SessionCreateCreator } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import { sessionCreateCreatorForRequest } from "../src/routes/host-token";

const workspaceId = crypto.randomUUID();
const grant: AccessGrant = {
  accountId: crypto.randomUUID(),
  workspaceId,
  subjectId: "user:creator",
  principalKind: "human_session",
  permissions: ["sessions:create"],
};
// Construction needs no database: a credential is resolved only inside a host hook.
const deps = {
  settings: testSettings({
    publicBaseUrl: "https://native.example.test",
    hostTokenAudience: "host",
    consoleAllowedOrigins: ["https://native.example.test"],
  }),
  managedAuth: {},
} as ApiRouteDeps;

async function creatorFor(who: AccessGrant, headers: Record<string, string>, owner = deps) {
  let creator: SessionCreateCreator | undefined;
  const app = new Hono();
  app.post("/create", (context) => {
    creator = sessionCreateCreatorForRequest(context, owner, who);
    return context.json({ ready: true });
  });
  expect(
    (await app.request("https://native.example.test/create", { method: "POST", headers })).status,
  ).toBe(200);
  return creator!;
}

test("managed browser creates supply a lazy opaque reader with fixed refusal errors", async () => {
  const creator = await creatorFor(grant, {
    cookie: "fake-session",
    origin: "https://foreign.example.test",
  });
  expect(creator.principalKind).toBe("human_session");
  expect(typeof creator.readCredential).toBe("function");
  await expect(creator.readCredential!()).rejects.toThrow("Session creator credential unavailable");
  expect(JSON.stringify(creator)).toBe('{"principalKind":"human_session"}');
});

test.each(["service", "agent_attempt", "api_key", "configured_key", undefined] as const)(
  "%s never receives a human credential reader even with a cookie",
  async (principalKind) => {
    expect(await creatorFor({ ...grant, principalKind }, { cookie: "fake-session" })).toEqual({
      principalKind: principalKind ?? null,
    });
  },
);

test("bearer and absent-cookie callers never receive the browser credential reader", async () => {
  for (const headers of [{ authorization: "Bearer fake", cookie: "fake-session" }, {}]) {
    expect(await creatorFor(grant, headers)).toEqual({ principalKind: "human_session" });
  }
});

test("disabled host tokens retain stock create compatibility without manufacturing proof", async () => {
  expect(
    await creatorFor(
      grant,
      { cookie: "fake-session" },
      {
        ...deps,
        settings: testSettings({ hostTokenAudience: "" }),
      },
    ),
  ).toEqual({ principalKind: "human_session" });
});
