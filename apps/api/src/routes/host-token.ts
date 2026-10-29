import { canonicalPublicOrigin } from "@opengeni/config";
import {
  requireAccessGrantAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  type ManagedAuth,
} from "@opengeni/core";
import { requireCanonicalHumanRequestIdentity } from "@opengeni/core/canonical-human-identities";
import {
  activeCanonicalHumanLoginBinding,
  CanonicalHumanIdentityNotFoundError,
  getCanonicalHumanIdentityProjection,
  getVerifiedAuthUserEmail,
} from "@opengeni/db/canonical-human-identities";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";

import {
  hostSessionTokenJwks,
  signHostSessionToken,
  type HostSessionTokenJwks,
} from "../auth/managed-auth";
import {
  consumeManagedAuthEmailThrottle,
  managedAuthHostTokenThrottleKey,
  MANAGED_AUTH_HOST_TOKEN_RATE_LIMIT,
} from "../auth/managed-auth-rate-limits";
import {
  readSessionAuthentication,
  type AuthenticationMethod,
  type SessionAuthenticationRecord,
} from "../auth/session-authentication";

/**
 * Audience-bound host session token. A host that embeds Opengeni verifies the
 * person locally: `GET /v1/auth/host-token?workspace=<id>` returns a short-lived
 * ES256 JWT for one workspace, signed by Better Auth's jwt plugin, and
 * `GET /v1/auth/jwks` publishes its public keys. The token names the
 * identity's active login binding (`login_binding_id`, and that binding's
 * `login_binding_revision`), so a host can tell a rebound sign-in method from
 * the one it linked without an identity round trip.
 *
 * `GET /v1/auth/host-token?purpose=registration` mints the registration
 * variant for a signed-in person who may have no workspace yet: no `org` and
 * no `ws` (the keys are absent), `purpose: "registration"`, the verified
 * `email` with `email_verified: true`, and the same login binding claims. It
 * shares the per-session mint limit. Opengeni itself accepts no host session
 * token of either kind as a credential: every route here answers its own
 * authentication refusal to one, and a host must refuse a `purpose` token
 * anywhere but its registration endpoint. Without
 * OPENGENI_HOST_TOKEN_AUDIENCE the token route refuses and every other path
 * keeps its stock behaviour.
 *
 * Register before Better Auth's `/v1/auth/*` wildcard.
 */
export const HOST_TOKEN_REFUSALS = {
  disabled: {
    status: 404,
    code: "HOST_TOKEN_DISABLED",
    message: "Host session tokens are disabled",
  },
  workspaceInvalid: {
    status: 400,
    code: "HOST_TOKEN_WORKSPACE_INVALID",
    message: "Query parameter workspace must be a workspace id",
  },
  sessionRequired: {
    status: 401,
    code: "HOST_TOKEN_SESSION_REQUIRED",
    message: "A signed-in browser session is required",
  },
  purposeInvalid: {
    status: 400,
    code: "HOST_TOKEN_PURPOSE_INVALID",
    message: "Query parameter purpose must be registration, without a workspace",
  },
  emailNotVerified: {
    status: 403,
    code: "HOST_TOKEN_EMAIL_NOT_VERIFIED",
    message: "Verify your email address first",
  },
  notMember: {
    status: 403,
    code: "HOST_TOKEN_NOT_MEMBER",
    message: "You are not an active member of this workspace's organization",
  },
  identityNotActive: {
    status: 403,
    code: "HOST_TOKEN_IDENTITY_NOT_ACTIVE",
    message: "Your account identity is not active",
  },
  authenticationUnknown: {
    status: 403,
    code: "HOST_TOKEN_AUTHENTICATION_UNKNOWN",
    message: "This session has no recorded sign-in. Confirm it's you, or sign in again.",
  },
  loginBindingUnknown: {
    status: 403,
    code: "HOST_TOKEN_LOGIN_BINDING_UNKNOWN",
    message: "Your account has no active sign-in method. Sign in again.",
  },
  rateLimited: {
    status: 429,
    code: "HOST_TOKEN_RATE_LIMITED",
    message: "Too many host session tokens for this session. Try again shortly.",
  },
} as const satisfies Record<
  string,
  { status: ContentfulStatusCode; code: `HOST_TOKEN_${string}`; message: string }
>;

type HostTokenRefusal = (typeof HOST_TOKEN_REFUSALS)[keyof typeof HOST_TOKEN_REFUSALS];

class HostTokenRefusalError extends Error {
  constructor(
    readonly refusal: HostTokenRefusal,
    readonly retryAfterSeconds?: number,
  ) {
    super(refusal.message);
    this.name = "HostTokenRefusalError";
  }
}

/** How long a verifier, and this process, may reuse a published JWKS. */
export const HOST_TOKEN_JWKS_MAX_AGE_SECONDS = 300;

// Only used when no Better Auth secret is configured (local development);
// the counter key is a content-free digest either way.
const THROTTLE_FALLBACK_KEY = "opengeni:managed-auth:host-token-throttle:local";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type HostTokenConfiguration = {
  auth: ManagedAuth;
  audience: string;
  issuer: string;
  ttlSeconds: number;
  jwks: HostTokenJwksCache;
};

export function registerHostTokenRoutes(app: Hono, deps: ApiRouteDeps): void {
  const configuration = hostTokenConfiguration(deps);
  app.get("/v1/auth/host-token", async (context) => {
    context.header("cache-control", "no-store");
    if (!configuration) return refuse(context, HOST_TOKEN_REFUSALS.disabled);
    try {
      return context.json(await mintHostSessionToken(context, deps, configuration));
    } catch (error) {
      if (error instanceof HostTokenRefusalError) {
        if (error.retryAfterSeconds !== undefined)
          context.header("retry-after", String(error.retryAfterSeconds));
        return refuse(context, error.refusal);
      }
      throw error;
    }
  });
  if (!configuration) return;

  app.get("/v1/auth/jwks", async (context) => {
    context.header("cache-control", `public, max-age=${HOST_TOKEN_JWKS_MAX_AGE_SECONDS}`);
    return context.json(await configuration.jwks.read());
  });
  // The plugin's own token endpoint signs the whole user object for any
  // session holder. Only the host token route may sign.
  app.on(["GET", "POST"], "/v1/auth/token", () => {
    throw new HTTPException(404, { message: "Not Found" });
  });
}

function hostTokenConfiguration(deps: ApiRouteDeps): HostTokenConfiguration | null {
  const audience = deps.settings.hostTokenAudience;
  const issuer = canonicalPublicOrigin(deps.settings.publicBaseUrl);
  if (!audience || !deps.managedAuth || !issuer) return null;
  return {
    auth: deps.managedAuth,
    audience,
    issuer,
    ttlSeconds: deps.settings.hostTokenTtlSeconds,
    jwks: createHostTokenJwksCache(deps.managedAuth),
  };
}

type HostTokenJwksCache = {
  /** The published JWKS, read from the key store at most once per max-age. */
  read(): Promise<HostSessionTokenJwks>;
  /** Called with each minted token's key id: a key not yet cached drops the cache. */
  noteSigningKey(kid: string | undefined): void;
};

/**
 * The JWKS kept in process memory for `HOST_TOKEN_JWKS_MAX_AGE_SECONDS`, the
 * same time verifiers may cache it. A failed read is not cached, and a token
 * signed with a key the cached set lacks (a cleared or newly created key)
 * drops the cache, so this process never publishes a set missing its own
 * signing key.
 */
function createHostTokenJwksCache(auth: ManagedAuth): HostTokenJwksCache {
  let cached: { jwks: HostSessionTokenJwks; expiresAtMs: number } | null = null;
  let pending: Promise<HostSessionTokenJwks> | null = null;
  let generation = 0;
  const load = (): Promise<HostSessionTokenJwks> => {
    const startedGeneration = generation;
    return hostSessionTokenJwks(auth).then((jwks) => {
      if (startedGeneration === generation)
        cached = { jwks, expiresAtMs: Date.now() + HOST_TOKEN_JWKS_MAX_AGE_SECONDS * 1000 };
      return jwks;
    });
  };
  return {
    async read() {
      if (cached && Date.now() < cached.expiresAtMs) return cached.jwks;
      if (!pending) {
        const inFlight: Promise<HostSessionTokenJwks> = load().finally(() => {
          // An invalidation may have started a newer load meanwhile; keep it.
          if (pending === inFlight) pending = null;
        });
        pending = inFlight;
      }
      return await pending;
    },
    noteSigningKey(kid) {
      // Nothing cached yet: the next read loads the current set anyway, and a
      // read in flight must not be restarted by every mint.
      if (!cached || cached.jwks.keys.some((key) => key.kid === kid)) return;
      cached = null;
      pending = null;
      generation += 1;
    },
  };
}

/** The `kid` of a compact JWS this process just signed. */
function signingKeyId(token: string): string | undefined {
  try {
    const header: unknown = JSON.parse(
      Buffer.from(token.split(".", 1)[0] ?? "", "base64url").toString("utf8"),
    );
    const kid = (header as { kid?: unknown } | null)?.kid;
    return typeof kid === "string" ? kid : undefined;
  } catch {
    return undefined;
  }
}

function throttleSecret(deps: ApiRouteDeps): string {
  return deps.settings.betterAuthSecret ?? THROTTLE_FALLBACK_KEY;
}

/** Count one mint against the session's window. */
async function throttleHostTokenSession(deps: ApiRouteDeps, authSessionId: string): Promise<void> {
  const attempt = await consumeManagedAuthEmailThrottle(deps.db, {
    key: managedAuthHostTokenThrottleKey(throttleSecret(deps), authSessionId),
    windowSeconds: MANAGED_AUTH_HOST_TOKEN_RATE_LIMIT.window,
    max: MANAGED_AUTH_HOST_TOKEN_RATE_LIMIT.max,
  });
  if (!attempt.allowed)
    throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.rateLimited, attempt.retryAfterSeconds);
}

function refuse(context: Context, refusal: HostTokenRefusal): Response {
  return context.json({ code: refusal.code, message: refusal.message }, refusal.status);
}

/** What a mint request asks for: one workspace, or registration (no workspace). */
type HostTokenRequest = { purpose: "workspace"; workspaceId: string } | { purpose: "registration" };

function hostTokenRequest(context: Context): HostTokenRequest {
  const purpose = context.req.query("purpose");
  const workspaceId = context.req.query("workspace");
  if (purpose !== undefined) {
    // A registration token names no workspace, so a request for both is refused.
    if (purpose !== "registration" || workspaceId !== undefined) {
      throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.purposeInvalid);
    }
    return { purpose: "registration" };
  }
  if (!workspaceId || !UUID.test(workspaceId)) {
    throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.workspaceInvalid);
  }
  return { purpose: "workspace", workspaceId };
}

async function mintHostSessionToken(
  context: Context,
  deps: ApiRouteDeps,
  configuration: HostTokenConfiguration,
): Promise<{ token: string; expiresAt: string }> {
  const request = hostTokenRequest(context);
  // A browser session only: bearer credentials never mint a host token.
  if (context.req.header("authorization") || !context.req.header("cookie")) {
    throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.sessionRequired);
  }
  // Recovery sessions are resolved too, so a non-active identity gets its own
  // refusal instead of looking signed out.
  const human = await refuseOnHttpStatus(
    requireCanonicalHumanRequestIdentity(context, {
      db: deps.db,
      managedAuth: configuration.auth,
      managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
      managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
      allowRecovery: true,
    }),
    { 401: HOST_TOKEN_REFUSALS.sessionRequired },
  );
  // One counter per session, whatever the purpose.
  await throttleHostTokenSession(deps, human.authSessionId);
  const projection = await getCanonicalHumanIdentityProjection(deps.db, human.authUserId).catch(
    (error: unknown) => {
      if (error instanceof CanonicalHumanIdentityNotFoundError) {
        throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.sessionRequired);
      }
      throw error;
    },
  );
  const identity = projection.activeIdentity;
  if (identity.status !== "active") {
    throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.identityNotActive);
  }
  // The same binding the host identity lookup names as `activeLoginBinding`,
  // so a host compares the claim with what it recorded at link time.
  const loginBinding = activeCanonicalHumanLoginBinding(projection);
  if (!loginBinding) throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.loginBindingUnknown);
  const authentication = await readSessionAuthentication(deps.db, human);
  if (!authentication || authentication.identityId !== identity.id) {
    throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.sessionRequired);
  }
  const target =
    request.purpose === "registration"
      ? await registrationClaims(deps, human.authUserId)
      : await workspaceClaims(context, deps, human.authUserId, request.workspaceId);
  const latest = latestAuthentication(authentication);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + configuration.ttlSeconds;
  const token = await signHostSessionToken(configuration.auth, {
    iss: configuration.issuer,
    aud: configuration.audience,
    sub: identity.id,
    sid: human.authSessionId,
    ...target,
    auth_time: Math.floor(latest.authenticatedAt.getTime() / 1000),
    amr: latest.amr,
    identity_status: "active",
    login_binding_id: loginBinding.id,
    login_binding_revision: loginBinding.revision,
    iat: issuedAt,
    exp: expiresAt,
    jti: crypto.randomUUID(),
  });
  configuration.jwks.noteSigningKey(signingKeyId(token));
  return { token, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

/** A workspace token's target: the workspace and its organization, from a live membership. */
async function workspaceClaims(
  context: Context,
  deps: ApiRouteDeps,
  authUserId: string,
  workspaceId: string,
): Promise<{ org: string; ws: string }> {
  // The canonical access resolver re-derives live membership: a suspended or
  // revoked organization membership has no grant here.
  const authorization = await refuseOnHttpStatus(
    requireAccessGrantAuthorization(context, deps, workspaceId, "workspace:read"),
    {
      401: HOST_TOKEN_REFUSALS.sessionRequired,
      403: HOST_TOKEN_REFUSALS.notMember,
      404: HOST_TOKEN_REFUSALS.notMember,
    },
  );
  return { org: activeOrganizationOf(authorization, authUserId, workspaceId), ws: workspaceId };
}

/**
 * A registration token's target: no organization or workspace (the keys are
 * absent), the account's verified email. It never depends on a membership,
 * so a signed-in person with no workspace can register one with the host.
 */
async function registrationClaims(
  deps: ApiRouteDeps,
  authUserId: string,
): Promise<{ purpose: "registration"; email: string; email_verified: true }> {
  const email = await getVerifiedAuthUserEmail(deps.db, authUserId);
  if (!email) throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.emailNotVerified);
  return { purpose: "registration", email, email_verified: true };
}

/** The organization of an exact, cookie-authenticated, active membership grant. */
function activeOrganizationOf(
  authorization: AccessGrantAuthorization,
  authUserId: string,
  workspaceId: string,
): string {
  const { grant, accountGrant } = authorization;
  if (
    !authorization.canonicalManagedHumanSession ||
    !authorization.contextIntegrity ||
    authorization.authenticatedSubjectId !== `user:${authUserId}` ||
    grant.workspaceId !== workspaceId ||
    accountGrant?.accountId !== grant.accountId
  ) {
    throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.notMember);
  }
  return grant.accountId;
}

/**
 * The session's latest recorded authentication: its sign-in, a
 * re-authentication, or the authentication it inherited from the session that
 * approved it. The session's creation time is never used, and a refresh
 * records nothing, so `auth_time` moves only with a real authentication. A
 * session without one refuses minting: `amr` is never empty.
 */
function latestAuthentication(authentication: SessionAuthenticationRecord): {
  authenticatedAt: Date;
  amr: AuthenticationMethod[];
} {
  if (!authentication.latest) {
    throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.authenticationUnknown);
  }
  return authentication.latest;
}

async function refuseOnHttpStatus<T>(
  pending: Promise<T>,
  refusals: Partial<Record<number, HostTokenRefusal>>,
): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    const refusal = error instanceof HTTPException ? refusals[error.status] : undefined;
    if (refusal) throw new HostTokenRefusalError(refusal);
    throw error;
  }
}
