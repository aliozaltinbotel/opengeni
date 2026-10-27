import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
  type ManagedAuthSessionSetProjection,
} from "@opengeni/contracts/managed-auth-session-sets";
import {
  MANAGED_AUTH_ACTOR_EPOCH_HEADER,
  MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE,
  MANAGED_AUTH_SESSION_SET_COOKIE,
} from "@opengeni/core/managed-auth-session-sets";
import { createDb, createManagedOrganization, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { sql } from "drizzle-orm";

import { createApp } from "../src/app";
import { MANAGED_AUTH_PRODUCT_CREDENTIAL_RATE_LIMIT } from "../src/auth/managed-auth-rate-limits";
import { apiRequestBindingsForTransportPeer } from "../src/http/request-source";

/* End to end through the real app, Better Auth and PostgreSQL: a host session
   token's auth_time and amr come from the session's latest authentication,
   which only a sign-in or POST /v1/auth/reauthenticate advances. With TOTP
   enabled an enrolled person re-authenticates with their authenticator code,
   and the token's amr says so. */

const origin = "http://opengeni.test";
const audience = "https://host.example.test/api";
const password = "password1234";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("reauthenticate");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function managedApp(overrides: Partial<Settings> = {}) {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "reauthenticate-test-secret-32-bytes-long",
      publicBaseUrl: origin,
      ...overrides,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
}

type ManagedApp = ReturnType<typeof managedApp>;

const stepUpApp = () => managedApp({ hostTokenAudience: audience, managedAuthTotpEnabled: true });

/** Every caller gets its own client address, so rate-limit windows never mix. */
function freshPeer(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

type Caller = { app: ManagedApp; cookie: string; peer: string };

async function call(
  caller: Pick<Caller, "app" | "peer">,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return await caller.app.request(path, init, apiRequestBindingsForTransportPeer(caller.peer));
}

function post(
  caller: Caller & { headers?: Record<string, string> },
  path: string,
  body: unknown,
  cookie = caller.cookie,
) {
  return call(caller, path, {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...caller.headers,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Better Auth response did not set a session cookie");
  return cookie.split(";", 1)[0]!;
}

async function signIn(app: ManagedApp, email: string): Promise<Response> {
  return await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
}

/** A signed-up member of their own organization, signed in an hour ago. */
async function member(app: ManagedApp, name: string) {
  const email = `reauth-${crypto.randomUUID()}@example.test`;
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const cookie = sessionCookie(await signIn(app, email));
  const [user] = await shared.admin<
    { id: string }[]
  >`select id from auth_users where email = ${email}`;
  const subjectId = `user:${user!.id}`;
  await createManagedOrganization(client.db, {
    subjectId,
    subjectLabel: email,
    name: `${name} Org`,
    operationId: crypto.randomUUID(),
  });
  const access = (await (await app.request("/v1/access/me", { headers: { cookie } })).json()) as {
    accountGrants: Array<{ accountId: string }>;
    workspaceGrants: Array<{ workspaceId: string; accountId: string }>;
  };
  const organizationId = access.accountGrants[0]!.accountId;
  const workspaceId = access.workspaceGrants.find(
    (grant) => grant.accountId === organizationId,
  )!.workspaceId;
  const session = await sessionRow(cookie);
  const signedInAt = new Date(Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000);
  await shared.admin`update auth_sessions set created_at = ${signedInAt} where id = ${session.id}`;
  return {
    app,
    cookie,
    peer: freshPeer(),
    email,
    userId: user!.id,
    workspaceId,
    sessionId: session.id,
    signedInAt,
  };
}

async function sessionRow(cookie: string) {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".", 1)[0]!;
  const [row] = await shared.admin<
    { id: string; created_at: Date; updated_at: Date; expires_at: Date }[]
  >`select id, created_at, updated_at, expires_at from auth_sessions where token = ${token}`;
  if (!row) throw new Error("session row not found");
  return row;
}

/** Mint a host token for the caller's workspace and return its verified claims. */
async function hostTokenClaims(
  caller: Caller & { workspaceId: string; headers?: Record<string, string> },
) {
  const response = await call(
    caller,
    `/v1/auth/host-token?workspace=${encodeURIComponent(caller.workspaceId)}`,
    { headers: { ...caller.headers, cookie: caller.cookie } },
  );
  expect(response.status).toBe(200);
  const { token } = (await response.json()) as { token: string };
  const jwks = (await (await caller.app.request("/v1/auth/jwks")).json()) as JSONWebKeySet;
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
    issuer: origin,
    audience,
    algorithms: ["ES256"],
  });
  return payload as typeof payload & { auth_time: number; amr: string[]; sid: string };
}

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.code).toBe(code);
  return body;
}

const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** The raw TOTP secret from an otpauth:// URI, as the authenticator app sees it. */
function totpSecret(totpURI: string): string {
  const encoded = new URL(totpURI).searchParams.get("secret");
  if (!encoded) throw new Error("TOTP URI has no secret");
  return new TextDecoder().decode(base32.decode(encoded));
}

/** The authenticator code `offset` 30-second steps from now. */
async function totpCode(secret: string, offset = 0): Promise<string> {
  return await createOTP(secret).hotp(Math.floor(Date.now() / 30_000) + offset);
}

async function enrollTotp(caller: Caller & { headers?: Record<string, string> }): Promise<string> {
  const enroll = await post(caller, "/v1/auth/totp/enroll", { password });
  expect(enroll.status).toBe(200);
  const { totpURI } = (await enroll.json()) as { totpURI: string };
  expect(totpURI.startsWith("otpauth://totp/Opengeni:")).toBe(true);
  const secret = totpSecret(totpURI);
  const confirm = await post(caller, "/v1/auth/totp/confirm", { code: await totpCode(secret) });
  expect(confirm.status).toBe(200);
  expect(await confirm.json()).toEqual({ status: "enrolled" });
  return secret;
}

/** Let the next code in the current step be accepted again (tests only). */
async function forgetUsedCodes(userId: string) {
  await shared.admin`update auth_two_factors set last_used_counter = null where user_id = ${userId}`;
}

describe("re-authentication, stock deployment", () => {
  test("re-authentication and TOTP routes are absent without the settings", async () => {
    const app = managedApp();
    const person = await member(app, "Stock Person");

    await expectRefusal(
      await post(person, "/v1/auth/reauthenticate", { password }),
      404,
      "REAUTH_DISABLED",
    );
    await expectRefusal(
      await call(person, "/v1/auth/reauthenticate", { headers: { cookie: person.cookie } }),
      404,
      "REAUTH_DISABLED",
    );
    await expectRefusal(
      await call(person, "/v1/auth/totp", { headers: { cookie: person.cookie } }),
      404,
      "TOTP_DISABLED",
    );
    await expectRefusal(
      await post(person, "/v1/auth/totp/enroll", { password }),
      404,
      "TOTP_DISABLED",
    );
    // Better Auth has no twoFactor plugin, so its routes do not exist.
    expect((await post(person, "/v1/auth/two-factor/enable", { password })).status).toBe(404);
    const config = (await (await app.request("/v1/config/client")).json()) as Record<
      string,
      unknown
    >;
    expect(config).not.toHaveProperty("managedAuthTotp");
    const [column] = await shared.admin<{ two_factor_enabled: boolean }[]>`
      select two_factor_enabled from auth_users where id = ${person.userId}
    `;
    expect(column!.two_factor_enabled).toBe(false);
  }, 60_000);

  test("a host token audience alone offers password re-authentication without TOTP", async () => {
    const app = managedApp({ hostTokenAudience: audience });
    const person = await member(app, "Audience Person");
    const status = await call(person, "/v1/auth/reauthenticate", {
      headers: { cookie: person.cookie },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ password: true, totpRequired: false });
    const reauth = await post(person, "/v1/auth/reauthenticate", { password });
    expect(reauth.status).toBe(200);
    expect(((await reauth.json()) as { amr: string[] }).amr).toEqual(["pwd"]);
    await expectRefusal(
      await call(person, "/v1/auth/totp", { headers: { cookie: person.cookie } }),
      404,
      "TOTP_DISABLED",
    );
    const config = (await (await app.request("/v1/config/client")).json()) as Record<
      string,
      unknown
    >;
    expect(config).not.toHaveProperty("managedAuthTotp");
  }, 60_000);
});

describe("host token auth_time and amr", () => {
  test("auth_time is the sign-in time, and a session refresh never changes it", async () => {
    const app = stepUpApp();
    const person = await member(app, "Refresh Person");

    const first = await hostTokenClaims(person);
    expect(first.auth_time).toBe(epochSeconds(person.signedInAt));
    expect(first.amr).toEqual(["pwd"]);

    // Better Auth renews a session read once its update age (one day) has
    // passed since the last renewal, judged from the expiry: pretend the last
    // renewal was 25 hours ago, then read the session.
    await shared.admin`
      update auth_sessions
      set updated_at = now() - interval '25 hours',
        expires_at = now() + interval '7 days' - interval '25 hours'
      where id = ${person.sessionId}
    `;
    const before = await sessionRow(person.cookie);
    const read = await app.request("/v1/auth/get-session", { headers: { cookie: person.cookie } });
    expect(read.status).toBe(200);
    const after = await sessionRow(person.cookie);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime());

    const refreshed = await hostTokenClaims(person);
    expect(refreshed.auth_time).toBe(epochSeconds(person.signedInAt));
    expect(refreshed.amr).toEqual(["pwd"]);
  }, 60_000);

  test("re-authenticating with the password advances auth_time with amr pwd", async () => {
    const app = stepUpApp();
    const person = await member(app, "Password Person");
    const before = await hostTokenClaims(person);

    const response = await post(person, "/v1/auth/reauthenticate", { password });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as { authTime: string; amr: string[] };
    expect(Object.keys(body).sort()).toEqual(["amr", "authTime"]);
    expect(body.amr).toEqual(["pwd"]);
    const authTime = new Date(body.authTime);
    expect(Math.abs(authTime.getTime() - Date.now())).toBeLessThan(60_000);

    const after = await hostTokenClaims(person);
    expect(after.auth_time).toBe(epochSeconds(authTime));
    expect(after.auth_time).toBeGreaterThan(before.auth_time);
    expect(after.amr).toEqual(["pwd"]);
    // Same session: re-authentication never signs in again.
    expect(after.sid).toBe(before.sid);
    expect((await sessionRow(person.cookie)).created_at.getTime()).toBe(
      person.signedInAt.getTime(),
    );
  }, 60_000);

  test("ending a re-authenticated session as the runtime role removes its events", async () => {
    const app = stepUpApp();
    const person = await member(app, "Sign Out Person");
    expect((await post(person, "/v1/auth/reauthenticate", { password })).status).toBe(200);
    // Sign-out and revocation delete the session as the runtime role, which
    // has no DELETE on the event table: the cascade must still apply.
    const [role] = await client.db.execute<{ role: string }>(sql`select current_user as role`);
    expect(role!.role).not.toBe("postgres");
    await client.db.execute(sql`delete from auth_sessions where id = ${person.sessionId}`);
    const [events] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from auth_session_authentications
      where auth_session_id = ${person.sessionId}
    `;
    expect(events!.count).toBe(0);
  }, 60_000);

  test("a wrong password is REAUTH_FAILED and leaves auth_time unchanged", async () => {
    const app = stepUpApp();
    const person = await member(app, "Wrong Password Person");

    await expectRefusal(
      await post(person, "/v1/auth/reauthenticate", { password: "not-the-password" }),
      401,
      "REAUTH_FAILED",
    );
    // No password and no fresh social sign-in proves nothing either.
    await expectRefusal(await post(person, "/v1/auth/reauthenticate", {}), 401, "REAUTH_FAILED");
    const [events] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from auth_session_authentications
      where auth_session_id = ${person.sessionId}
    `;
    expect(events!.count).toBe(0);
    const claims = await hostTokenClaims(person);
    expect(claims.auth_time).toBe(epochSeconds(person.signedInAt));
  }, 60_000);

  test("re-authentication needs the browser session and a same-origin JSON request", async () => {
    const app = stepUpApp();
    const person = await member(app, "Session Person");
    await expectRefusal(
      await post(person, "/v1/auth/reauthenticate", { password }, ""),
      401,
      "REAUTH_SESSION_REQUIRED",
    );
    const bearer = await call(person, "/v1/auth/reauthenticate", {
      method: "POST",
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        authorization: "Bearer og_not_a_session",
        cookie: person.cookie,
      },
      body: JSON.stringify({ password }),
    });
    expect(bearer.status).not.toBe(200);
    const crossSite = await call(person, "/v1/auth/reauthenticate", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
        cookie: person.cookie,
      },
      body: JSON.stringify({ password }),
    });
    expect(crossSite.status).toBe(403);
    await expectRefusal(
      await post(person, "/v1/auth/reauthenticate", { password, extra: true }),
      400,
      "REAUTH_INVALID_REQUEST",
    );
  }, 60_000);

  test("a session whose sign-in method is unknown is refused HOST_TOKEN_AMR_UNKNOWN", async () => {
    const app = stepUpApp();
    const person = await member(app, "Unknown Method Person");
    const [binding] = await shared.admin<{ login_binding_id: string }[]>`
      select login_binding_id from auth_sessions where id = ${person.sessionId}
    `;
    // The session's login binding now names a provider with no RFC 8176 method.
    await shared.admin`
      update canonical_human_login_bindings set provider_id = 'test-oidc'
      where id = ${binding!.login_binding_id}
    `;
    const response = await call(
      person,
      `/v1/auth/host-token?workspace=${encodeURIComponent(person.workspaceId)}`,
      { headers: { cookie: person.cookie } },
    );
    const body = await expectRefusal(response, 403, "HOST_TOKEN_AMR_UNKNOWN");
    expect(body).not.toHaveProperty("token");
  }, 60_000);
});

describe("TOTP re-authentication", () => {
  test("an enrolled person needs the code, and a valid code adds otp to amr", async () => {
    const app = stepUpApp();
    const person = await member(app, "TOTP Person");
    const config = (await (await app.request("/v1/config/client")).json()) as Record<
      string,
      unknown
    >;
    expect(config.managedAuthTotp).toEqual({ enabled: true });
    expect(
      await (await call(person, "/v1/auth/totp", { headers: { cookie: person.cookie } })).json(),
    ).toEqual({ status: "none" });
    const before = await hostTokenClaims(person);

    const secret = await enrollTotp(person);
    expect(
      await (await call(person, "/v1/auth/totp", { headers: { cookie: person.cookie } })).json(),
    ).toEqual({ status: "enrolled" });
    const [user] = await shared.admin<{ two_factor_enabled: boolean }[]>`
      select two_factor_enabled from auth_users where id = ${person.userId}
    `;
    expect(user!.two_factor_enabled).toBe(true);
    // Enrolling neither rotates the session nor counts as an authentication.
    const enrolled = await hostTokenClaims(person);
    expect(enrolled.sid).toBe(before.sid);
    expect(enrolled.auth_time).toBe(before.auth_time);
    expect(enrolled.amr).toEqual(["pwd"]);
    await expectRefusal(
      await post(person, "/v1/auth/totp/enroll", { password }),
      409,
      "TOTP_ALREADY_ENROLLED",
    );

    const status = await call(person, "/v1/auth/reauthenticate", {
      headers: { cookie: person.cookie },
    });
    expect(await status.json()).toEqual({ password: true, totpRequired: true });
    await expectRefusal(
      await post(person, "/v1/auth/reauthenticate", { password }),
      400,
      "REAUTH_TOTP_REQUIRED",
    );
    const wrongCode = (Number(await totpCode(secret, 1)) + 1) % 1_000_000;
    await expectRefusal(
      await post(person, "/v1/auth/reauthenticate", {
        password,
        totp: String(wrongCode).padStart(6, "0"),
      }),
      401,
      "REAUTH_FAILED",
    );
    // The password is checked before the code is asked for.
    await expectRefusal(
      await post(person, "/v1/auth/reauthenticate", { password: "not-the-password" }),
      401,
      "REAUTH_FAILED",
    );
    expect((await hostTokenClaims(person)).auth_time).toBe(before.auth_time);

    const code = await totpCode(secret, 1);
    const response = await post(person, "/v1/auth/reauthenticate", { password, totp: code });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authTime: string; amr: string[] };
    expect(body.amr).toEqual(["pwd", "otp"]);
    const after = await hostTokenClaims(person);
    expect(after.amr).toEqual(["pwd", "otp"]);
    expect(after.auth_time).toBe(epochSeconds(new Date(body.authTime)));
    expect(after.auth_time).toBeGreaterThan(before.auth_time);
    expect(after.sid).toBe(before.sid);

    // A code is accepted once.
    await expectRefusal(
      await post(person, "/v1/auth/reauthenticate", { password, totp: code }),
      401,
      "REAUTH_FAILED",
    );
  }, 60_000);

  test("sign-in is unchanged for an enrolled person: TOTP is a step-up factor only", async () => {
    const app = stepUpApp();
    const person = await member(app, "Sign In Person");
    await enrollTotp(person);
    const again = await signIn(app, person.email);
    expect(again.status).toBe(200);
    const body = (await again.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("twoFactorRedirect");
    const cookie = sessionCookie(again);
    const claims = await hostTokenClaims({ ...person, cookie });
    expect(claims.amr).toEqual(["pwd"]);
  }, 60_000);

  test("disabling needs the password and a code, and never rotates the session", async () => {
    const app = stepUpApp();
    const person = await member(app, "Disable Person");
    const before = await hostTokenClaims(person);
    const secret = await enrollTotp(person);
    await forgetUsedCodes(person.userId);

    await expectRefusal(
      await post(person, "/v1/auth/totp/disable", { code: await totpCode(secret) }),
      401,
      "TOTP_AUTHENTICATION_REQUIRED",
    );
    await expectRefusal(
      await post(person, "/v1/auth/totp/disable", { password, code: "000000" }),
      400,
      "TOTP_INVALID_CODE",
    );
    const disabled = await post(person, "/v1/auth/totp/disable", {
      password,
      code: await totpCode(secret),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ status: "none" });
    const [user] = await shared.admin<{ two_factor_enabled: boolean }[]>`
      select two_factor_enabled from auth_users where id = ${person.userId}
    `;
    expect(user!.two_factor_enabled).toBe(false);

    const after = await hostTokenClaims(person);
    expect(after.sid).toBe(before.sid);
    expect(after.auth_time).toBe(before.auth_time);
    const reauth = await post(person, "/v1/auth/reauthenticate", { password });
    expect(reauth.status).toBe(200);
    expect(((await reauth.json()) as { amr: string[] }).amr).toEqual(["pwd"]);
  }, 60_000);

  test("enrollment needs the password and a confirmed code", async () => {
    const app = stepUpApp();
    const person = await member(app, "Enroll Person");
    await expectRefusal(
      await post(person, "/v1/auth/totp/enroll", { password: "not-the-password" }),
      401,
      "TOTP_AUTHENTICATION_REQUIRED",
    );
    await expectRefusal(
      await post(person, "/v1/auth/totp/confirm", { code: "123456" }),
      409,
      "TOTP_ENROLLMENT_NOT_STARTED",
    );
    const enroll = await post(person, "/v1/auth/totp/enroll", { password });
    expect(enroll.status).toBe(200);
    const { totpURI } = (await enroll.json()) as { totpURI: string };
    expect(
      await (await call(person, "/v1/auth/totp", { headers: { cookie: person.cookie } })).json(),
    ).toEqual({ status: "pending" });
    // A pending factor is not enrolled: re-authentication does not ask for it.
    const pending = await post(person, "/v1/auth/reauthenticate", { password });
    expect(((await pending.json()) as { amr: string[] }).amr).toEqual(["pwd"]);
    await expectRefusal(
      await post(person, "/v1/auth/totp/confirm", { code: "000000" }),
      400,
      "TOTP_INVALID_CODE",
    );
    const confirm = await post(person, "/v1/auth/totp/confirm", {
      code: await totpCode(totpSecret(totpURI)),
    });
    expect(confirm.status).toBe(200);
  }, 60_000);

  test("the plugin's own two-factor routes are refused", async () => {
    const app = stepUpApp();
    const person = await member(app, "Plugin Route Person");
    for (const path of [
      "/v1/auth/two-factor/enable",
      "/v1/auth/two-factor/verify-totp",
      "/v1/auth/two-factor/disable",
      "/v1/auth/two-factor/get-totp-uri",
      "/v1/auth/two-factor/generate-backup-codes",
      "/v1/auth/two-factor/verify-backup-code",
      "/v1/auth/two-factor/send-otp",
    ]) {
      const response = await post(person, path, { password, code: "123456" });
      expect(response.status).toBe(404);
    }
    const [factor] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from auth_two_factors where user_id = ${person.userId}
    `;
    expect(factor!.count).toBe(0);
  }, 60_000);
});

describe("re-authentication rate limits", () => {
  test("one client address gets the email sign-in limit: 20 attempts per minute", async () => {
    const app = stepUpApp();
    const caller = { app, cookie: "", peer: freshPeer() };
    const { max } = MANAGED_AUTH_PRODUCT_CREDENTIAL_RATE_LIMIT;
    expect(MANAGED_AUTH_PRODUCT_CREDENTIAL_RATE_LIMIT).toEqual({ window: 60, max: 20 });
    for (let attempt = 0; attempt < max; attempt++) {
      const response = await post(caller, "/v1/auth/reauthenticate", { password });
      expect(response.status).toBe(401);
    }
    const limited = await post(caller, "/v1/auth/reauthenticate", { password });
    await expectRefusal(limited, 429, "REAUTH_RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another address is unaffected.
    const other = await post({ ...caller, peer: freshPeer() }, "/v1/auth/reauthenticate", {
      password,
    });
    expect(other.status).toBe(401);
  }, 60_000);

  test("password guesses spend the person's email sign-in throttle", async () => {
    const app = stepUpApp();
    const person = await member(app, "Throttled Person");
    // MANAGED_AUTH_EMAIL_THROTTLES["/sign-in/email"].perSourceMax attempts.
    for (let attempt = 0; attempt < 10; attempt++) {
      await expectRefusal(
        await post(person, "/v1/auth/reauthenticate", { password: "not-the-password" }),
        401,
        "REAUTH_FAILED",
      );
    }
    await expectRefusal(
      await post(person, "/v1/auth/reauthenticate", { password }),
      429,
      "REAUTH_RATE_LIMITED",
    );
  }, 60_000);
});

function oneCookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!value) throw new Error(`response omitted ${name}`);
  return value.split(";", 1)[0]!;
}

function sessionSetHeaders(projection: ManagedAuthSessionSetProjection): Record<string, string> {
  return {
    [MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER]: MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
    "x-opengeni-session-csrf": projection.csrfToken,
    [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: projection.actorEpoch,
  };
}

/** Sign up and select one account through the broker session-set flow. */
async function brokerMember(app: ManagedApp, name: string) {
  const mutation = (projection: ManagedAuthSessionSetProjection, cookie: string) => ({
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    ...sessionSetHeaders(projection),
    cookie,
  });
  const initialResponse = await app.request("/v1/auth/session-set");
  const initial = (await initialResponse.json()) as ManagedAuthSessionSetProjection;
  const authority = oneCookie(initialResponse, MANAGED_AUTH_SESSION_SET_COOKIE);
  const email = `reauth-set-${crypto.randomUUID()}@example.test`;
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: authority },
    body: JSON.stringify({ name, email, password }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const begin = await app.request("/v1/auth/session-set/transactions", {
    method: "POST",
    headers: mutation(initial, authority),
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedGeneration: initial.generation,
      kind: "add",
    }),
  });
  expect(begin.status).toBe(200);
  const transaction = (await begin.json()) as { id: string };
  const transactionCookie = oneCookie(begin, MANAGED_AUTH_LOGIN_TRANSACTION_COOKIE);
  const completion = await app.request("/v1/auth/session-set/transactions/email-password", {
    method: "POST",
    headers: mutation(initial, `${authority}; ${transactionCookie}`),
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedGeneration: initial.generation,
      transactionId: transaction.id,
      email,
      password,
    }),
  });
  expect(completion.status).toBe(200);
  const completed = (await completion.json()) as { projection: ManagedAuthSessionSetProjection };
  const select = await app.request("/v1/auth/session-set/select", {
    method: "POST",
    headers: mutation(completed.projection, authority),
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedGeneration: completed.projection.generation,
      slotId: completed.projection.slots[0]!.id,
    }),
  });
  expect(select.status).toBe(200);
  const projection = (await select.json()) as ManagedAuthSessionSetProjection;
  const [user] = await shared.admin<
    { id: string }[]
  >`select id from auth_users where email = ${email}`;
  const created = await createManagedOrganization(client.db, {
    subjectId: `user:${user!.id}`,
    subjectLabel: email,
    name: `${name} Org`,
    operationId: crypto.randomUUID(),
  });
  return {
    app,
    cookie: authority,
    headers: sessionSetHeaders(projection),
    peer: freshPeer(),
    userId: user!.id,
    workspaceId: created.workspaceId,
  };
}

describe("re-authentication in a browser session set", () => {
  test("broker mode: TOTP enrollment and re-authentication feed the host token", async () => {
    const app = managedApp({
      hostTokenAudience: audience,
      managedAuthTotpEnabled: true,
      managedAuthSessionSetMode: "broker",
    });
    const person = await brokerMember(app, "Broker Person");
    const before = await hostTokenClaims(person);
    expect(before.amr).toEqual(["pwd"]);

    // Without the session-set CSRF proof the mutation is refused.
    const unproven = await post({ ...person, headers: {} }, "/v1/auth/reauthenticate", {
      password,
    });
    expect(unproven.status).toBe(403);

    const secret = await enrollTotp(person);
    const response = await post(person, "/v1/auth/reauthenticate", {
      password,
      totp: await totpCode(secret, 1),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { amr: string[] }).amr).toEqual(["pwd", "otp"]);
    const after = await hostTokenClaims(person);
    expect(after.amr).toEqual(["pwd", "otp"]);
    expect(after.sid).toBe(before.sid);
    expect(after.auth_time).toBeGreaterThanOrEqual(before.auth_time);
  }, 60_000);
});
