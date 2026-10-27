import type { Database } from "@opengeni/db";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { sql, type SQL } from "drizzle-orm";

import type { ManagedAuth } from "@opengeni/core";

/**
 * How and when a managed browser session last authenticated. Every
 * authentication is one `auth_session_authentications` row:
 *
 * - the email-and-password or Google/GitHub sign-in that created the session
 *   (written by the session-create hook, at the session's creation time);
 * - each successful `POST /v1/auth/reauthenticate`;
 * - for a session created from another one (a native app device approved by a
 *   browser), a copy of the approving session's latest authentication.
 *
 * A session's creation time is never authentication evidence: a session with no
 * row has not authenticated, and is never fresh. Better Auth's sliding renewal
 * writes no row, so a refreshed session keeps its authentication time.
 */

/** RFC 8176 authentication method references this product issues. */
export type AuthenticationMethod = "pwd" | "oauth" | "otp";

/** An authentication at most this old is fresh. */
export const FRESH_AUTHENTICATION_SECONDS = 300;

/** The managed social providers whose callback signs a person in. */
const OAUTH_PROVIDERS: ReadonlySet<string> = new Set(["google", "github"]);

/**
 * The method a Better Auth endpoint authenticated with when it created a
 * session, or null when the endpoint is not a sign-in (email verification
 * links, server-side session creation without an endpoint, plugin routes).
 */
export function signInAuthenticationMethod(
  endpointPath: string | undefined,
  providerId: string | undefined,
): "pwd" | "oauth" | null {
  if (endpointPath === "/sign-in/email" || endpointPath === "/sign-up/email") return "pwd";
  if (endpointPath === "/callback/:id" && providerId && OAUTH_PROVIDERS.has(providerId)) {
    return "oauth";
  }
  return null;
}

export type SessionAuthentication = {
  amr: AuthenticationMethod[];
  authenticatedAt: Date;
  /** At most {@link FRESH_AUTHENTICATION_SECONDS} old, by the database clock. */
  recent: boolean;
};

export type SessionAuthenticationRecord = {
  identityId: string | null;
  /** The session's latest authentication, or null when it never authenticated. */
  latest: SessionAuthentication | null;
};

async function rows<T>(db: Pick<Database, "execute">, query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The session's identity and latest authentication; null when the session is gone. */
export async function readSessionAuthentication(
  db: Pick<Database, "execute">,
  session: { authUserId: string; authSessionId: string },
): Promise<SessionAuthenticationRecord | null> {
  const [row] = await rows<{
    identityId: string | null;
    amr: AuthenticationMethod[] | null;
    authenticatedAt: Date | string | null;
    recent: boolean | null;
  }>(
    db,
    sql`
      select s.identity_id as "identityId", latest.amr,
        latest.authenticated_at as "authenticatedAt",
        latest.authenticated_at > clock_timestamp() - make_interval(secs => ${FRESH_AUTHENTICATION_SECONDS})
          as "recent"
      from auth_sessions s
      left join lateral (
        select a.amr, a.authenticated_at
        from auth_session_authentications a
        where a.auth_session_id = s.id
        order by a.authenticated_at desc, a.recorded_at desc
        limit 1
      ) latest on true
      where s.id = ${session.authSessionId} and s.user_id = ${session.authUserId}
    `,
  );
  if (!row) return null;
  return {
    identityId: row.identityId,
    latest:
      row.amr && row.amr.length > 0 && row.authenticatedAt
        ? {
            amr: row.amr,
            authenticatedAt: asDate(row.authenticatedAt),
            recent: row.recent === true,
          }
        : null,
  };
}

/**
 * Append one authentication of a session and return its time.
 * `authenticatedAt` defaults to the database clock.
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

export type TotpFactor = {
  id: string;
  verified: boolean;
  encryptedSecret: string;
  /** When the factor stays locked after repeated wrong codes, if it is locked now. */
  lockedUntil: Date | null;
};

/** The person's TOTP factor of Better Auth's twoFactor plugin, enrolled or pending. */
export async function readTotpFactor(
  db: Pick<Database, "execute">,
  authUserId: string,
): Promise<TotpFactor | null> {
  const [row] = await rows<{
    id: string;
    verified: boolean;
    secret: string;
    lockedUntil: Date | string | null;
  }>(
    db,
    sql`
      select id, verified, secret,
        case when locked_until > clock_timestamp() then locked_until end as "lockedUntil"
      from auth_two_factors where user_id = ${authUserId}
    `,
  );
  return row
    ? {
        id: row.id,
        verified: row.verified,
        encryptedSecret: row.secret,
        lockedUntil: row.lockedUntil ? asDate(row.lockedUntil) : null,
      }
    : null;
}

/** The plugin's TOTP parameters (its defaults): six digits every 30 seconds. */
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
/** Accepted clock drift, in time steps, either side (the plugin's default). */
const TOTP_WINDOW = 1;
/**
 * The plugin's account lockout defaults: ten consecutive wrong codes lock the
 * factor for fifteen minutes. The plugin enforces them only on its own sign-in
 * challenge, so the product checks enforce them here.
 */
export const TOTP_MAX_FAILED_ATTEMPTS = 10;
export const TOTP_LOCK_SECONDS = 15 * 60;

export type TotpCodeOutcome =
  | { kind: "accepted" }
  | { kind: "invalid" }
  | { kind: "locked"; retryAfterSeconds: number };

function lockedOutcome(lockedUntil: Date): TotpCodeOutcome {
  return {
    kind: "locked",
    retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000)),
  };
}

/**
 * Check a TOTP code and accept it at most once.
 *
 * A locked factor is refused before the code is looked at, and no time step is
 * spent. Otherwise the code is checked against the plugin's encrypted secret
 * for the current time step and one step either side; the matched step is
 * claimed atomically (a step at or before the last accepted one is refused, so
 * a code observed in use cannot be replayed), and the failure count is reset.
 * A wrong or replayed code counts one failure, and the
 * {@link TOTP_MAX_FAILED_ATTEMPTS}th in a row locks the factor for
 * {@link TOTP_LOCK_SECONDS}.
 */
export async function consumeTotpCode(
  db: Pick<Database, "execute">,
  auth: ManagedAuth,
  factor: TotpFactor,
  code: string,
): Promise<TotpCodeOutcome> {
  if (factor.lockedUntil) return lockedOutcome(factor.lockedUntil);
  const matched = /^\d{6}$/u.test(code) ? await matchingTimeStep(auth, factor, code) : null;
  if (matched !== null) {
    const claimed = await rows<{ id: string }>(
      db,
      sql`
        update auth_two_factors
        set last_used_counter = ${matched}, failed_verification_count = 0, locked_until = null
        where id = ${factor.id} and secret = ${factor.encryptedSecret}
          and (locked_until is null or locked_until <= clock_timestamp())
          and (last_used_counter is null or last_used_counter < ${matched})
        returning id
      `,
    );
    if (claimed.length === 1) return { kind: "accepted" };
  }
  const [failed] = await rows<{ lockedUntil: Date | string | null }>(
    db,
    sql`
      update auth_two_factors
      set failed_verification_count = case
            when locked_until > clock_timestamp() then failed_verification_count
            else failed_verification_count + 1
          end,
        locked_until = case
          when locked_until > clock_timestamp() then locked_until
          when failed_verification_count + 1 >= ${TOTP_MAX_FAILED_ATTEMPTS}
            then clock_timestamp() + make_interval(secs => ${TOTP_LOCK_SECONDS})
          else locked_until
        end
      where id = ${factor.id}
      returning case when locked_until > clock_timestamp() then locked_until end as "lockedUntil"
    `,
  );
  // A concurrent attempt may have locked the factor between the read and this
  // write: a right code is then refused as locked, never accepted.
  if (failed?.lockedUntil && matched !== null) return lockedOutcome(asDate(failed.lockedUntil));
  return { kind: "invalid" };
}

async function matchingTimeStep(
  auth: ManagedAuth,
  factor: TotpFactor,
  code: string,
): Promise<number | null> {
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
  return matched;
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < right.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
