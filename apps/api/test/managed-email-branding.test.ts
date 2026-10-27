import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getSettings, type Settings } from "@opengeni/config";
import type { ManagedEmailMessage, ManagedEmailTransport } from "@opengeni/core";
import { createDb, type DbClient } from "@opengeni/db";
import {
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import {
  createManagedAuth,
  hashManagedAuthPassword as hashPassword,
} from "../src/auth/managed-auth";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";
import { resolveOrganizationUserSetupDeliveryEmail } from "../src/auth/organization-user-setup";

/*
 * The four auth emails (verification, password reset, invitation and
 * sign-in-method changed) name the deployment's product. Unset, the product is
 * "Opengeni" and every message equals the stock one; `OPENGENI_PRODUCT_NAME`
 * replaces it everywhere, and the sender stays `OPENGENI_EMAIL_FROM`.
 */

const origin = "http://opengeni.test";
const password = "branding-password-123";
const BRAND = "Hostbrand";
const BRAND_SENDER = "Hostbrand <auth@mail.hostbrand.test>";

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("managed-email-branding");
  if (!acquired) throw new Error("Managed email branding tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Runtime = ReturnType<typeof runtime>;

function runtime(overrides: Partial<Settings> = {}) {
  const messages: ManagedEmailMessage[] = [];
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "managed",
    publicBaseUrl: origin,
    betterAuthSecret: "managed-email-branding-secret-at-least-32-bytes",
    managedAuthRequireEmailVerification: true,
    ...overrides,
  });
  const transport: ManagedEmailTransport = {
    sender: settings.emailFrom,
    idempotency: { scope: "test:managed-email-branding", retentionSeconds: 86_400 },
    send: async (message) => {
      messages.push(structuredClone(message));
      return { status: "sent", providerMessageId: null };
    },
  };
  const auth = createManagedAuth(settings, client.db, transport)!;
  const adapter = createBetterAuthSessionAdapter(auth, client.db);
  const app = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    managedAuthSessionAdapter: adapter,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  return { settings, app, adapter, transport, messages };
}

const json = { "content-type": "application/json" };
const browser = { origin, "sec-fetch-site": "same-origin", ...json };

function only(rt: Runtime, kind: ManagedEmailMessage["kind"], to: string): ManagedEmailMessage {
  const found = rt.messages.filter((message) => message.kind === kind && message.to === to);
  expect(found).toHaveLength(1);
  return found[0]!;
}

async function verificationEmail(rt: Runtime): Promise<ManagedEmailMessage> {
  const email = `branding-${crypto.randomUUID()}@example.test`;
  const signUp = await rt.app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Branding Human", email, password }),
  });
  expect(signUp.status).toBe(200);
  return only(rt, "email_verification", email);
}

async function resetEmail(rt: Runtime): Promise<ManagedEmailMessage> {
  const email = `branding-reset-${crypto.randomUUID()}@example.test`;
  await rt.app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Branding Reset", email, password }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const reset = await rt.app.request("/v1/auth/request-password-reset", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email, redirectTo: `${origin}/reset-password` }),
  });
  expect(reset.status).toBe(200);
  return only(rt, "password_reset", email);
}

async function invitationEmail(rt: Runtime) {
  const { message } = await resolveOrganizationUserSetupDeliveryEmail(
    { ...rt.settings, organizationUserSetupEmailTokenTransport: "query" },
    {
      invitationId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      senderEmail: rt.transport.sender,
      recipientEmail: "invited@example.test",
      recipientName: null,
      organizationName: "Acme",
      organizationRole: "member",
      sharedWorkspaceAccess: [],
      providerIdempotencyScope: rt.transport.idempotency.scope,
      frozenTransport: null,
      frozenPayloadDigest: null,
    },
  );
  return message;
}

/** A password human with a fresh session, as the sign-in-methods suite seeds one. */
async function passwordHuman(rt: Runtime) {
  const userId = crypto.randomUUID();
  const email = `${userId}@example.test`;
  await shared.admin`
    insert into auth_users(id, name, email, email_verified)
    values (${userId}, 'Branding Human', ${email}, true)`;
  await shared.admin`
    insert into auth_identities(id, user_id, provider_id, account_id, password, created_at, updated_at)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId}, ${await hashPassword(password)}, now(), now())`;
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = projection.loginBindings.find(
    (candidate) => candidate.providerId === "credential" && candidate.status === "active",
  )!;
  const sessionId = crypto.randomUUID();
  const token = crypto.randomUUID();
  await shared.admin`
    insert into auth_sessions(id, user_id, token, expires_at, identity_id, identity_revision,
      auth_revision, login_binding_id, login_binding_revision)
    values (${sessionId}, ${userId}, ${token}, now() + interval '1 hour',
      ${projection.activeIdentity.id}, ${projection.activeIdentity.identityRevision},
      ${projection.activeIdentity.authRevision}, ${binding.id}, ${binding.revision})`;
  await shared.admin`
    insert into auth_session_authentications(auth_session_id, amr)
    values (${sessionId}, ${"{pwd}"}::text[])`;
  const cookie = (await rt.adapter.createLegacySelectedSessionCookies({ token } as never, null))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return { email, cookie, identity: projection.activeIdentity };
}

async function signInMethodChangedEmail(rt: Runtime): Promise<ManagedEmailMessage> {
  const human = await passwordHuman(rt);
  const changed = await rt.app.request("/v1/auth/sign-in-methods/password", {
    method: "POST",
    headers: { ...browser, cookie: human.cookie },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      expectedIdentityId: human.identity.id,
      expectedIdentityRevision: human.identity.identityRevision,
      currentPassword: password,
      newPassword: "branding-password-456",
    }),
  });
  expect(changed.status).toBe(200);
  expect(((await changed.json()) as { notification: string }).notification).toBe("sent");
  return only(rt, "sign_in_method_changed", human.email);
}

function bodies(message: { subject: string; text: string; html: string }): string[] {
  return [message.subject, message.text, message.html];
}

describe("product name setting", () => {
  test("defaults to Opengeni and refuses header-breaking names", () => {
    expect(getSettings({}).productName).toBe("Opengeni");
    // An empty variable is unset, as for every other setting.
    expect(getSettings({ OPENGENI_PRODUCT_NAME: " " }).productName).toBe("Opengeni");
    expect(getSettings({ OPENGENI_PRODUCT_NAME: ` ${BRAND} ` }).productName).toBe(BRAND);
    for (const name of ["Host\r\nBcc: someone@example.test", "Host\nbrand", "x".repeat(81)]) {
      expect(() => getSettings({ OPENGENI_PRODUCT_NAME: name })).toThrow();
    }
  });
});

describe("stock auth emails (OPENGENI_PRODUCT_NAME unset)", () => {
  test("verification, reset, invitation and sign-in-method changed equal today's", async () => {
    const rt = runtime();
    expect(rt.settings.productName).toBe("Opengeni");

    const verification = await verificationEmail(rt);
    expect(verification.from).toBe("Opengeni <auth@mail.opengeni.ai>");
    expect(verification.subject).toBe("Verify your Opengeni email");
    expect(verification.text).toStartWith("Verify your Opengeni email: http");
    expect(verification.text).toEndWith(
      "\n\nIf you did not create an Opengeni account, ignore this email.",
    );
    expect(verification.html).toStartWith("<p>Verify your Opengeni email:</p>");

    const reset = await resetEmail(rt);
    expect(reset.subject).toBe("Reset your Opengeni password");
    expect(reset.text).toStartWith("Reset your Opengeni password: http");
    expect(reset.html).toStartWith("<p>Reset your Opengeni password:</p>");

    const invitation = await invitationEmail(rt);
    expect(invitation.subject).toBe("You're invited to join Acme on Opengeni");
    expect(invitation.text).toContain("You've been invited to join Acme on Opengeni as Member.");
    expect(invitation.text).toContain(
      "Already use Opengeni? Open this invitation and choose Sign in as invited@example.test. Opengeni will show the invitation immediately after you sign in.",
    );

    const changed = await signInMethodChangedEmail(rt);
    expect(changed.subject).toBe("Your Opengeni sign-in methods changed");
    expect(changed.text).toBe(
      "Your Opengeni password sign-in method changed. If this was not you, reset your password and contact your administrator.",
    );
    expect(changed.html).toBe(
      "<p>Your Opengeni password sign-in method changed. If this was not you, reset your password and contact your administrator.</p>",
    );
  });
});

describe("branded auth emails (OPENGENI_PRODUCT_NAME set)", () => {
  test("every auth email names the product, never Opengeni, from the configured sender", async () => {
    const rt = runtime({ productName: BRAND, emailFrom: BRAND_SENDER });
    const messages = [
      await verificationEmail(rt),
      await resetEmail(rt),
      { kind: "organization_user_setup" as const, ...(await invitationEmail(rt)) },
      await signInMethodChangedEmail(rt),
    ];
    expect(messages.map((message) => message.subject)).toEqual([
      `Verify your ${BRAND} email`,
      `Reset your ${BRAND} password`,
      `You're invited to join Acme on ${BRAND}`,
      `Your ${BRAND} sign-in methods changed`,
    ]);
    for (const message of messages) {
      expect(message.from).toBe(BRAND_SENDER);
      for (const part of bodies(message)) {
        expect(part).toContain(BRAND);
        expect(part).not.toContain("Opengeni");
      }
    }
  });

  test("the product name is escaped in HTML bodies", async () => {
    const rt = runtime({ productName: "R&D <Desk>" });
    const invitation = await invitationEmail(rt);
    expect(invitation.subject).toBe("You're invited to join Acme on R&D <Desk>");
    expect(invitation.html).toContain("on R&amp;D &lt;Desk&gt; as Member");
    expect(invitation.html).not.toContain("<Desk>");
    const reset = await resetEmail(rt);
    expect(reset.html).toStartWith("<p>Reset your R&amp;D &lt;Desk&gt; password:</p>");
  });

  test("the authenticator app issuer is the product name", async () => {
    const rt = runtime({ productName: BRAND, managedAuthTotpEnabled: true });
    const human = await passwordHuman(rt);
    const enroll = await rt.app.request("/v1/auth/totp/enroll", {
      method: "POST",
      headers: { ...browser, cookie: human.cookie },
      body: JSON.stringify({ password }),
    });
    expect(enroll.status).toBe(200);
    const { totpURI } = (await enroll.json()) as { totpURI: string };
    expect(totpURI).toStartWith(`otpauth://totp/${BRAND}:`);
    expect(new URL(totpURI).searchParams.get("issuer")).toBe(BRAND);
  });
});
