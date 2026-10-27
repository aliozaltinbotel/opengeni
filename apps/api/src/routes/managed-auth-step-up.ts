import type { ApiRouteDeps, ManagedAuth } from "@opengeni/core";
import { requireCanonicalHumanRequestIdentity } from "@opengeni/core/canonical-human-identities";
import {
  CanonicalHumanIdentityNotFoundError,
  getCanonicalHumanIdentityProjection,
} from "@opengeni/db/canonical-human-identities";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  consumeManagedAuthEmailThrottle,
  managedAuthEmailSourceThrottleKey,
  managedAuthEmailThrottleKey,
  managedAuthProductCredentialThrottleKey,
  managedAuthThrottleSource,
  MANAGED_AUTH_EMAIL_THROTTLES,
  MANAGED_AUTH_PRODUCT_CREDENTIAL_RATE_LIMIT,
  type ManagedAuthProductCredentialRoute,
} from "../auth/managed-auth-rate-limits";
import { managedAuthSelectedProofHeaders } from "../auth/managed-auth-session-adapter";
import {
  readSessionAuthentication,
  type SessionAuthenticationRecord,
} from "../auth/session-authentication";

/**
 * Shared request handling of the product-owned step-up routes
 * (`/v1/auth/reauthenticate`, `/v1/auth/totp/*`): named refusals, the
 * credential-guessing limits, and the current managed browser session.
 */

export type StepUpRefusal = {
  status: ContentfulStatusCode;
  code: string;
  message: string;
};

export class StepUpRefusalError extends Error {
  constructor(
    readonly refusal: StepUpRefusal,
    readonly retryAfterSeconds?: number,
  ) {
    super(refusal.message);
    this.name = "StepUpRefusalError";
  }
}

export function stepUpRefusalResponse(context: Context, error: StepUpRefusalError): Response {
  if (error.retryAfterSeconds !== undefined) {
    context.header("retry-after", String(error.retryAfterSeconds));
  }
  return context.json(
    { code: error.refusal.code, message: error.refusal.message },
    error.refusal.status,
  );
}

/** Run a step-up handler, answering its named refusals with their status. */
export async function withStepUpRefusals(
  context: Context,
  handler: () => Promise<Response>,
): Promise<Response> {
  context.header("cache-control", "no-store");
  try {
    return await handler();
  } catch (error) {
    if (error instanceof StepUpRefusalError) return stepUpRefusalResponse(context, error);
    throw error;
  }
}

// Only used when no Better Auth secret is configured (local development);
// the counter key is a content-free digest either way.
const THROTTLE_FALLBACK_KEY = "opengeni:managed-auth:product-credential-throttle:local";

function throttleSecret(deps: ApiRouteDeps): string {
  return deps.settings.betterAuthSecret ?? THROTTLE_FALLBACK_KEY;
}

/**
 * Count one attempt against the route's per-client-address window (the email
 * sign-in limit). Runs before any password or code is checked.
 */
export async function throttleStepUpSource(
  context: Context,
  deps: ApiRouteDeps,
  route: ManagedAuthProductCredentialRoute,
  rateLimited: StepUpRefusal,
): Promise<void> {
  const source = managedAuthThrottleSource(context.req.raw.headers);
  const attempt = await consumeManagedAuthEmailThrottle(deps.db, {
    key: managedAuthProductCredentialThrottleKey(throttleSecret(deps), route, source),
    windowSeconds: MANAGED_AUTH_PRODUCT_CREDENTIAL_RATE_LIMIT.window,
    max: MANAGED_AUTH_PRODUCT_CREDENTIAL_RATE_LIMIT.max,
  });
  if (!attempt.allowed) throw new StepUpRefusalError(rateLimited, attempt.retryAfterSeconds);
}

/**
 * Spend the person's email sign-in throttle, both its per-(email, address)
 * and its per-email window, exactly as an email sign-in attempt would.
 */
export async function throttleStepUpPerson(
  context: Context,
  deps: ApiRouteDeps,
  email: string,
  rateLimited: StepUpRefusal,
): Promise<void> {
  const throttle = MANAGED_AUTH_EMAIL_THROTTLES["/sign-in/email"];
  const secret = throttleSecret(deps);
  const source = managedAuthThrottleSource(context.req.raw.headers);
  const perSource = await consumeManagedAuthEmailThrottle(deps.db, {
    key: managedAuthEmailSourceThrottleKey(secret, throttle.purpose, email, source),
    windowSeconds: throttle.windowSeconds,
    max: throttle.perSourceMax,
  });
  if (!perSource.allowed) throw new StepUpRefusalError(rateLimited, perSource.retryAfterSeconds);
  const perEmail = await consumeManagedAuthEmailThrottle(deps.db, {
    key: managedAuthEmailThrottleKey(secret, throttle.purpose, email),
    windowSeconds: throttle.windowSeconds,
    max: throttle.perEmailMax,
  });
  if (!perEmail.allowed) throw new StepUpRefusalError(rateLimited, perEmail.retryAfterSeconds);
}

export type StepUpSession = {
  authUserId: string;
  authSessionId: string;
  email: string;
  authentication: SessionAuthenticationRecord;
};

/**
 * The current managed browser session of an active canonical identity. Bearer
 * credentials never step up; a recovery, disputed or disabled identity, or a
 * session that is not bound to the active identity, is refused.
 */
export async function requireStepUpSession(
  context: Context,
  deps: ApiRouteDeps,
  auth: ManagedAuth,
  sessionRequired: StepUpRefusal,
): Promise<StepUpSession> {
  if (context.req.header("authorization") || !context.req.header("cookie")) {
    throw new StepUpRefusalError(sessionRequired);
  }
  let human: { authUserId: string; authSessionId: string };
  try {
    human = await requireCanonicalHumanRequestIdentity(context, {
      db: deps.db,
      managedAuth: auth,
      managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
      managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
    });
  } catch (error) {
    if (error instanceof HTTPException && error.status === 401) {
      throw new StepUpRefusalError(sessionRequired);
    }
    throw error;
  }
  const projection = await getCanonicalHumanIdentityProjection(deps.db, human.authUserId).catch(
    (error: unknown) => {
      if (error instanceof CanonicalHumanIdentityNotFoundError) {
        throw new StepUpRefusalError(sessionRequired);
      }
      throw error;
    },
  );
  const identity = projection.activeIdentity;
  const authentication = await readSessionAuthentication(deps.db, human);
  if (identity.status !== "active" || authentication?.identityId !== identity.id) {
    throw new StepUpRefusalError(sessionRequired);
  }
  const result = await deps.db.execute(
    sql`select email from auth_users where id = ${human.authUserId}`,
  );
  const [user] = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    email: string;
  }>;
  if (!user) throw new StepUpRefusalError(sessionRequired);
  return {
    ...human,
    email: user.email,
    authentication,
  };
}

/** Server-only Better Auth session proof for the step-up session's own token. */
export async function stepUpSessionProofHeaders(
  deps: ApiRouteDeps,
  auth: ManagedAuth,
  session: Pick<StepUpSession, "authSessionId">,
): Promise<Headers> {
  const result = await deps.db.execute(
    sql`select token from auth_sessions where id = ${session.authSessionId}`,
  );
  const [row] = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{
    token: string;
  }>;
  if (!row) throw new Error("step-up session disappeared");
  return await managedAuthSelectedProofHeaders(auth, row.token);
}
