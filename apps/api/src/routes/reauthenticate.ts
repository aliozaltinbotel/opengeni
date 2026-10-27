import type { ApiRouteDeps, ManagedAuth } from "@opengeni/core";
import type { Context, Hono } from "hono";
import { z } from "zod";

import { verifyManagedAuthPassword } from "../auth/managed-auth";
import {
  consumeTotpCode,
  readCredentialPasswordHash,
  readTotpFactor,
  recordSessionAuthentication,
  signInAuthenticationMethod,
  type AuthenticationMethod,
} from "../auth/session-authentication";
import { admitManagedSignInMutation } from "./managed-sign-in-methods";
import {
  requireStepUpSession,
  StepUpRefusalError,
  throttleStepUpPerson,
  throttleStepUpSource,
  withStepUpRefusals,
  type StepUpRefusal,
  type StepUpSession,
} from "./managed-auth-step-up";

/**
 * `POST /v1/auth/reauthenticate`: a signed-in person proves who they are again
 * without starting a new session. The proof is their password, or a social
 * sign-in they completed in the last five minutes (that sign-in started this
 * session), plus their TOTP code when they enrolled one. A success appends one
 * authentication event to the session, which then sets the host session
 * token's `auth_time` and `amr`.
 *
 * `GET /v1/auth/reauthenticate` tells the re-authentication page which proofs
 * to ask for.
 *
 * The routes exist when the host session token or TOTP is configured; a stock
 * deployment answers `404 REAUTH_DISABLED`. Register before Better Auth's
 * `/v1/auth/*` wildcard.
 */
export const REAUTH_REFUSALS = {
  disabled: {
    status: 404,
    code: "REAUTH_DISABLED",
    message: "Re-authentication is not available on this deployment",
  },
  invalidRequest: {
    status: 400,
    code: "REAUTH_INVALID_REQUEST",
    message: "Send an optional password and an optional six-digit totp code",
  },
  sessionRequired: {
    status: 401,
    code: "REAUTH_SESSION_REQUIRED",
    message: "A signed-in browser session is required",
  },
  failed: {
    status: 401,
    code: "REAUTH_FAILED",
    message: "We couldn't confirm it's you",
  },
  totpRequired: {
    status: 400,
    code: "REAUTH_TOTP_REQUIRED",
    message: "Enter the code from your authenticator app",
  },
  rateLimited: {
    status: 429,
    code: "REAUTH_RATE_LIMITED",
    message: "Too many attempts. Try again later.",
  },
} as const satisfies Record<string, StepUpRefusal & { code: `REAUTH_${string}` }>;

const ReauthenticationRequest = z
  .object({
    password: z.string().min(1).max(1024).optional(),
    totp: z
      .string()
      .regex(/^\d{6}$/u)
      .optional(),
  })
  .strict();

export type ReauthenticationResult = { authTime: string; amr: AuthenticationMethod[] };

export function registerReauthenticationRoutes(app: Hono, deps: ApiRouteDeps): void {
  const auth = deps.managedAuth;
  const available = Boolean(
    auth && (deps.settings.hostTokenAudience || deps.settings.managedAuthTotpEnabled),
  );
  app.get("/v1/auth/reauthenticate", (context) =>
    withStepUpRefusals(context, async () => {
      if (!available || !auth) throw new StepUpRefusalError(REAUTH_REFUSALS.disabled);
      const session = await requireStepUpSession(
        context,
        deps,
        auth,
        REAUTH_REFUSALS.sessionRequired,
      );
      return context.json({
        password: (await readCredentialPasswordHash(deps.db, session.authUserId)) !== null,
        totpRequired: await totpEnrolled(deps, session),
      });
    }),
  );
  app.post("/v1/auth/reauthenticate", (context) =>
    withStepUpRefusals(context, async () => {
      if (!available || !auth) throw new StepUpRefusalError(REAUTH_REFUSALS.disabled);
      return context.json(await reauthenticate(context, deps, auth));
    }),
  );
}

async function totpEnrolled(deps: ApiRouteDeps, session: StepUpSession): Promise<boolean> {
  if (!deps.settings.managedAuthTotpEnabled) return false;
  return (await readTotpFactor(deps.db, session.authUserId))?.verified === true;
}

async function reauthenticate(
  context: Context,
  deps: ApiRouteDeps,
  auth: ManagedAuth,
): Promise<ReauthenticationResult> {
  await throttleStepUpSource(context, deps, "reauthenticate", REAUTH_REFUSALS.rateLimited);
  await admitManagedSignInMutation(context, deps);
  const parsed = ReauthenticationRequest.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new StepUpRefusalError(REAUTH_REFUSALS.invalidRequest);
  const { password, totp } = parsed.data;
  const session = await requireStepUpSession(context, deps, auth, REAUTH_REFUSALS.sessionRequired);
  await throttleStepUpPerson(context, deps, session.email, REAUTH_REFUSALS.rateLimited);

  const firstFactor = await verifyFirstFactor(deps, session, password);
  const amr: AuthenticationMethod[] = [firstFactor];
  // The password is checked first, so the response never reveals whether a
  // person enrolled TOTP to someone who does not know their password.
  if (deps.settings.managedAuthTotpEnabled) {
    const factor = await readTotpFactor(deps.db, session.authUserId);
    if (factor?.verified) {
      if (totp === undefined) throw new StepUpRefusalError(REAUTH_REFUSALS.totpRequired);
      if (!(await consumeTotpCode(deps.db, auth, factor, totp))) {
        throw new StepUpRefusalError(REAUTH_REFUSALS.failed);
      }
      amr.push("otp");
    }
  }
  // A social proof is the sign-in that started this session: without a second
  // factor nothing new was proven, so the event keeps that sign-in's time.
  const authenticatedAt = await recordSessionAuthentication(deps.db, {
    authSessionId: session.authSessionId,
    amr,
    ...(firstFactor === "oauth" && amr.length === 1
      ? { authenticatedAt: session.authentication.signedInAt }
      : {}),
  });
  return { authTime: authenticatedAt.toISOString(), amr };
}

/** The password, or else a social sign-in that started this session moments ago. */
async function verifyFirstFactor(
  deps: ApiRouteDeps,
  session: StepUpSession,
  password: string | undefined,
): Promise<"pwd" | "oauth"> {
  if (password !== undefined) {
    const hash = await readCredentialPasswordHash(deps.db, session.authUserId);
    if (!hash || !(await verifyManagedAuthPassword(password, hash))) {
      throw new StepUpRefusalError(REAUTH_REFUSALS.failed);
    }
    return "pwd";
  }
  const { loginBindingId, signedInRecently } = session.authentication;
  const signInMethod = signInAuthenticationMethod(
    loginBindingId ? session.bindingProviders.get(loginBindingId) : undefined,
  );
  if (signInMethod !== "oauth" || !signedInRecently) {
    throw new StepUpRefusalError(REAUTH_REFUSALS.failed);
  }
  return "oauth";
}
