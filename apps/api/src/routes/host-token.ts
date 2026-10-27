import { canonicalPublicOrigin } from "@opengeni/config";
import {
  requireAccessGrantAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  type ManagedAuth,
} from "@opengeni/core";
import { requireCanonicalHumanRequestIdentity } from "@opengeni/core/canonical-human-identities";
import {
  CanonicalHumanIdentityNotFoundError,
  getCanonicalHumanIdentityProjection,
} from "@opengeni/db/canonical-human-identities";
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";

import { hostSessionTokenJwks, signHostSessionToken } from "../auth/managed-auth";

/**
 * Audience-bound host session token. A host that embeds Opengeni verifies the
 * person locally: `GET /v1/auth/host-token?workspace=<id>` returns a short-lived
 * ES256 JWT for one workspace, signed by Better Auth's jwt plugin, and
 * `GET /v1/auth/jwks` publishes its public keys. Without
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
} as const satisfies Record<
  string,
  { status: ContentfulStatusCode; code: `HOST_TOKEN_${string}`; message: string }
>;

type HostTokenRefusal = (typeof HOST_TOKEN_REFUSALS)[keyof typeof HOST_TOKEN_REFUSALS];

class HostTokenRefusalError extends Error {
  constructor(readonly refusal: HostTokenRefusal) {
    super(refusal.message);
    this.name = "HostTokenRefusalError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Login-binding provider to RFC 8176 authentication method reference. */
const AMR_BY_PROVIDER: Readonly<Record<string, string>> = {
  credential: "pwd",
  google: "oauth",
  github: "oauth",
};

type HostTokenConfiguration = {
  auth: ManagedAuth;
  audience: string;
  issuer: string;
  ttlSeconds: number;
};

export function registerHostTokenRoutes(app: Hono, deps: ApiRouteDeps): void {
  const configuration = hostTokenConfiguration(deps);
  app.get("/v1/auth/host-token", async (context) => {
    context.header("cache-control", "no-store");
    if (!configuration) return refuse(context, HOST_TOKEN_REFUSALS.disabled);
    try {
      return context.json(await mintHostSessionToken(context, deps, configuration));
    } catch (error) {
      if (error instanceof HostTokenRefusalError) return refuse(context, error.refusal);
      throw error;
    }
  });
  if (!configuration) return;

  app.get("/v1/auth/jwks", async (context) => {
    context.header("cache-control", "public, max-age=300");
    return context.json(await hostSessionTokenJwks(configuration.auth));
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
  };
}

function refuse(context: Context, refusal: HostTokenRefusal): Response {
  return context.json({ code: refusal.code, message: refusal.message }, refusal.status);
}

async function mintHostSessionToken(
  context: Context,
  deps: ApiRouteDeps,
  configuration: HostTokenConfiguration,
): Promise<{ token: string; expiresAt: string }> {
  const workspaceId = context.req.query("workspace");
  if (!workspaceId || !UUID.test(workspaceId)) {
    throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.workspaceInvalid);
  }
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
  const loginRecord = await readSessionLoginRecord(deps, human);
  if (!loginRecord || loginRecord.identityId !== identity.id) {
    throw new HostTokenRefusalError(HOST_TOKEN_REFUSALS.sessionRequired);
  }
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
  const organizationId = activeOrganizationOf(authorization, human.authUserId, workspaceId);
  const binding = projection.loginBindings.find(
    (candidate) => candidate.id === loginRecord.loginBindingId,
  );
  const amr = binding && AMR_BY_PROVIDER[binding.providerId];
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + configuration.ttlSeconds;
  const token = await signHostSessionToken(configuration.auth, {
    iss: configuration.issuer,
    aud: configuration.audience,
    sub: identity.id,
    sid: human.authSessionId,
    org: organizationId,
    ws: workspaceId,
    auth_time: Math.floor(loginRecord.createdAt.getTime() / 1000),
    amr: amr ? [amr] : [],
    identity_status: "active",
    iat: issuedAt,
    exp: expiresAt,
    jti: crypto.randomUUID(),
  });
  return { token, expiresAt: new Date(expiresAt * 1000).toISOString() };
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
 * `auth_time` is the session's own sign-in: Better Auth's sliding renewal moves
 * `updated_at`/`expires_at`, never `created_at`.
 */
async function readSessionLoginRecord(
  deps: ApiRouteDeps,
  human: { authUserId: string; authSessionId: string },
): Promise<{ createdAt: Date; identityId: string | null; loginBindingId: string | null } | null> {
  const result = await deps.db.execute(sql`
    select created_at as "createdAt", identity_id as "identityId",
      login_binding_id as "loginBindingId"
    from auth_sessions
    where id = ${human.authSessionId} and user_id = ${human.authUserId}
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    createdAt: Date | string;
    identityId: string | null;
    loginBindingId: string | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    identityId: row.identityId,
    loginBindingId: row.loginBindingId,
  };
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
