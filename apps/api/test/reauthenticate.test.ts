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

import { createHash, randomBytes } from "node:crypto";

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

async function signIn(app: ManagedApp, email: string, peer = freshPeer()): Promise<Response> {
  return await call({ app, peer }, "/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
}

/** A signed-up member of their own organization, signed in an hour ago. */
async function member(app: ManagedApp, name: string) {
  const email = `reauth-${crypto.randomUUID()}@example.test`;
  // Each member signs up from its own address, so Better Auth's per-address
  // sign-up and sign-in limits never mix across tests.
  const peer = freshPeer();
  await call({ app, peer }, "/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const cookie = sessionCookie(await signIn(app, email, peer));
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
  // The sign-in recorded exactly one authentication, at the session's creation.
  expect(await authentications(session.id)).toEqual([
    { amr: ["pwd"], authenticated_at: session.created_at },
  ]);
  const signedInAt = new Date(Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000);
  await shared.admin`update auth_sessions set created_at = ${signedInAt} where id = ${session.id}`;
  await shared.admin`
    update auth_session_authentications set authenticated_at = ${signedInAt}
    where auth_session_id = ${session.id}
  `;
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

async function authentications(sessionId: string) {
  return await shared.admin<{ amr: string[]; authenticated_at: Date }[]>`
    select amr, authenticated_at from auth_session_authentications
    where auth_session_id = ${sessionId} order by authenticated_at, recorded_at
  `;
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
    // Only the sign-in is recorded.
    expect(await authentications(person.sessionId)).toHaveLength(1);
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

  test("a session without a recorded authentication is refused HOST_TOKEN_AUTHENTICATION_UNKNOWN", async () => {
    const app = stepUpApp();
    const person = await member(app, "Unknown Authentication Person");
    // A session that predates the event store, or that no sign-in created:
    // its creation time is not evidence, so nothing is minted.
    await shared.admin`
      delete from auth_session_authentications where auth_session_id = ${person.sessionId}
    `;
    await shared.admin`update auth_sessions set created_at = now() where id = ${person.sessionId}`;
    const mint = () =>
      call(person, `/v1/auth/host-token?workspace=${encodeURIComponent(person.workspaceId)}`, {
        headers: { cookie: person.cookie },
      });
    const body = await expectRefusal(await mint(), 403, "HOST_TOKEN_AUTHENTICATION_UNKNOWN");
    expect(body).not.toHaveProperty("token");
    // Sign-in method changes do not count it as fresh either.
    const methods = (await (
      await call(person, "/v1/auth/sign-in-methods", { headers: { cookie: person.cookie } })
    ).json()) as { freshAuthenticationRequired: boolean };
    expect(methods.freshAuthenticationRequired).toBe(true);
    // Re-authenticating records one.
    expect((await post(person, "/v1/auth/reauthenticate", { password })).status).toBe(200);
    expect((await hostTokenClaims(person)).amr).toEqual(["pwd"]);
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

/** A code that matches no step in the accepted window. */
async function wrongTotpCode(secret: string): Promise<string> {
  const accepted = new Set([
    await totpCode(secret, -1),
    await totpCode(secret, 0),
    await totpCode(secret, 1),
    await totpCode(secret, 2),
  ]);
  for (let candidate = 0; ; candidate++) {
    const code = String(candidate).padStart(6, "0");
    if (!accepted.has(code)) return code;
  }
}

/** Approve a native app device from the caller's browser, then sign its window in. */
async function nativeDevice(caller: Caller) {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = "opengeni://auth/callback";
  const authorize = await post(caller, "/v1/native-app/authorize", {
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    platform: "macos",
    deviceName: "Test Mac",
  });
  expect(authorize.status).toBe(200);
  const { redirectUrl } = (await authorize.json()) as { redirectUrl: string };
  const code = new URL(redirectUrl).searchParams.get("code")!;
  const token = await call(caller, "/v1/native-app/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri }),
  });
  expect(token.status).toBe(200);
  const { accessToken } = (await token.json()) as { accessToken: string };
  const windowSession = await call(caller, "/v1/native-app/web-session", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(windowSession.status).toBe(200);
  const cookie = sessionCookie(windowSession);
  return { cookie, sessionId: (await sessionRow(cookie)).id };
}

/** Make the person's sign-in a Google sign-in at `at`, and drop their password. */
async function socialSignIn(person: { userId: string; sessionId: string }, at: Date) {
  await shared.admin`
    update auth_session_authentications set amr = '{oauth}', authenticated_at = ${at}
    where auth_session_id = ${person.sessionId}
  `;
  await shared.admin`
    update auth_identities set password = null
    where user_id = ${person.userId} and provider_id = 'credential'
  `;
}

const wholeSecondsAgo = (seconds: number) =>
  new Date(Math.floor((Date.now() - seconds * 1000) / 1000) * 1000);

describe("authentication events", () => {
  for (const mode of ["dual", "broker"] as const) {
    test(`a real sign-in records its authentication in ${mode} mode`, async () => {
      const app = managedApp({
        hostTokenAudience: audience,
        managedAuthSessionSetMode: mode,
      });
      const person = await brokerMember(app, `${mode} Sign In Person`);
      const [session] = await shared.admin<{ id: string; created_at: Date }[]>`
        select id, created_at from auth_sessions where user_id = ${person.userId}
      `;
      expect(await authentications(session!.id)).toEqual([
        { amr: ["pwd"], authenticated_at: session!.created_at },
      ]);
      expect((await hostTokenClaims(person)).auth_time).toBe(epochSeconds(session!.created_at));
    }, 60_000);
  }

  test("a native app device session inherits the approving authentication and is never fresh on its own", async () => {
    const app = stepUpApp();
    const person = await member(app, "Device Approver");
    // The approving browser signed in with Google an hour ago.
    await socialSignIn(person, person.signedInAt);
    const device = await nativeDevice(person);
    const deviceCaller = { ...person, cookie: device.cookie, peer: freshPeer() };

    expect(await authentications(device.sessionId)).toEqual([
      { amr: ["oauth"], authenticated_at: person.signedInAt },
    ]);
    const claims = await hostTokenClaims(deviceCaller);
    expect(claims.sid).toBe(device.sessionId);
    expect(claims.auth_time).toBe(epochSeconds(person.signedInAt));
    expect(claims.amr).toEqual(["oauth"]);

    // A new session is not a fresh social sign-in or a fresh authentication.
    await expectRefusal(
      await post(deviceCaller, "/v1/auth/reauthenticate", {}),
      401,
      "REAUTH_FAILED",
    );
    await expectRefusal(
      await post(deviceCaller, "/v1/auth/totp/enroll", {}),
      401,
      "TOTP_AUTHENTICATION_REQUIRED",
    );
    const methods = (await (
      await call(deviceCaller, "/v1/auth/sign-in-methods", {
        headers: { cookie: deviceCaller.cookie },
      })
    ).json()) as { freshAuthenticationRequired: boolean };
    expect(methods.freshAuthenticationRequired).toBe(true);
    expect(await authentications(device.sessionId)).toHaveLength(1);
  }, 60_000);

  test("a device approved right after a social sign-in keeps that sign-in's time", async () => {
    const app = stepUpApp();
    const person = await member(app, "Fresh Device Approver");
    const signedInAt = wholeSecondsAgo(60);
    await socialSignIn(person, signedInAt);
    const device = await nativeDevice(person);
    const deviceCaller = { ...person, cookie: device.cookie, peer: freshPeer() };
    const response = await post(deviceCaller, "/v1/auth/reauthenticate", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authTime: signedInAt.toISOString(),
      amr: ["oauth"],
    });
    expect((await hostTokenClaims(deviceCaller)).auth_time).toBe(epochSeconds(signedInAt));
  }, 60_000);

  test("a code added to a social sign-in keeps the sign-in's time", async () => {
    const app = stepUpApp();
    const person = await member(app, "Social TOTP Person");
    const signedInAt = wholeSecondsAgo(120);
    await socialSignIn(person, signedInAt);
    // Without a password, enrolling needs that fresh sign-in.
    const enroll = await post(person, "/v1/auth/totp/enroll", {});
    expect(enroll.status).toBe(200);
    const secret = totpSecret(((await enroll.json()) as { totpURI: string }).totpURI);
    expect(
      (await post(person, "/v1/auth/totp/confirm", { code: await totpCode(secret) })).status,
    ).toBe(200);

    const response = await post(person, "/v1/auth/reauthenticate", {
      totp: await totpCode(secret, 1),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authTime: signedInAt.toISOString(),
      amr: ["oauth", "otp"],
    });
    const claims = await hostTokenClaims(person);
    expect(claims.auth_time).toBe(epochSeconds(signedInAt));
    expect(claims.amr).toEqual(["oauth", "otp"]);
  }, 60_000);
});

describe("TOTP lockout", () => {
  test("ten wrong codes lock the factor, even for the right code, until it expires", async () => {
    const app = stepUpApp();
    const person = await member(app, "Lockout Person");
    const secret = await enrollTotp(person);
    await forgetUsedCodes(person.userId);
    const attempt = (body: Record<string, unknown>, path = "/v1/auth/reauthenticate") =>
      post({ ...person, peer: freshPeer() }, path, body);
    const factor = async () =>
      (
        await shared.admin<
          {
            failed_verification_count: number;
            locked_until: Date | null;
            last_used_counter: string | null;
          }[]
        >`
          select failed_verification_count, locked_until, last_used_counter
          from auth_two_factors where user_id = ${person.userId}
        `
      )[0]!;

    const wrong = await wrongTotpCode(secret);
    for (let index = 0; index < 10; index++) {
      await expectRefusal(await attempt({ password, totp: wrong }), 401, "REAUTH_FAILED");
    }
    expect((await factor()).failed_verification_count).toBe(10);
    expect((await factor()).locked_until).not.toBeNull();

    const right = await totpCode(secret);
    const locked = await attempt({ password, totp: right });
    await expectRefusal(locked, 429, "REAUTH_TOTP_LOCKED");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(14 * 60);
    await expectRefusal(
      await attempt({ password, code: right }, "/v1/auth/totp/disable"),
      429,
      "TOTP_LOCKED",
    );
    // No time step was spent while locked.
    expect((await factor()).last_used_counter).toBeNull();

    await shared.admin`
      update auth_two_factors set locked_until = now() - interval '1 second'
      where user_id = ${person.userId}
    `;
    const unlocked = await attempt({ password, totp: right });
    expect(unlocked.status).toBe(200);
    expect(((await unlocked.json()) as { amr: string[] }).amr).toEqual(["pwd", "otp"]);
    expect(await factor()).toMatchObject({ failed_verification_count: 0, locked_until: null });
  }, 120_000);
});

describe("authentication storage constraints", () => {
  test("amr is one primary method with an optional otp, never duplicated", async () => {
    const person = await member(stepUpApp(), "Amr Constraint Person");
    const insert = async (amr: string) =>
      await shared.admin`
        insert into auth_session_authentications (auth_session_id, amr)
        values (${person.sessionId}, ${amr}::text[])
      `.then(
        () => "accepted",
        () => "refused",
      );
    for (const amr of ["{pwd}", "{oauth}", "{pwd,otp}", "{otp,oauth}"])
      expect({ amr, outcome: await insert(amr) }).toEqual({ amr, outcome: "accepted" });
    for (const amr of [
      "{}",
      "{otp}",
      "{pwd,oauth}",
      "{pwd,pwd}",
      "{otp,otp}",
      "{pwd,otp,otp}",
      "{pwd,oauth,otp}",
      "{pwd,NULL}",
      "{{pwd},{otp}}",
      "{sms}",
    ])
      expect({ amr, outcome: await insert(amr) }).toEqual({ amr, outcome: "refused" });
  }, 60_000);

  test("a factor row written without verified is not verified", async () => {
    const person = await member(stepUpApp(), "Unverified Factor Person");
    const [row] = await shared.admin<{ verified: boolean }[]>`
      insert into auth_two_factors (id, user_id, secret, backup_codes)
      values (${crypto.randomUUID()}, ${person.userId}, 'secret', 'codes')
      returning verified
    `;
    expect(row!.verified).toBe(false);
  }, 60_000);
});
