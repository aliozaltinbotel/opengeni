import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  acceptOrganizationInvitation,
  applyCanonicalHumanIdentityOperation,
  createDb,
  createManagedOrganization,
  createOrganizationInvitation,
  getCanonicalHumanIdentityProjection,
  updateOrganizationMember,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";

import { createApp } from "../src/app";

/* End to end through the real app, Better Auth and PostgreSQL: a host that
   configures an audience gets a short-lived ES256 session token for one
   workspace, verifiable against the published JWKS. Without the audience the
   deployment behaves exactly as before. */

const origin = "http://opengeni.test";
const audience = "https://host.example.test/api";
const exactClaims = [
  "amr",
  "aud",
  "auth_time",
  "exp",
  "iat",
  "identity_status",
  "iss",
  "jti",
  "org",
  "sid",
  "sub",
  "ws",
];

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-token");
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
      betterAuthSecret: "host-token-test-secret-32-bytes-long",
      publicBaseUrl: origin,
      ...overrides,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
}

type ManagedApp = ReturnType<typeof managedApp>;

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Better Auth response did not set a session cookie");
  return cookie.split(";", 1)[0]!;
}

async function signIn(app: ManagedApp, email: string, password: string): Promise<string> {
  return sessionCookie(
    await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    }),
  );
}

async function signUp(app: ManagedApp, name: string) {
  const email = `host-token-${crypto.randomUUID()}@example.test`;
  const password = "password1234";
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const cookie = await signIn(app, email, password);
  const [user] = await shared.admin<
    { id: string }[]
  >`select id from auth_users where email = ${email}`;
  return { cookie, email, password, userId: user!.id, subjectId: `user:${user!.id}` };
}

async function accessOf(app: ManagedApp, cookie: string) {
  return (await (await app.request("/v1/access/me", { headers: { cookie } })).json()) as {
    accountGrants: Array<{ accountId: string }>;
    workspaceGrants: Array<{ workspaceId: string; accountId: string }>;
  };
}

async function ownerWithOrganization(app: ManagedApp, name: string) {
  const owner = await signUp(app, name);
  await createManagedOrganization(client.db, {
    subjectId: owner.subjectId,
    subjectLabel: owner.email,
    name: `${name} Org`,
    operationId: crypto.randomUUID(),
  });
  const access = await accessOf(app, owner.cookie);
  const organizationId = access.accountGrants[0]!.accountId;
  const workspaceId = access.workspaceGrants.find(
    (grant) => grant.accountId === organizationId,
  )!.workspaceId;
  return { ...owner, organizationId, workspaceId };
}

async function mint(app: ManagedApp, headers: Record<string, string>, workspaceId: string) {
  return await app.request(`/v1/auth/host-token?workspace=${encodeURIComponent(workspaceId)}`, {
    headers,
  });
}

async function refusalCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

async function sessionRow(cookie: string) {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".", 1)[0]!;
  const [row] = await shared.admin<{ id: string; created_at: Date; updated_at: Date }[]>`
    select id, created_at, updated_at from auth_sessions where token = ${token}
  `;
  if (!row) throw new Error("session row not found");
  return row;
}

describe("host session token, stock deployment", () => {
  test("is disabled and publishes no JWKS without a configured audience", async () => {
    const app = managedApp();
    const owner = await ownerWithOrganization(app, "Stock Owner");

    const refused = await mint(app, { cookie: owner.cookie }, owner.workspaceId);
    expect(refused.status).toBe(404);
    expect(await refusalCode(refused)).toBe("HOST_TOKEN_DISABLED");

    expect((await app.request("/v1/auth/jwks")).status).toBe(404);
    expect(
      (await app.request("/v1/auth/token", { headers: { cookie: owner.cookie } })).status,
    ).toBe(404);
    const session = await app.request("/v1/auth/get-session", {
      headers: { cookie: owner.cookie },
    });
    expect(session.status).toBe(200);
    expect(session.headers.get("set-auth-jwt")).toBeNull();
  }, 60_000);
});

describe("host session token with an audience", () => {
  const app = () => managedApp({ hostTokenAudience: audience });

  test("mints an ES256 token with the exact claim set that verifies against the JWKS", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Token Owner");
    // auth_time is the authenticating sign-in, never the sliding renewal stamp.
    const signedInAt = new Date(Date.now() - 10 * 60_000);
    const { id: sessionId } = await sessionRow(owner.cookie);
    await shared.admin`
      update auth_sessions set created_at = ${signedInAt}, updated_at = now() where id = ${sessionId}
    `;

    const response = await mint(instance, { cookie: owner.cookie }, owner.workspaceId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as { token: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "token"]);

    const header = decodeProtectedHeader(body.token);
    expect(header.alg).toBe("ES256");
    expect(header.typ).not.toBe("at+jwt");
    expect(typeof header.kid).toBe("string");

    const jwksResponse = await instance.request("/v1/auth/jwks");
    expect(jwksResponse.status).toBe(200);
    const jwks = (await jwksResponse.json()) as JSONWebKeySet;
    expect(jwks.keys.length).toBeGreaterThan(0);
    for (const key of jwks.keys) {
      expect(key).toMatchObject({ alg: "ES256", kty: "EC", crv: "P-256" });
      expect(key).not.toHaveProperty("d");
    }

    const { payload } = await jwtVerify(body.token, createLocalJWKSet(jwks), {
      issuer: origin,
      audience,
      algorithms: ["ES256"],
    });
    expect(Object.keys(payload).sort()).toEqual(exactClaims);
    const identity = await getCanonicalHumanIdentityProjection(client.db, owner.userId);
    expect(payload).toMatchObject({
      iss: origin,
      aud: audience,
      sub: identity.activeIdentity.id,
      sid: sessionId,
      org: owner.organizationId,
      ws: owner.workspaceId,
      auth_time: Math.floor(signedInAt.getTime() / 1000),
      amr: ["pwd"],
      identity_status: "active",
    });
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(typeof payload.jti).toBe("string");
    expect(body.expiresAt).toBe(new Date(payload.exp! * 1000).toISOString());

    // The plugin's own token routes never mint a JWT outside this boundary.
    expect(
      (await instance.request("/v1/auth/token", { headers: { cookie: owner.cookie } })).status,
    ).toBe(404);
    const session = await instance.request("/v1/auth/get-session", {
      headers: { cookie: owner.cookie },
    });
    expect(session.status).toBe(200);
    expect(session.headers.get("set-auth-jwt")).toBeNull();
  }, 60_000);

  test("requires a managed browser session", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Session Owner");
    const anonymous = await mint(instance, {}, owner.workspaceId);
    expect(anonymous.status).toBe(401);
    expect(await refusalCode(anonymous)).toBe("HOST_TOKEN_SESSION_REQUIRED");
    const bearer = await mint(
      instance,
      { cookie: owner.cookie, authorization: "Bearer not-a-browser-session" },
      owner.workspaceId,
    );
    expect(bearer.status).toBe(401);
    expect(await refusalCode(bearer)).toBe("HOST_TOKEN_SESSION_REQUIRED");
  }, 60_000);

  test("refuses a workspace outside the person's organizations", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Member Owner");
    const stranger = await ownerWithOrganization(instance, "Stranger Owner");
    for (const workspaceId of [stranger.workspaceId, crypto.randomUUID()]) {
      const refused = await mint(instance, { cookie: owner.cookie }, workspaceId);
      expect(refused.status).toBe(403);
      expect(await refusalCode(refused)).toBe("HOST_TOKEN_NOT_MEMBER");
    }
  }, 60_000);

  test("refuses at mint time once the membership is suspended", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Suspending Owner");
    const member = await signUp(instance, "Suspended Member");
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId: owner.organizationId,
      actorSubjectId: owner.subjectId,
      operationId: crypto.randomUUID(),
      targetSubjectId: member.subjectId,
      targetEmail: member.email,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { membership } = await acceptOrganizationInvitation(client.db, {
      organizationId: owner.organizationId,
      actorSubjectId: member.subjectId,
      operationId: crypto.randomUUID(),
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    });
    const memberWorkspaceId = (await accessOf(instance, member.cookie)).workspaceGrants.find(
      (grant) => grant.accountId === owner.organizationId,
    )!.workspaceId;
    const allowed = await mint(instance, { cookie: member.cookie }, memberWorkspaceId);
    expect(allowed.status).toBe(200);

    await updateOrganizationMember(client.db, {
      organizationId: owner.organizationId,
      actorSubjectId: owner.subjectId,
      operationId: crypto.randomUUID(),
      membershipId: membership.id,
      transition: {
        kind: "suspend",
        expectedAuthorizationRevision: membership.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    const refused = await mint(instance, { cookie: member.cookie }, memberWorkspaceId);
    expect(refused.status).toBe(403);
    expect(await refusalCode(refused)).toBe("HOST_TOKEN_NOT_MEMBER");
  }, 60_000);

  test("refuses a canonical identity that is not active", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Recovering Owner");
    const linked = await getCanonicalHumanIdentityProjection(client.db, owner.userId);
    const lostFactor = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: owner.userId,
      expectedIdentityRevision: linked.activeIdentity.identityRevision,
      operationType: "unlink",
      bindingId: linked.loginBindings[0]!.id,
      reason: "Exercise host token refusal during identity recovery",
    });
    expect(lostFactor.identity.activeIdentity.status).toBe("recovery_required");
    const recoveryCookie = await signIn(instance, owner.email, owner.password);
    const refused = await mint(instance, { cookie: recoveryCookie }, owner.workspaceId);
    expect(refused.status).toBe(403);
    expect(await refusalCode(refused)).toBe("HOST_TOKEN_IDENTITY_NOT_ACTIVE");
  }, 60_000);
});
