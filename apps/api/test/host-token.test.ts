import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { ApiRouteDeps } from "@opengeni/core";
import type { SessionAuthorizationPort, SessionCreateCreator } from "@opengeni/contracts";
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
import {
  acceptOrganizationInvitation,
  activeCanonicalHumanLoginBinding,
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
import { MANAGED_AUTH_HOST_TOKEN_RATE_LIMIT } from "../src/auth/managed-auth-rate-limits";
import { HOST_TOKEN_JWKS_MAX_AGE_SECONDS, registerHostTokenRoutes } from "../src/routes/host-token";
import { Hono } from "hono";

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
  "login_binding_id",
  "login_binding_revision",
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

function managedApp(
  overrides: Partial<Settings> = {},
  sessionAuthorization?: SessionAuthorizationPort,
) {
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
    workflowClient: {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
      startSessionWorkflow: async () => undefined,
    } as ApiRouteDeps["workflowClient"],
    ...(sessionAuthorization ? { sessionAuthorization } : {}),
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

// Better Auth limits sign-up and sign-in per client address, in the database,
// and every request here comes from the same address. The file signs in more
// often than that limit allows in one window, so each sign-up and sign-in
// starts from an empty counter.
async function resetAuthRateLimits(): Promise<void> {
  await shared.admin`delete from auth_rate_limits`;
}

async function signIn(app: ManagedApp, email: string, password: string): Promise<string> {
  await resetAuthRateLimits();
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
  await resetAuthRateLimits();
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

/** Verify a minted token against the published JWKS and return its claims. */
async function verifiedClaims(app: ManagedApp, response: Response) {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string; expiresAt: string };
  const jwks = (await (await app.request("/v1/auth/jwks")).json()) as JSONWebKeySet;
  const { payload, protectedHeader } = await jwtVerify(body.token, createLocalJWKSet(jwks), {
    issuer: origin,
    audience,
    algorithms: ["ES256"],
  });
  expect(protectedHeader.alg).toBe("ES256");
  expect(Object.keys(payload).sort()).toEqual(exactClaims);
  expect(payload.exp! - payload.iat!).toBe(300);
  expect(body.expiresAt).toBe(new Date(payload.exp! * 1000).toISOString());
  return payload;
}

/** A refusal carries its code and never a token. */
async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.code).toBe(code);
  expect(body).not.toHaveProperty("token");
}

function oneCookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!value) throw new Error(`response omitted ${name}`);
  return value.split(";", 1)[0]!;
}

function sessionSetMutationHeaders(
  projection: ManagedAuthSessionSetProjection,
  cookies: string,
): Record<string, string> {
  return {
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    [MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER]: MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
    "x-opengeni-session-csrf": projection.csrfToken,
    [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: projection.actorEpoch,
    cookie: cookies,
  };
}

/** Sign up and select one account through the browser session-set flow. */
async function sessionSetSignIn(app: ManagedApp, name: string) {
  const initialResponse = await app.request("/v1/auth/session-set");
  expect(initialResponse.status).toBe(200);
  const initial = (await initialResponse.json()) as ManagedAuthSessionSetProjection;
  const authority = oneCookie(initialResponse, MANAGED_AUTH_SESSION_SET_COOKIE);
  const email = `host-token-set-${crypto.randomUUID()}@example.test`;
  const password = "password1234";
  await resetAuthRateLimits();
  const registered = await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: authority },
    body: JSON.stringify({ name, email, password }),
  });
  expect(registered.status).toBeLessThan(300);
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const begin = await app.request("/v1/auth/session-set/transactions", {
    method: "POST",
    headers: sessionSetMutationHeaders(initial, authority),
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
    headers: sessionSetMutationHeaders(initial, `${authority}; ${transactionCookie}`),
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
    headers: sessionSetMutationHeaders(completed.projection, authority),
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedGeneration: completed.projection.generation,
      slotId: completed.projection.slots[0]!.id,
    }),
  });
  expect(select.status).toBe(200);
  const projection = (await select.json()) as ManagedAuthSessionSetProjection;
  expect(projection.selectedSlotId).not.toBeNull();
  // Dual mode also sets the selected session cookie; broker mode keeps only
  // the session-set authority.
  const selectedSession = select.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0]!)
    .filter((cookie) => /^better-auth\.session_token=.+/u.test(cookie));
  const [user] = await shared.admin<
    { id: string }[]
  >`select id from auth_users where email = ${email}`;
  return {
    headers: {
      cookie: [authority, ...selectedSession].join("; "),
      [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: projection.actorEpoch,
    },
    email,
    userId: user!.id,
    subjectId: `user:${user!.id}`,
  };
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
    // The sign-in is the session's recorded authentication, not its row.
    await shared.admin`
      update auth_session_authentications set authenticated_at = ${signedInAt}
      where auth_session_id = ${sessionId}
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
      login_binding_id: identity.activeIdentity.activeLoginBindingId,
      login_binding_revision: identity.loginBindings.find(
        (binding) => binding.id === identity.activeIdentity.activeLoginBindingId,
      )!.revision,
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
    // The member's own Personal workspace in that organization.
    const memberWorkspaceId = membership.personalWorkspaceId!;
    expect(memberWorkspaceId).toBeString();
    expect(
      (await accessOf(instance, member.cookie)).workspaceGrants.map((grant) => grant.workspaceId),
    ).toContain(memberWorkspaceId);
    const allowed = await mint(instance, { cookie: member.cookie }, memberWorkspaceId);
    expect((await verifiedClaims(instance, allowed)).ws).toBe(memberWorkspaceId);

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
    await expectRefusal(refused, 403, "HOST_TOKEN_NOT_MEMBER");
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
    await expectRefusal(refused, 403, "HOST_TOKEN_IDENTITY_NOT_ACTIVE");
  }, 60_000);

  // A disputed or disabled identity fails closed one step earlier: the
  // canonical session check deletes its sessions, so it reads as signed out.
  test("refuses an identity that a login-binding dispute contained", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Disputed Owner");
    const claimant = await signUp(instance, "Conflicting Claimant");
    // A generic provider: managed Google/GitHub collisions are refused before
    // they can reach the dispute path.
    const providerId = "test-oidc";
    const providerAccountId = `host-token-dispute-${crypto.randomUUID()}`;
    await shared.admin`
      insert into auth_identities (id, user_id, provider_id, account_id, created_at, updated_at)
      values (${crypto.randomUUID()}, ${owner.userId}, ${providerId}, ${providerAccountId}, now(), now())
    `;
    const ownerIdentity = await getCanonicalHumanIdentityProjection(client.db, owner.userId);
    await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: owner.userId,
      expectedIdentityRevision: ownerIdentity.activeIdentity.identityRevision,
      operationType: "link",
      providerId,
      providerAccountId,
      reason: "Attach the first verified claimant",
    });
    const cookie = await signIn(instance, owner.email, owner.password);
    await verifiedClaims(instance, await mint(instance, { cookie }, owner.workspaceId));

    await shared.admin`
      update auth_identities set user_id = ${claimant.userId}, updated_at = now()
      where provider_id = ${providerId} and account_id = ${providerAccountId}
    `;
    const claimantIdentity = await getCanonicalHumanIdentityProjection(client.db, claimant.userId);
    const disputed = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: claimant.userId,
      expectedIdentityRevision: claimantIdentity.activeIdentity.identityRevision,
      operationType: "link",
      providerId,
      providerAccountId,
      reason: "Contain the conflicting verified claimant",
    });
    expect(disputed.outcome).toBe("disputed");
    expect(
      (await getCanonicalHumanIdentityProjection(client.db, owner.userId)).activeIdentity.status,
    ).toBe("disputed");
    await expectRefusal(
      await mint(instance, { cookie }, owner.workspaceId),
      401,
      "HOST_TOKEN_SESSION_REQUIRED",
    );
  }, 60_000);

  test("refuses a disabled identity", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Disabled Owner");
    await verifiedClaims(
      instance,
      await mint(instance, { cookie: owner.cookie }, owner.workspaceId),
    );
    const { id: sessionId } = await sessionRow(owner.cookie);
    const identity = await getCanonicalHumanIdentityProjection(client.db, owner.userId);
    // No product operation disables an identity yet; set the state directly.
    await shared.admin`
      update canonical_human_identities
      set status = 'disabled', recovery_state = 'disabled', updated_at = now()
      where id = ${identity.activeIdentity.id}
    `;
    await expectRefusal(
      await mint(instance, { cookie: owner.cookie }, owner.workspaceId),
      401,
      "HOST_TOKEN_SESSION_REQUIRED",
    );
    const [remaining] = await shared.admin<{ count: number }[]>`
      select count(*)::integer as count from auth_sessions where id = ${sessionId}
    `;
    expect(remaining).toEqual({ count: 0 });
  }, 60_000);
});

describe("host session token login binding claims", () => {
  const app = () => managedApp({ hostTokenAudience: audience });

  async function bindingClaims(instance: ManagedApp, cookie: string, workspaceId: string) {
    const payload = await verifiedClaims(instance, await mint(instance, { cookie }, workspaceId));
    return { id: payload.login_binding_id, revision: payload.login_binding_revision };
  }

  test("the claims name the identity's active binding, as the host identity lookup does", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Binding Owner");
    const identity = await getCanonicalHumanIdentityProjection(client.db, owner.userId);
    expect(activeCanonicalHumanLoginBinding(identity)).not.toBeNull();
    expect(await bindingClaims(instance, owner.cookie, owner.workspaceId)).toEqual(
      activeCanonicalHumanLoginBinding(identity)!,
    );
  }, 60_000);

  test("another sign-in method becoming active changes login_binding_id", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Rebound Owner");
    const before = await bindingClaims(instance, owner.cookie, owner.workspaceId);
    const providerId = "test-oidc";
    const providerAccountId = `host-token-rebind-${crypto.randomUUID()}`;
    await shared.admin`
      insert into auth_identities (id, user_id, provider_id, account_id, created_at, updated_at)
      values (${crypto.randomUUID()}, ${owner.userId}, ${providerId}, ${providerAccountId}, now(), now())
    `;
    const identity = await getCanonicalHumanIdentityProjection(client.db, owner.userId);
    const linked = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: owner.userId,
      expectedIdentityRevision: identity.activeIdentity.identityRevision,
      operationType: "link",
      providerId,
      providerAccountId,
      reason: "Another sign-in method becomes the active binding",
    });
    expect(linked.outcome).toBe("applied");
    const active = activeCanonicalHumanLoginBinding(linked.identity)!;
    expect(active.id).not.toBe(before.id);
    // Linking ends the identity's sessions; sign in again.
    const cookie = await signIn(instance, owner.email, owner.password);
    expect(await bindingClaims(instance, cookie, owner.workspaceId)).toEqual(active);
  }, 60_000);

  test("a state change of the active binding bumps login_binding_revision", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Recovered Owner");
    const before = await bindingClaims(instance, owner.cookie, owner.workspaceId);
    const identity = await getCanonicalHumanIdentityProjection(client.db, owner.userId);
    const recovering = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: owner.userId,
      expectedIdentityRevision: identity.activeIdentity.identityRevision,
      operationType: "begin_recovery",
      bindingId: before.id as string,
      reason: "Exercise a binding state change",
    });
    const recovered = await applyCanonicalHumanIdentityOperation(client.db, {
      operationId: crypto.randomUUID(),
      authUserId: owner.userId,
      expectedIdentityRevision: recovering.identity.activeIdentity.identityRevision,
      operationType: "recover",
      bindingId: before.id as string,
      reason: "The same binding is active again",
    });
    expect(recovered.identity.activeIdentity.status).toBe("active");
    const cookie = await signIn(instance, owner.email, owner.password);
    const after = await bindingClaims(instance, cookie, owner.workspaceId);
    expect(after.id).toBe(before.id);
    expect(after.revision as number).toBeGreaterThan(before.revision as number);
    expect(after).toEqual(activeCanonicalHumanLoginBinding(recovered.identity)!);
  }, 60_000);

  test("an active identity without an active binding is refused", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Unbound Owner");
    const identity = await getCanonicalHumanIdentityProjection(client.db, owner.userId);
    // No product operation leaves an active identity without one; set it directly.
    await shared.admin`
      update canonical_human_identities set active_login_binding_id = null
      where id = ${identity.activeIdentity.id}
    `;
    await expectRefusal(
      await mint(instance, { cookie: owner.cookie }, owner.workspaceId),
      403,
      "HOST_TOKEN_LOGIN_BINDING_UNKNOWN",
    );
  }, 60_000);
});

describe("registration-purpose host session token", () => {
  const app = () => managedApp({ hostTokenAudience: audience });
  const registrationClaims = [
    "amr",
    "aud",
    "auth_time",
    "email",
    "email_verified",
    "exp",
    "iat",
    "identity_status",
    "iss",
    "jti",
    "login_binding_id",
    "login_binding_revision",
    "purpose",
    "sid",
    "sub",
  ];

  async function mintRegistration(instance: ManagedApp, headers: Record<string, string>) {
    return await instance.request("/v1/auth/host-token?purpose=registration", { headers });
  }

  test("a signed-in person with no workspace gets a token with no org or ws", async () => {
    const instance = app();
    const person = await signUp(instance, "Registering Person");
    expect((await accessOf(instance, person.cookie)).workspaceGrants).toEqual([]);
    const response = await mintRegistration(instance, { cookie: person.cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as { token: string; expiresAt: string };
    const jwks = (await (await instance.request("/v1/auth/jwks")).json()) as JSONWebKeySet;
    const { payload } = await jwtVerify(body.token, createLocalJWKSet(jwks), {
      issuer: origin,
      audience,
      algorithms: ["ES256"],
    });
    expect(Object.keys(payload).sort()).toEqual(registrationClaims);
    expect(Object.hasOwn(payload, "org")).toBe(false);
    expect(Object.hasOwn(payload, "ws")).toBe(false);
    const identity = await getCanonicalHumanIdentityProjection(client.db, person.userId);
    const { id: sessionId } = await sessionRow(person.cookie);
    expect(payload).toMatchObject({
      sub: identity.activeIdentity.id,
      sid: sessionId,
      purpose: "registration",
      email: person.email,
      email_verified: true,
      identity_status: "active",
      amr: ["pwd"],
      login_binding_id: activeCanonicalHumanLoginBinding(identity)!.id,
      login_binding_revision: activeCanonicalHumanLoginBinding(identity)!.revision,
    });
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(body.expiresAt).toBe(new Date(payload.exp! * 1000).toISOString());
  }, 60_000);

  test("a member gets one too, still without a workspace", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Registering Owner");
    const response = await mintRegistration(instance, { cookie: owner.cookie });
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims).not.toHaveProperty("org");
    expect(claims).not.toHaveProperty("ws");
  }, 60_000);

  test("is minted only for a managed signed-in human with a verified email", async () => {
    const instance = app();
    const person = await signUp(instance, "Unverified Person");
    // No browser session, or a bearer credential beside it.
    await expectRefusal(await mintRegistration(instance, {}), 401, "HOST_TOKEN_SESSION_REQUIRED");
    await expectRefusal(
      await mintRegistration(instance, {
        cookie: person.cookie,
        authorization: "Bearer ogk_not_a_session",
      }),
      401,
      "HOST_TOKEN_SESSION_REQUIRED",
    );
    await expectRefusal(
      await mintRegistration(instance, { cookie: "better-auth.session_token=forged" }),
      401,
      "HOST_TOKEN_SESSION_REQUIRED",
    );
    // A purpose other than registration, or with a workspace, is refused.
    for (const query of [
      "purpose=other",
      `purpose=registration&workspace=${crypto.randomUUID()}`,
    ]) {
      await expectRefusal(
        await instance.request(`/v1/auth/host-token?${query}`, {
          headers: { cookie: person.cookie },
        }),
        400,
        "HOST_TOKEN_PURPOSE_INVALID",
      );
    }
    await shared.admin`update auth_users set email_verified = false where id = ${person.userId}`;
    await expectRefusal(
      await mintRegistration(instance, { cookie: person.cookie }),
      403,
      "HOST_TOKEN_EMAIL_NOT_VERIFIED",
    );
    // A deployment without the audience mints neither kind.
    await expectRefusal(
      await mintRegistration(managedApp(), { cookie: person.cookie }),
      404,
      "HOST_TOKEN_DISABLED",
    );
  }, 60_000);

  test("Opengeni accepts neither kind of host token as a credential", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Credential Owner");
    const registration = (await (
      await mintRegistration(instance, { cookie: owner.cookie })
    ).json()) as { token: string };
    const workspace = (await (
      await mint(instance, { cookie: owner.cookie }, owner.workspaceId)
    ).json()) as { token: string };
    for (const token of [registration.token, workspace.token]) {
      const headers = { authorization: `Bearer ${token}` };
      for (const path of [
        "/v1/access/me",
        `/v1/workspaces/${owner.workspaceId}`,
        `/v1/workspaces/${owner.workspaceId}/sessions`,
        `/v1/organizations/${owner.organizationId}/members`,
        `/v1/auth/host-token?workspace=${owner.workspaceId}`,
        "/v1/auth/host-token?purpose=registration",
      ]) {
        const response = await instance.request(path, { headers });
        expect({ path, status: response.status }).toEqual({ path, status: 401 });
      }
      const mcp = await instance.request(`/v1/workspaces/${owner.workspaceId}/mcp`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(mcp.status).toBe(401);
    }
  }, 60_000);

  test("shares the per-session mint limit with workspace tokens", async () => {
    const instance = app();
    const owner = await ownerWithOrganization(instance, "Shared Limit Owner");
    const half = MANAGED_AUTH_HOST_TOKEN_RATE_LIMIT.max / 2;
    for (let attempt = 0; attempt < MANAGED_AUTH_HOST_TOKEN_RATE_LIMIT.max; attempt += 1) {
      const minted =
        attempt < half
          ? await mint(instance, { cookie: owner.cookie }, owner.workspaceId)
          : await mintRegistration(instance, { cookie: owner.cookie });
      expect({ attempt, status: minted.status }).toEqual({ attempt, status: 200 });
    }
    const limited = await mintRegistration(instance, { cookie: owner.cookie });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refusalCode(limited)).toBe("HOST_TOKEN_RATE_LIMITED");
    await expectRefusal(
      await mint(instance, { cookie: owner.cookie }, owner.workspaceId),
      429,
      "HOST_TOKEN_RATE_LIMITED",
    );
  }, 120_000);
});

describe("host session token with browser session sets", () => {
  for (const mode of ["dual", "broker"] as const) {
    test(`mints for an active member and refuses a non-member in ${mode} mode`, async () => {
      const instance = managedApp({ hostTokenAudience: audience, managedAuthSessionSetMode: mode });
      const human = await sessionSetSignIn(instance, `Session Set ${mode} Owner`);
      const created = await createManagedOrganization(client.db, {
        subjectId: human.subjectId,
        subjectLabel: human.email,
        name: `Session Set ${mode} Org`,
        operationId: crypto.randomUUID(),
      });
      const [session] = await shared.admin<{ id: string; created_at: Date }[]>`
        select id, created_at from auth_sessions where user_id = ${human.userId}
      `;
      const identity = await getCanonicalHumanIdentityProjection(client.db, human.userId);

      const payload = await verifiedClaims(
        instance,
        await mint(instance, human.headers, created.workspaceId),
      );
      expect(payload).toMatchObject({
        iss: origin,
        aud: audience,
        sub: identity.activeIdentity.id,
        sid: session!.id,
        org: created.organization.id,
        ws: created.workspaceId,
        auth_time: Math.floor(session!.created_at.getTime() / 1000),
        amr: ["pwd"],
        identity_status: "active",
      });

      const stranger = await ownerWithOrganization(managedApp(), `Session Set ${mode} Stranger`);
      for (const workspaceId of [stranger.workspaceId, crypto.randomUUID()]) {
        await expectRefusal(
          await mint(instance, human.headers, workspaceId),
          403,
          "HOST_TOKEN_NOT_MEMBER",
        );
      }
      const jwks = await instance.request("/v1/auth/jwks");
      expect(jwks.status).toBe(200);
    }, 60_000);
  }
});

describe("host session token JWKS cache and mint limit", () => {
  test("the JWKS is served from process memory for its max-age", async () => {
    let reads = 0;
    let failNext = false;
    const managedAuth = {
      options: { plugins: [{ id: "jwt" }] },
      api: {
        getJwks: async () => {
          reads += 1;
          if (failNext) {
            failNext = false;
            throw new Error("key store unavailable");
          }
          return { keys: [{ kid: `key-${reads}`, kty: "EC" }] };
        },
      },
    };
    const routes = new Hono();
    registerHostTokenRoutes(routes, {
      settings: { hostTokenAudience: audience, hostTokenTtlSeconds: 300, publicBaseUrl: origin },
      managedAuth,
    } as unknown as ApiRouteDeps);
    const kids = async () => {
      const response = await routes.request("/v1/auth/jwks");
      if (response.status !== 200) return response.status;
      expect(response.headers.get("cache-control")).toBe(
        `public, max-age=${HOST_TOKEN_JWKS_MAX_AGE_SECONDS}`,
      );
      return ((await response.json()) as JSONWebKeySet).keys.map((key) => key.kid);
    };
    const start = Date.now();
    try {
      setSystemTime(start);
      expect(await kids()).toEqual(["key-1"]);
      setSystemTime(start + (HOST_TOKEN_JWKS_MAX_AGE_SECONDS * 1000 - 1));
      expect(await kids()).toEqual(["key-1"]);
      expect(reads).toBe(1);
      // Expired: read again. A failed read is never cached.
      setSystemTime(start + HOST_TOKEN_JWKS_MAX_AGE_SECONDS * 1000);
      failNext = true;
      expect(await kids()).toBe(500);
      expect(await kids()).toEqual(["key-3"]);
      expect(await kids()).toEqual(["key-3"]);
      expect(reads).toBe(3);
    } finally {
      setSystemTime();
    }
  });

  test("concurrent reads of an empty cache share one key-store read", async () => {
    let reads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const managedAuth = {
      options: { plugins: [{ id: "jwt" }] },
      api: {
        getJwks: async () => {
          reads += 1;
          await gate;
          return { keys: [{ kid: "key-1", kty: "EC" }] };
        },
      },
    };
    const routes = new Hono();
    registerHostTokenRoutes(routes, {
      settings: { hostTokenAudience: audience, hostTokenTtlSeconds: 300, publicBaseUrl: origin },
      managedAuth,
    } as unknown as ApiRouteDeps);
    const responses = Promise.all([
      routes.request("/v1/auth/jwks"),
      routes.request("/v1/auth/jwks"),
    ]);
    // Both requests reach the cache while the first read is still pending.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await responses).map((response) => response.status)).toEqual([200, 200]);
    expect(reads).toBe(1);
  });

  test("a signing key the cached JWKS lacks refreshes it", async () => {
    const instance = managedApp({ hostTokenAudience: audience });
    const owner = await ownerWithOrganization(instance, "Rotated Key Owner");
    const first = await mint(instance, { cookie: owner.cookie }, owner.workspaceId);
    await verifiedClaims(instance, first);
    // An operator clears the key store (for example after rotating the auth
    // secret): the next mint creates a new key that the cache has not seen.
    await shared.admin`delete from auth_jwks`;
    const second = await mint(instance, { cookie: owner.cookie }, owner.workspaceId);
    await verifiedClaims(instance, second);
  }, 60_000);

  test("one session mints at most the limit per window; another session is unaffected", async () => {
    const instance = managedApp({ hostTokenAudience: audience });
    const owner = await ownerWithOrganization(instance, "Busy Minter");
    for (let attempt = 0; attempt < MANAGED_AUTH_HOST_TOKEN_RATE_LIMIT.max; attempt += 1) {
      const minted = await mint(instance, { cookie: owner.cookie }, owner.workspaceId);
      expect({ attempt, status: minted.status }).toEqual({ attempt, status: 200 });
    }
    const limited = await mint(instance, { cookie: owner.cookie }, owner.workspaceId);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toContain("no-store");
    expect(await refusalCode(limited)).toBe("HOST_TOKEN_RATE_LIMITED");
    const otherSession = await signIn(instance, owner.email, owner.password);
    expect((await mint(instance, { cookie: otherSession }, owner.workspaceId)).status).toBe(200);
  }, 120_000);
});

test("creator proof verifies real browser JWT for create and fork while preserving import policy", async () => {
  let beforeCreator: SessionCreateCreator | undefined;
  let instance: ManagedApp;
  let owner: Awaited<ReturnType<typeof ownerWithOrganization>>;
  const phases: string[] = [];
  const tokenIds = new Set<string>();
  const verifyCreator = async (creator: SessionCreateCreator | undefined) => {
    expect(creator?.principalKind).toBe("human_session");
    if (!creator?.readCredential) throw new Error("Browser creator proof missing");
    const token = await creator.readCredential();
    const jwks = (await (await instance.request("/v1/auth/jwks")).json()) as JSONWebKeySet;
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: origin,
      audience,
      algorithms: ["ES256"],
    });
    const identity = await getCanonicalHumanIdentityProjection(client.db, owner.userId);
    expect(payload.sub).toBe(identity.activeIdentity.id);
    expect(payload.ws).toBe(owner.workspaceId);
    expect(payload.org).toBe(owner.organizationId);
    expect(payload.sid).toBe((await sessionRow(owner.cookie)).id);
    expect(payload.exp! * 1000).toBeGreaterThan(Date.now());
    if (typeof payload.jti !== "string") throw new Error("Host token id missing");
    tokenIds.add(payload.jti);
    expect(JSON.stringify(creator)).not.toContain(token);
  };
  instance = managedApp(
    { hostTokenAudience: audience },
    {
      authorizeSession: async () => ({ allowed: true }),
      resolveListScope: async () => ({ kind: "all" }),
      authorizeSessionCreate: async (input) => {
        beforeCreator = input.creator;
        await verifyCreator(input.creator);
        phases.push("before");
        return { allowed: true };
      },
      sessionCreated: async (input) => {
        expect(input.creator).toBe(beforeCreator);
        await verifyCreator(input.creator);
        const [state] = await shared.admin<{ state: string; turns: number }[]>`
        select host_session_create_state as state,
          (select count(*)::int from session_turns where session_id = ${input.sessionId}) as turns
        from sessions where id = ${input.sessionId}`;
        expect(state).toEqual({ state: "pending", turns: 0 });
        phases.push("after");
      },
    },
  );
  owner = await ownerWithOrganization(instance, "Creator Proof");
  const headers = { cookie: owner.cookie, origin, "content-type": "application/json" };
  const base = `/v1/workspaces/${owner.workspaceId}`;
  const created = await instance.request(`${base}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ initialMessage: "Test request" }),
  });
  expect(created.status).toBe(202);
  const session = (await created.json()) as { id: string; initialTurnId: string };
  const cancelled = await instance.request(`${base}/sessions/${session.id}/control`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "cancel", clientEventId: crypto.randomUUID() }),
  });
  expect(cancelled.status).toBe(200);
  // No model worker runs in this fixture. Reuse the native fork fixture's
  // retained-history prerequisite after the ordinary control path settles work.
  await shared.admin`insert into session_history_items(account_id, workspace_id, session_id, turn_id, position, item)
    values(${owner.organizationId}, ${owner.workspaceId}, ${session.id}, ${session.initialTurnId}, 1,
      ${shared.admin.json({ type: "message", role: "user", content: "Retained test request" })})`;
  const forked = await instance.request(`${base}/sessions/${session.id}/forks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      visibility: "workspace",
      workspaceSharedAcknowledged: true,
    }),
  });
  expect(forked.status).toBe(201);
  const imported = await instance.request(`${base}/session-imports`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      importId: crypto.randomUUID(),
      title: "Historical test",
      createdAt: "2020-01-01T00:00:00Z",
      events: [
        {
          type: "user.message",
          createdAt: "2020-01-01T00:00:01Z",
          payload: { text: "Historical request" },
        },
      ],
    }),
  });
  expect(imported.status).toBe(403);
  expect(phases).toEqual(["before", "after", "before", "after"]);
  expect(tokenIds.size).toBe(4);
}, 60_000);

test("creator proof cannot mint from cached membership revoked between hooks", async () => {
  let instance: ManagedApp;
  let owner: Awaited<ReturnType<typeof ownerWithOrganization>>;
  let membership: Awaited<ReturnType<typeof acceptOrganizationInvitation>>["membership"];
  let createdSessionId = "";
  let firstMinted = false;
  let secondRefused = false;
  let beforeCreator: SessionCreateCreator | undefined;
  instance = managedApp(
    { hostTokenAudience: audience },
    {
      authorizeSession: async () => ({ allowed: true }),
      resolveListScope: async () => ({ kind: "all" }),
      authorizeSessionCreate: async (input) => {
        beforeCreator = input.creator;
        if (!input.creator?.readCredential) throw new Error("Browser proof missing");
        await input.creator.readCredential();
        firstMinted = true;
        return { allowed: true };
      },
      sessionCreated: async (input) => {
        createdSessionId = input.sessionId;
        expect(input.creator).toBe(beforeCreator);
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
        if (!input.creator?.readCredential) throw new Error("Browser proof missing");
        try {
          await input.creator.readCredential();
        } catch {
          secondRefused = true;
        }
        throw new Error("Host refuses revoked creator");
      },
    },
  );
  owner = await ownerWithOrganization(instance, "Revoking Creator Owner");
  const member = await signUp(instance, "Revoking Creator Member");
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: owner.organizationId,
    actorSubjectId: owner.subjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId: member.subjectId,
    targetEmail: member.email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  ({ membership } = await acceptOrganizationInvitation(client.db, {
    organizationId: owner.organizationId,
    actorSubjectId: member.subjectId,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  }));
  const response = await instance.request(
    `/v1/workspaces/${membership.personalWorkspaceId}/sessions`,
    {
      method: "POST",
      headers: { cookie: member.cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ initialMessage: "Test request" }),
    },
  );
  expect(response.status).toBe(503);
  expect(firstMinted).toBe(true);
  expect(createdSessionId).not.toBe("");
  expect(secondRefused).toBe(true);
  const [state] = await shared.admin<{ state: string; turns: number }[]>`
    select host_session_create_state as state,
      (select count(*)::int from session_turns where session_id = ${createdSessionId}) as turns
    from sessions where id = ${createdSessionId}`;
  expect(state).toEqual({ state: "failed", turns: 0 });
}, 60_000);
