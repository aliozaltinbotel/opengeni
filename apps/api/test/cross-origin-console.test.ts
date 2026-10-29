import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { createDb, createManagedOrganization, type DbClient } from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createAppComposition } from "../src/app";
import { Hono } from "hono";
import { Pool } from "pg";
import { requireSameOriginBrowserMutation } from "../src/http/browser-mutation-origin";

const apiOrigin = "https://runtime.example.test";
const consoleOrigin = "https://console.example.test";
let shared: SharedTestDatabase;
let client: DbClient;
const authPools: Pool[] = [];

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("cross-origin-console");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await Promise.all(authPools.map((pool) => pool.end()));
  await client?.close();
  await shared?.release();
}, 60_000);

function settings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    databaseUrl: shared.adminUrl,
    productAccessMode: "managed",
    betterAuthSecret: "cross-origin-console-secret-32-bytes-long",
    publicBaseUrl: apiOrigin,
    hostTokenAudience: "https://host.example.test/api",
    ...overrides,
  });
}

async function managedApp(configuration: Settings) {
  const { app, routeDeps } = createAppComposition({
    settings: configuration,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  if (!routeDeps.managedAuth) throw new Error("Managed auth was not constructed");
  // Better Auth deliberately skips origin checks under bun:test. Exercise its
  // real production middleware instead of inheriting that test-only bypass.
  (await routeDeps.managedAuth.$context).skipOriginCheck = false;
  const authDatabase: unknown = routeDeps.managedAuth.options.database;
  if (authDatabase instanceof Pool) authPools.push(authDatabase);
  return app;
}

type ManagedApp = Awaited<ReturnType<typeof managedApp>>;

function cookieHeader(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Sign-in did not set a session cookie");
  return cookie;
}

async function signIn(app: ManagedApp, origin: string) {
  const email = `console-${crypto.randomUUID()}@example.test`;
  const password = "password1234";
  await shared.admin`delete from auth_rate_limits`;
  const signup = await app.request(`${apiOrigin}/v1/auth/sign-up/email`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "sec-fetch-site": origin === apiOrigin ? "same-origin" : "same-site",
    },
    body: JSON.stringify({ email, password, name: "Console person" }),
  });
  expect(signup.status).toBe(200);
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const response = await app.request(`${apiOrigin}/v1/auth/sign-in/email`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "sec-fetch-site": origin === apiOrigin ? "same-origin" : "same-site",
    },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  expect(response.status).toBe(200);
  const [user] = await shared.admin<
    { id: string }[]
  >`select id from auth_users where email = ${email}`;
  if (!user) throw new Error("Sign-in did not create an auth user");
  return {
    response,
    cookie: cookieHeader(response).split(";", 1)[0] ?? "",
    email,
    userId: user.id,
  };
}

function configured(overrides: Partial<Settings> = {}): Settings {
  return settings({ consoleAllowedOrigins: consoleOrigin, ...overrides });
}

describe("legacy console origins with real Better Auth", () => {
  test("a console on an allow-listed origin can sign in, keep the session and mint a host token cross-origin", async () => {
    const app = await managedApp(configured());
    const signedIn = await signIn(app, consoleOrigin);
    expect(signedIn.response.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
    expect(signedIn.response.headers.get("access-control-allow-credentials")).toBe("true");
    const headers = {
      origin: consoleOrigin,
      cookie: signedIn.cookie,
      "sec-fetch-site": "same-site",
    };
    const session = await app.request(`${apiOrigin}/v1/auth/get-session`, { headers });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { id: signedIn.userId } });
    await createManagedOrganization(client.db, {
      subjectId: `user:${signedIn.userId}`,
      subjectLabel: signedIn.email,
      name: "Console organization",
      operationId: crypto.randomUUID(),
    });
    const access = await app.request(`${apiOrigin}/v1/access/me`, { headers });
    expect(access.status).toBe(200);
    expect(access.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
    const grants = (await access.json()) as { workspaceGrants: Array<{ workspaceId: string }> };
    const workspace = grants.workspaceGrants[0];
    if (!workspace) throw new Error("Organization did not expose a workspace");
    const minted = await app.request(
      `${apiOrigin}/v1/auth/host-token?workspace=${workspace.workspaceId}`,
      { headers },
    );
    expect(minted.status).toBe(200);
    expect(minted.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
    expect(await minted.json()).toMatchObject({
      token: expect.any(String),
      expiresAt: expect.any(String),
    });
    const bearer = await app.request(
      `${apiOrigin}/v1/auth/host-token?workspace=${workspace.workspaceId}`,
      { headers: { ...headers, authorization: "Bearer not-a-browser-session" } },
    );
    expect(bearer.status).toBe(401);
  });

  test("an origin not on the list gets no CORS credentials and cannot mint even with a valid cookie", async () => {
    const app = await managedApp(configured());
    const signedIn = await signIn(app, apiOrigin);
    for (const origin of [
      "https://unknown.example.test",
      "null",
      "https://console.example.test.attacker.test",
    ]) {
      const denied = await app.request(`${apiOrigin}/v1/auth/host-token?purpose=registration`, {
        headers: { origin, cookie: signedIn.cookie },
      });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
      expect(denied.headers.get("access-control-allow-origin")).not.toBe(origin);
    }
    const deniedSignIn = await app.request(`${apiOrigin}/v1/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: "https://unknown.example.test",
        "content-type": "application/json",
        "sec-fetch-site": "same-site",
      },
      body: JSON.stringify({ email: signedIn.email, password: "password1234" }),
    });
    expect(deniedSignIn.status).toBe(403);
  });

  test("auth state changes retain real Better Auth origin checks", async () => {
    const app = await managedApp(configured());
    const signedIn = await signIn(app, consoleOrigin);
    const mutation = (origin: string) =>
      app.request(`${apiOrigin}/v1/auth/sign-out`, {
        method: "POST",
        headers: {
          origin,
          cookie: signedIn.cookie,
          "sec-fetch-site": "same-site",
          "content-type": "application/json",
        },
        body: "{}",
      });
    expect((await mutation("https://unknown.example.test")).status).toBe(403);
    expect((await mutation(consoleOrigin)).status).toBe(200);
    const ended = await app.request(`${apiOrigin}/v1/auth/get-session`, {
      headers: { origin: consoleOrigin, cookie: signedIn.cookie },
    });
    expect(await ended.json()).toBeNull();
  });

  test("a preflight for the auth routes answers exactly the allow-listed origin", async () => {
    const app = await managedApp(configured());
    for (const path of ["/v1/auth/sign-in/email", "/v1/auth/host-token", "/v1/access/me"]) {
      const preflight = await app.request(`${apiOrigin}${path}`, {
        method: "OPTIONS",
        headers: {
          origin: consoleOrigin,
          "access-control-request-method": path.endsWith("email") ? "POST" : "GET",
          "access-control-request-headers": "content-type,authorization",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
      expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
      expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
      expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
      expect(preflight.headers.get("vary")).toContain("Origin");
      const denied = await app.request(`${apiOrigin}${path}`, {
        method: "OPTIONS",
        headers: { origin: "https://unknown.example.test", "access-control-request-method": "GET" },
      });
      expect(denied.status).toBe(204);
      expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
      expect(denied.headers.get("access-control-allow-origin")).not.toBe(consoleOrigin);
    }
  });

  test("stock console without an extension is unchanged", async () => {
    const app = await managedApp(settings());
    const signedIn = await signIn(app, apiOrigin);
    const cookie = cookieHeader(signedIn.response);
    expect(cookie.includes("SameSite=Lax")).toBe(true);
    expect(cookie.includes("Secure")).toBe(true);
    expect(cookie.includes("Domain=")).toBe(false);
    expect(cookie.includes("Partitioned")).toBe(false);
    const session = await app.request(`${apiOrigin}/v1/auth/get-session`, {
      headers: { cookie: signedIn.cookie },
    });
    expect(await session.json()).toMatchObject({ user: { id: signedIn.userId } });
    const minted = await app.request(`${apiOrigin}/v1/auth/host-token?purpose=registration`, {
      headers: { cookie: signedIn.cookie, origin: apiOrigin },
    });
    expect(minted.status).toBe(200);
  });

  test("the configured session cookie domain preserves SameSite Lax", async () => {
    const app = await managedApp(configured({ betterAuthCookieDomain: ".example.test" }));
    const signedIn = await signIn(app, consoleOrigin);
    const cookie = cookieHeader(signedIn.response);
    expect(cookie.includes("Domain=.example.test")).toBe(true);
    expect(cookie.includes("SameSite=Lax")).toBe(true);
    expect(cookie.includes("Secure")).toBe(true);
    expect(cookie.includes("Partitioned")).toBe(false);
  });

  test("only explicitly allowed consoles may use cross-origin JSON browser mutations", async () => {
    const configuration = configured({ betterAuthTrustedOrigins: "https://existing.example.test" });
    const app = new Hono();
    app.post("/mutation", (context) => {
      requireSameOriginBrowserMutation(context, { settings: configuration } as never);
      return context.json({ ok: true });
    });
    for (const fetchSite of ["same-site"]) {
      const admitted = await app.request(`${apiOrigin}/mutation`, {
        method: "POST",
        headers: {
          origin: consoleOrigin,
          "sec-fetch-site": fetchSite,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(admitted.status).toBe(200);
      const existing = await app.request(`${apiOrigin}/mutation`, {
        method: "POST",
        headers: {
          origin: "https://existing.example.test",
          "sec-fetch-site": fetchSite,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(existing.status).toBe(403);
    }
    const unsupportedSite = await app.request(`${apiOrigin}/mutation`, {
      method: "POST",
      headers: {
        origin: consoleOrigin,
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(unsupportedSite.status).toBe(403);
    const missingMetadata = await app.request(`${apiOrigin}/mutation`, {
      method: "POST",
      headers: { origin: consoleOrigin, "content-type": "application/json" },
      body: "{}",
    });
    expect(missingMetadata.status).toBe(403);
    const invalidContent = await app.request(`${apiOrigin}/mutation`, {
      method: "POST",
      headers: {
        origin: consoleOrigin,
        "sec-fetch-site": "same-site",
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(invalidContent.status).toBe(403);
  });
});
