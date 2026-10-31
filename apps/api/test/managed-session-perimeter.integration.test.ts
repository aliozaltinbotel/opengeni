import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type DbClient } from "@opengeni/db";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("managed-session-key-perimeter");
  if (!acquired) throw new Error("real PostgreSQL is required for managed-session perimeter proof");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4, rlsStrategy: "force" });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function cookiePairs(response: Response): string {
  return response.headers.getSetCookie()
    .map((value) => value.split(";", 1)[0] ?? "")
    .filter((value) => value !== "" && !value.endsWith("="))
    .join("; ");
}

function headers(cookie?: string): Record<string, string> {
  return {
    origin: "http://opengeni.test",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    ...(cookie === undefined ? {} : { cookie }),
  };
}

describe("real managed cookie with an enabled deployment-key perimeter", () => {
  test("verified password login reaches bootstrap; forged, absent, expired, revoked and wrong-mode authority refuses", async () => {
    const mail: ManagedEmailMessage[] = [];
    const emailTransport: ManagedEmailTransport = {
      sender: "auth@example.test",
      idempotency: { scope: "test:managed-perimeter", retentionSeconds: 86_400 },
      send: async (message) => {
        mail.push(message);
        return { status: "sent", providerMessageId: null };
      },
    };
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "managed",
        managedAuthSessionSetMode: "legacy",
        managedAuthRequireEmailVerification: true,
        betterAuthSecret: "synthetic-managed-perimeter-test-secret-32",
        publicBaseUrl: "http://opengeni.test",
        authRequired: true,
        accessKey: "synthetic-server-only-deployment-key",
      }),
      managedEmailTransport: emailTransport,
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    const email = `perimeter-${crypto.randomUUID()}@example.test`;
    const password = "Synthetic-password-42!";
    const signup = await app.request("/v1/auth/sign-up/email", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ name: "Synthetic Inspector", email, password }),
    });
    expect(signup.status).toBe(200);
    const verification = mail.findLast((message) => message.kind === "email_verification" && message.to === email);
    const link = verification?.text.match(/https?:\/\/\S+/)?.[0];
    if (!link) throw new Error("normal email verification was not delivered");
    const verificationUrl = new URL(link);
    const verified = await app.request(`${verificationUrl.pathname}${verificationUrl.search}`, { headers: headers() });
    expect(verified.status).toBeLessThan(400);
    const signin = await app.request("/v1/auth/sign-in/email", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signin.status).toBe(200);
    const cookie = cookiePairs(signin);
    expect(cookie.length).toBeGreaterThan(0);
    for (const path of ["/v1/access/me", "/v1/workspaces", "/v1/organization-memberships"]) {
      expect((await app.request(path, { headers: headers(cookie) })).status).toBe(200);
      expect((await app.request(path, { headers: headers() })).status).toBe(401);
      expect((await app.request(path, { headers: headers("better-auth.session_token=forged") })).status).toBe(401);
    }
    expect((await app.request("/metrics", { headers: headers(cookie) })).status).toBe(401);
    for (const explicit of [{ authorization: "Bearer invalid" }, { "x-opengeni-access-key": "invalid" }]) {
      expect((await app.request("/v1/access/me", { headers: { ...headers(cookie), ...explicit } })).status).toBe(401);
    }
    const configured = createApp({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        productAccessMode: "configured",
        authRequired: true,
        accessKey: "synthetic-server-only-deployment-key",
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });
    // Disabling managed mode cannot turn its cookie into configured authority.
    for (const path of ["/v1/access/me", "/v1/workspaces", "/v1/organization-memberships"]) {
      expect((await configured.request(path, { headers: headers(cookie) })).status).toBe(401);
    }
    const signout = await app.request("/v1/auth/sign-out", { method: "POST", headers: headers(cookie) });
    expect(signout.status).toBe(200);
    for (const path of ["/v1/access/me", "/v1/workspaces", "/v1/organization-memberships"]) {
      expect((await app.request(path, { headers: headers(cookie) })).status).toBe(401);
    }
    const freshSignin = await app.request("/v1/auth/sign-in/email", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(freshSignin.status).toBe(200);
    const expiryCookie = cookiePairs(freshSignin);
    const sessionResponse = await app.request("/v1/auth/get-session", { headers: headers(expiryCookie) });
    expect(sessionResponse.status).toBe(200);
    const current = await sessionResponse.json() as { session?: { id?: unknown } };
    const sessionId = current.session?.id;
    if (typeof sessionId !== "string") throw new Error("normal login did not produce a session");
    // Expire only this genuine synthetic session; never extend or fabricate authority.
    const expired = await shared.admin<{ id: string }[]>`
      update auth_sessions set expires_at = now() - interval '1 second'
      where id = ${sessionId} returning id`;
    expect(expired).toHaveLength(1);
    for (const path of ["/v1/access/me", "/v1/workspaces", "/v1/organization-memberships"]) {
      expect((await app.request(path, { headers: headers(expiryCookie) })).status).toBe(401);
    }
  }, 60_000);
});
