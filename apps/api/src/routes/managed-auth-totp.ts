import type { ApiRouteDeps, ManagedAuth } from "@opengeni/core";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { beginManagedAuthTotpEnrollment, verifyManagedAuthPassword } from "../auth/managed-auth";
import {
  consumeTotpCode,
  readCredentialPasswordHash,
  readTotpFactor,
  type TotpFactor,
} from "../auth/session-authentication";
import { admitManagedSignInMutation } from "./managed-sign-in-methods";
import {
  requireStepUpSession,
  stepUpSessionProofHeaders,
  StepUpRefusalError,
  throttleStepUpPerson,
  throttleStepUpSource,
  withStepUpRefusals,
  type StepUpRefusal,
  type StepUpSession,
} from "./managed-auth-step-up";

/**
 * TOTP enrollment for re-authentication (OPENGENI_MANAGED_AUTH_TOTP_ENABLED).
 * Product-owned so it works in every session-set mode and never rotates the
 * session (the plugin's own verify and disable routes replace the session,
 * which would reset its sign-in time):
 *
 * - `GET /v1/auth/totp` reports `none`, `pending` or `enrolled`.
 * - `POST /v1/auth/totp/enroll {password?}` starts an enrollment through the
 *   plugin's enable endpoint and returns the `otpauth://` URI.
 * - `POST /v1/auth/totp/confirm {code}` turns the pending factor on.
 * - `POST /v1/auth/totp/disable {password?, code}` removes the factor.
 *
 * Enroll and disable need the password, or a sign-in in the last five minutes
 * from someone without one. Without the setting every route answers
 * `404 TOTP_DISABLED`, and the plugin's own `/two-factor/*` routes are refused
 * whenever it runs. Register before Better Auth's `/v1/auth/*` wildcard.
 */
export const TOTP_REFUSALS = {
  disabled: {
    status: 404,
    code: "TOTP_DISABLED",
    message: "Authenticator app codes are not available on this deployment",
  },
  invalidRequest: {
    status: 400,
    code: "TOTP_INVALID_REQUEST",
    message: "The request body is not valid for this route",
  },
  sessionRequired: {
    status: 401,
    code: "TOTP_SESSION_REQUIRED",
    message: "A signed-in browser session is required",
  },
  authenticationRequired: {
    status: 401,
    code: "TOTP_AUTHENTICATION_REQUIRED",
    message: "Enter your password, or sign in again if you don't have one",
  },
  invalidCode: {
    status: 400,
    code: "TOTP_INVALID_CODE",
    message: "That code didn't match. Enter the current code from your authenticator app.",
  },
  alreadyEnrolled: {
    status: 409,
    code: "TOTP_ALREADY_ENROLLED",
    message: "An authenticator app is already set up",
  },
  enrollmentNotStarted: {
    status: 409,
    code: "TOTP_ENROLLMENT_NOT_STARTED",
    message: "Start setting up an authenticator app first",
  },
  notEnrolled: {
    status: 409,
    code: "TOTP_NOT_ENROLLED",
    message: "No authenticator app is set up",
  },
  locked: {
    status: 429,
    code: "TOTP_LOCKED",
    message: "Too many wrong codes. Your authenticator app is locked for a while.",
  },
  rateLimited: {
    status: 429,
    code: "TOTP_RATE_LIMITED",
    message: "Too many attempts. Try again later.",
  },
} as const satisfies Record<string, StepUpRefusal & { code: `TOTP_${string}` }>;

const Password = z.string().min(1).max(1024);
const Code = z.string().regex(/^\d{6}$/u);
const EnrollRequest = z.object({ password: Password.optional() }).strict();
const ConfirmRequest = z.object({ code: Code }).strict();
const DisableRequest = z.object({ password: Password.optional(), code: Code }).strict();

export type TotpStatus = "none" | "pending" | "enrolled";

export function registerManagedAuthTotpRoutes(app: Hono, deps: ApiRouteDeps): void {
  const totpAuth = deps.settings.managedAuthTotpEnabled ? deps.managedAuth : null;
  if (totpAuth) {
    // The plugin's routes rotate the session or serve factors this product
    // does not offer (backup codes, emailed codes).
    app.on(["GET", "POST"], "/v1/auth/two-factor/*", () => {
      throw new HTTPException(404, { message: "Not Found" });
    });
  }
  const route = (
    method: "get" | "post",
    path: string,
    handler: (context: Context, auth: ManagedAuth) => Promise<Response>,
  ) =>
    app[method](path, (context) =>
      withStepUpRefusals(context, async () => {
        if (!totpAuth) throw new StepUpRefusalError(TOTP_REFUSALS.disabled);
        return await handler(context, totpAuth);
      }),
    );

  route("get", "/v1/auth/totp", async (context, auth) => {
    const session = await requireStepUpSession(context, deps, auth, TOTP_REFUSALS.sessionRequired);
    return context.json({ status: totpStatus(await readTotpFactor(deps.db, session.authUserId)) });
  });

  route("post", "/v1/auth/totp/enroll", async (context, auth) => {
    const { session, body } = await admitTotpMutation(context, deps, auth, EnrollRequest);
    if ((await readTotpFactor(deps.db, session.authUserId))?.verified) {
      throw new StepUpRefusalError(TOTP_REFUSALS.alreadyEnrolled);
    }
    await requireFirstFactor(deps, session, body.password);
    try {
      const totpURI = await beginManagedAuthTotpEnrollment(auth, {
        headers: await stepUpSessionProofHeaders(deps, auth, session),
        ...(body.password === undefined ? {} : { password: body.password }),
      });
      return context.json({ totpURI });
    } catch (error) {
      if (error instanceof APIError && error.status === "BAD_REQUEST") {
        throw new StepUpRefusalError(TOTP_REFUSALS.authenticationRequired);
      }
      throw error;
    }
  });

  route("post", "/v1/auth/totp/confirm", async (context, auth) => {
    const { session, body } = await admitTotpMutation(context, deps, auth, ConfirmRequest);
    const factor = await readTotpFactor(deps.db, session.authUserId);
    if (!factor || factor.verified) {
      throw new StepUpRefusalError(TOTP_REFUSALS.enrollmentNotStarted);
    }
    await requireTotpCode(deps, auth, factor, body.code);
    await setTotpEnrollment(deps, session.authUserId, factor, true);
    return context.json({ status: "enrolled" satisfies TotpStatus });
  });

  route("post", "/v1/auth/totp/disable", async (context, auth) => {
    const { session, body } = await admitTotpMutation(context, deps, auth, DisableRequest);
    const factor = await readTotpFactor(deps.db, session.authUserId);
    if (!factor?.verified) throw new StepUpRefusalError(TOTP_REFUSALS.notEnrolled);
    await requireFirstFactor(deps, session, body.password);
    await requireTotpCode(deps, auth, factor, body.code);
    await setTotpEnrollment(deps, session.authUserId, factor, false);
    return context.json({ status: "none" satisfies TotpStatus });
  });
}

function totpStatus(factor: TotpFactor | null): TotpStatus {
  return !factor ? "none" : factor.verified ? "enrolled" : "pending";
}

async function admitTotpMutation<T extends z.ZodType>(
  context: Context,
  deps: ApiRouteDeps,
  auth: ManagedAuth,
  schema: T,
): Promise<{ session: StepUpSession; body: z.infer<T> }> {
  await throttleStepUpSource(context, deps, "totp", TOTP_REFUSALS.rateLimited);
  await admitManagedSignInMutation(context, deps);
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new StepUpRefusalError(TOTP_REFUSALS.invalidRequest);
  const session = await requireStepUpSession(context, deps, auth, TOTP_REFUSALS.sessionRequired);
  await throttleStepUpPerson(context, deps, session.email, TOTP_REFUSALS.rateLimited);
  return { session, body: parsed.data };
}

async function requireTotpCode(
  deps: ApiRouteDeps,
  auth: ManagedAuth,
  factor: TotpFactor,
  code: string,
): Promise<void> {
  const outcome = await consumeTotpCode(deps.db, auth, factor, code);
  if (outcome.kind === "locked") {
    throw new StepUpRefusalError(TOTP_REFUSALS.locked, outcome.retryAfterSeconds);
  }
  if (outcome.kind !== "accepted") throw new StepUpRefusalError(TOTP_REFUSALS.invalidCode);
}

/**
 * The password when the person has one; otherwise an authentication of this
 * session at most five minutes old.
 */
async function requireFirstFactor(
  deps: ApiRouteDeps,
  session: StepUpSession,
  password: string | undefined,
): Promise<void> {
  const hash = await readCredentialPasswordHash(deps.db, session.authUserId);
  const proven = hash
    ? password !== undefined && (await verifyManagedAuthPassword(password, hash))
    : session.authentication.latest?.recent === true;
  if (!proven) throw new StepUpRefusalError(TOTP_REFUSALS.authenticationRequired);
}

/**
 * Turn a factor on (pending to enrolled) or remove it, with the plugin's user
 * flag kept in step. Both writes are guarded by the factor that was checked,
 * so a concurrent re-enrollment is never confirmed or removed by mistake.
 */
async function setTotpEnrollment(
  deps: ApiRouteDeps,
  authUserId: string,
  factor: TotpFactor,
  enrolled: boolean,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const result = await tx.execute(
      enrolled
        ? sql`
            update auth_two_factors set verified = true
            where id = ${factor.id} and user_id = ${authUserId} and verified = false
            returning id
          `
        : sql`
            delete from auth_two_factors
            where id = ${factor.id} and user_id = ${authUserId} and verified = true
            returning id
          `,
    );
    const changed = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows).length;
    if (changed !== 1) {
      throw new StepUpRefusalError(
        enrolled ? TOTP_REFUSALS.enrollmentNotStarted : TOTP_REFUSALS.notEnrolled,
      );
    }
    await tx.execute(
      sql`update auth_users set two_factor_enabled = ${enrolled} where id = ${authUserId}`,
    );
  });
}
