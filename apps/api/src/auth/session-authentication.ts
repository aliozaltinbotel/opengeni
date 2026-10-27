import type { Database } from "@opengeni/db";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { sql, type SQL } from "drizzle-orm";

import type { ManagedAuth } from "@opengeni/core";

/**
 * How and when a managed browser session last authenticated. A session's own
 * sign-in is its first authentication; each successful
 * `POST /v1/auth/reauthenticate` appends one `auth_session_authentications`
 * row. Better Auth's sliding renewal moves only `updated_at`/`expires_at`, so a
 * refreshed session never authenticates again.
 */

/** RFC 8176 authentication method references this product issues. */
export type AuthenticationMethod = "pwd" | "oauth" | "otp";

/** Login-binding provider to the authentication method of its sign-in. */
const AMR_BY_PROVIDER: Readonly<Record<string, "pwd" | "oauth">> = {
  credential: "pwd",
  google: "oauth",
  github: "oauth",
};

export function signInAuthenticationMethod(providerId: string | undefined): "pwd" | "oauth" | null {
  return (providerId && AMR_BY_PROVIDER[providerId]) || null;
}

/** A session that signed in at most this long ago counts as a fresh sign-in. */
export const FRESH_SIGN_IN_SECONDS = 300;

export type SessionAuthenticationRecord = {
  identityId: string | null;
  loginBindingId: string | null;
  signedInAt: Date;
  /** Whether the session's own sign-in is at most {@link FRESH_SIGN_IN_SECONDS} old. */
  signedInRecently: boolean;
  /** The latest re-authentication of this session, if any. */
  latestReauthentication: { amr: AuthenticationMethod[]; authenticatedAt: Date } | null;
};

async function rows<T>(db: Pick<Database, "execute">, query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The session's sign-in and latest re-authentication; null when the session is gone. */
export async function readSessionAuthentication(
  db: Pick<Database, "execute">,
  session: { authUserId: string; authSessionId: string },
): Promise<SessionAuthenticationRecord | null> {
  const [row] = await rows<{
    identityId: string | null;
    loginBindingId: string | null;
    signedInAt: Date | string;
    signedInRecently: boolean;
    amr: AuthenticationMethod[] | null;
    authenticatedAt: Date | string | null;
  }>(
    db,
    sql`
      select s.identity_id as "identityId", s.login_binding_id as "loginBindingId",
        s.created_at as "signedInAt",
        s.created_at > clock_timestamp() - make_interval(secs => ${FRESH_SIGN_IN_SECONDS})
          as "signedInRecently",
        latest.amr, latest.authenticated_at as "authenticatedAt"
      from auth_sessions s
      left join lateral (
        select a.amr, a.authenticated_at
        from auth_session_authentications a
        where a.auth_session_id = s.id
        order by a.authenticated_at desc
        limit 1
      ) latest on true
      where s.id = ${session.authSessionId} and s.user_id = ${session.authUserId}
    `,
  );
  if (!row) return null;
  return {
    identityId: row.identityId,
    loginBindingId: row.loginBindingId,
    signedInAt: asDate(row.signedInAt),
    signedInRecently: row.signedInRecently,
    latestReauthentication:
      row.amr && row.authenticatedAt
        ? { amr: row.amr, authenticatedAt: asDate(row.authenticatedAt) }
        : null,
  };
}

/**
 * Append one successful re-authentication of a session and return when it
 * happened. `authenticatedAt` defaults to the database clock.
 */
export async function recordSessionAuthentication(
  db: Pick<Database, "execute">,
  input: { authSessionId: string; amr: AuthenticationMethod[]; authenticatedAt?: Date },
): Promise<Date> {
  const amr = `{${input.amr.join(",")}}`;
  const [row] = await rows<{ authenticatedAt: Date | string }>(
    db,
    input.authenticatedAt
      ? sql`
          insert into auth_session_authentications (auth_session_id, amr, authenticated_at)
          values (${input.authSessionId}, ${amr}::text[], ${input.authenticatedAt.toISOString()}::timestamptz)
          returning authenticated_at as "authenticatedAt"
        `
      : sql`
          insert into auth_session_authentications (auth_session_id, amr)
          values (${input.authSessionId}, ${amr}::text[])
          returning authenticated_at as "authenticatedAt"
        `,
  );
  if (!row) throw new Error("session authentication was not recorded");
  return asDate(row.authenticatedAt);
}

/** The person's password hash, when they have an email-and-password sign-in. */
export async function readCredentialPasswordHash(
  db: Pick<Database, "execute">,
  authUserId: string,
): Promise<string | null> {
  const [row] = await rows<{ password: string | null }>(
    db,
    sql`
      select password from auth_identities
      where user_id = ${authUserId} and provider_id = 'credential' and password is not null
      limit 1
    `,
  );
  return row?.password ?? null;
}

export type TotpFactor = { id: string; verified: boolean; encryptedSecret: string };

/** The person's TOTP factor of Better Auth's twoFactor plugin, enrolled or pending. */
export async function readTotpFactor(
  db: Pick<Database, "execute">,
  authUserId: string,
): Promise<TotpFactor | null> {
  const [row] = await rows<{ id: string; verified: boolean; secret: string }>(
    db,
    sql`select id, verified, secret from auth_two_factors where user_id = ${authUserId}`,
  );
  return row ? { id: row.id, verified: row.verified, encryptedSecret: row.secret } : null;
}

/** The plugin's TOTP parameters (its defaults): six digits every 30 seconds. */
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
/** Accepted clock drift, in time steps, either side (the plugin's default). */
const TOTP_WINDOW = 1;

/**
 * Accept a TOTP code at most once. The code is checked against the plugin's
 * encrypted secret for the current time step and one step either side, and
 * the matched step is claimed atomically: a step at or before the last
 * accepted one is refused, so a code observed in use cannot be replayed.
 */
export async function consumeTotpCode(
  db: Pick<Database, "execute">,
  auth: ManagedAuth,
  factor: TotpFactor,
  code: string,
): Promise<boolean> {
  if (!/^\d{6}$/u.test(code)) return false;
  const context = await auth.$context;
  const secret = await symmetricDecrypt({
    key: context.secretConfig,
    data: factor.encryptedSecret,
  });
  const otp = createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS });
  const current = Math.floor(Date.now() / (TOTP_PERIOD_SECONDS * 1000));
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (constantTimeEqual(await otp.hotp(step), code)) matched = step;
  }
  if (matched === null) return false;
  const claimed = await rows<{ id: string }>(
    db,
    sql`
      update auth_two_factors set last_used_counter = ${matched}
      where id = ${factor.id} and secret = ${factor.encryptedSecret}
        and (last_used_counter is null or last_used_counter < ${matched})
      returning id
    `,
  );
  return claimed.length === 1;
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < right.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
