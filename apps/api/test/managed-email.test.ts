import { describe, expect, test } from "bun:test";

import {
  createManagedEmailTransport,
  InMemoryManagedEmailTransport,
} from "../src/auth/managed-email";
import {
  assertManagedEmailTransportMetadata,
  deriveOrganizationUserSetupToken,
  organizationUserSetupPayloadDigest,
  renderOrganizationUserSetupEmail,
  resolveOrganizationUserSetupDeliveryEmail,
} from "../src/auth/organization-user-setup";
import { testSettings } from "@opengeni/testing/settings";

const message = {
  kind: "organization_user_setup" as const,
  from: "Opengeni <invites@example.test>",
  to: "invited@example.test",
  subject: "Invitation",
  text: "Set up with bearer-only-link",
  html: "<p>Set up with bearer-only-link</p>",
  idempotencyKey: "stable-provider-key",
};

describe("managed email transport", () => {
  test("disabled delivery never sends, even where a provider would be selected", async () => {
    const transport = createManagedEmailTransport({
      ...testSettings(),
      environment: "production",
      managedEmailDelivery: "disabled",
    });
    expect(await transport.send(message)).toEqual({
      status: "failed",
      errorClass: "delivery_disabled",
    });
    expect(() => assertManagedEmailTransportMetadata(transport)).not.toThrow();
  });

  test("rejects malformed embedded-provider metadata before durable delivery", () => {
    expect(() =>
      assertManagedEmailTransportMetadata({
        sender: "Opengeni <invites@example.test>",
        idempotency: { scope: "Other Provider", retentionSeconds: 3_600 },
        send: async () => ({ status: "sent", providerMessageId: null }),
      }),
    ).toThrow("idempotency contract");
    expect(() =>
      assertManagedEmailTransportMetadata({
        sender: " Opengeni <invites@example.test>",
        idempotency: { scope: "test-provider-v1:account", retentionSeconds: 3_600.5 },
        send: async () => ({ status: "sent", providerMessageId: null }),
      }),
    ).toThrow("sender");
  });

  test("keeps local captures bounded, TTL-limited, and one-time readable", async () => {
    let now = 0;
    const transport = new InMemoryManagedEmailTransport({
      maxMessages: 2,
      ttlMs: 100,
      now: () => now,
    });
    await transport.send({ ...message, to: "first@example.test" });
    now = 1;
    await transport.send({ ...message, to: "second@example.test" });
    now = 2;
    await transport.send({ ...message, to: "third@example.test" });
    expect(transport.size()).toBe(2);
    expect(transport.take((capture) => capture.to === "first@example.test")).toBeNull();
    expect(transport.take((capture) => capture.to === "second@example.test")).toMatchObject({
      to: "second@example.test",
      idempotencyKey: "stable-provider-key",
    });
    expect(transport.take((capture) => capture.to === "second@example.test")).toBeNull();
    expect(transport.size()).toBe(1);
    now = 102;
    expect(transport.size()).toBe(0);
  });

  test("renders an escaped, frozen safe snapshot with a stable payload digest", async () => {
    const rendered = renderOrganizationUserSetupEmail({
      productName: "Opengeni",
      senderEmail: "Opengeni <invites@example.test>",
      recipientEmail: "invited@example.test",
      recipientName: "Ada <Admin>",
      organizationName: "R&D <Labs>",
      organizationRole: "admin",
      sharedWorkspaceAccess: [
        {
          workspaceId: crypto.randomUUID(),
          workspaceName: "Launch <Ops>",
          role: "viewer",
        },
      ],
      setupUrl: "https://opengeni.test/setup-account?token=secret-bearer",
    });
    // Keep invitation semantics stable without freezing product-name capitalization.
    expect(rendered.subject).toMatch(/^You're invited to join R&D <Labs> on \S+$/);
    expect(rendered.text).toContain("Ada <Admin>");
    expect(rendered.text).toContain("Launch <Ops>: Viewer");
    expect(rendered.text).toContain("never shares anyone's Personal workspace");
    expect(rendered.text).toContain("Accept invitation to R&D <Labs>:");
    expect(rendered.text).toContain("You'll sign in or create an account before joining.");
    expect(rendered.text).toContain("will show the invitation immediately");
    expect(rendered.html).toContain("Ada &lt;Admin&gt;");
    expect(rendered.html).toContain("R&amp;D &lt;Labs&gt;");
    expect(rendered.html).toContain("Launch &lt;Ops&gt;");
    expect(rendered.html).toContain(">Accept invitation to R&amp;D &lt;Labs&gt;</a>");
    expect(rendered.html).toContain("<strong>Sign in as invited@example.test</strong>");
    expect(rendered.html).toContain("show the invitation immediately");
    expect(rendered.html).not.toContain("Ada <Admin>");
    const digestInput = {
      ...rendered,
      providerIdempotencyScope: "test-provider-v1:account-a",
    };
    const first = await organizationUserSetupPayloadDigest(digestInput);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await organizationUserSetupPayloadDigest(digestInput)).toBe(first);
    expect(
      await organizationUserSetupPayloadDigest({
        ...digestInput,
        from: "Opengeni <changed@example.test>",
      }),
    ).not.toBe(first);
    expect(
      await organizationUserSetupPayloadDigest({
        ...digestInput,
        subject: `${rendered.subject}!`,
      }),
    ).not.toBe(first);
    expect(
      await organizationUserSetupPayloadDigest({
        ...digestInput,
        providerIdempotencyScope: "test-provider-v1:account-b",
      }),
    ).not.toBe(first);
  });

  test("freezes transport across cutover and recovers legacy rows from the payload digest", async () => {
    const identity = {
      invitationId: "00000000-0000-4000-8000-000000000001",
      deliveryId: "00000000-0000-4000-8000-000000000002",
      senderEmail: "Opengeni <invites@example.test>",
      recipientEmail: "invited@example.test",
      recipientName: "Invited User",
      organizationName: "Frozen Organization",
      organizationRole: "member" as const,
      sharedWorkspaceAccess: [],
      providerIdempotencyScope: "test-provider-v1:frozen-account",
    };
    const fragmentSettings = testSettings({
      publicBaseUrl: "https://opengeni.test",
      betterAuthSecret: "managed-email-transport-freeze-secret-at-least-32-bytes",
      organizationUserSetupEmailTokenTransport: "fragment",
    });
    const querySettings = testSettings({
      publicBaseUrl: "https://opengeni.test",
      betterAuthSecret: "managed-email-transport-freeze-secret-at-least-32-bytes",
      organizationUserSetupEmailTokenTransport: "query",
      organizationUserSetupQueryEdgeSanitizationConfirmed: true,
    });
    const first = await resolveOrganizationUserSetupDeliveryEmail(fragmentSettings, {
      ...identity,
      frozenTransport: null,
      frozenPayloadDigest: null,
    });
    expect(first.transport).toBe("fragment");
    expect(first.message.text).toContain("/setup-account#token=");

    const frozenRetry = await resolveOrganizationUserSetupDeliveryEmail(querySettings, {
      ...identity,
      frozenTransport: "fragment",
      frozenPayloadDigest: first.payloadDigest,
    });
    expect(frozenRetry).toEqual(first);

    const legacyRetry = await resolveOrganizationUserSetupDeliveryEmail(querySettings, {
      ...identity,
      frozenTransport: null,
      frozenPayloadDigest: first.payloadDigest,
    });
    expect(legacyRetry).toEqual(first);
    await expect(
      resolveOrganizationUserSetupDeliveryEmail(querySettings, {
        ...identity,
        frozenTransport: null,
        frozenPayloadDigest: "f".repeat(64),
      }),
    ).rejects.toThrow("does not match its frozen payload");
  });
});


test("split-origin setup email opens the configured console and preserves the canonical bearer", async () => {
  const settings = testSettings({ publicBaseUrl: "https://api.example.test", webBaseUrl: "https://console.example.test",
    betterAuthSecret: "synthetic-managed-auth-secret-at-least-32-bytes" });
  const input = { invitationId: crypto.randomUUID(), deliveryId: crypto.randomUUID() };
  const split = await deriveOrganizationUserSetupToken(settings, input);
  const same = await deriveOrganizationUserSetupToken({ ...settings, webBaseUrl: undefined }, input);
  expect(new URL(split.url).origin).toBe("https://console.example.test");
  expect(new URL(split.url).pathname).toBe("/setup-account");
  expect(split.token).toBe(same.token);
  expect(split.digest).toBe(same.digest);
  expect(new URL(split.url).hash).toBe(new URL(same.url).hash);
});

test("split-origin verification keeps the API endpoint and accepts only a trusted console callback", async () => {
  const { verificationUrl, verificationUrlForConsole } = await import("../src/auth/managed-auth");
  const settings = testSettings({ publicBaseUrl: "https://api.example.test", webBaseUrl: "https://console.example.test",
    consoleAllowedOrigins: "https://console.example.test", betterAuthSecret: "synthetic-managed-auth-secret-at-least-32-bytes" });
  const url = new URL(await verificationUrl(settings, "fixture@example.invalid"));
  expect(url.origin).toBe("https://api.example.test");
  expect(url.pathname).toBe("/v1/auth/verify-email");
  expect(url.searchParams.get("callbackURL")).toBe("https://console.example.test/");
  expect(url.searchParams.get("token")).toBeTruthy();
  const generated = "https://api.example.test/v1/auth/verify-email?token=synthetic-test-token&callbackURL=%2F";
  const legacy = new URL(verificationUrlForConsole(settings, generated));
  expect(legacy.origin + legacy.pathname).toBe("https://api.example.test/v1/auth/verify-email");
  expect(legacy.searchParams.get("token")).toBe("synthetic-test-token");
  expect(legacy.searchParams.get("callbackURL")).toBe("https://console.example.test/");
  expect(verificationUrlForConsole({ ...settings, webBaseUrl: undefined }, generated)).toBe(generated);
  const explicit = new URL(generated);
  explicit.searchParams.set("callbackURL", "https://console.example.test/workspaces");
  expect(verificationUrlForConsole(settings, explicit.toString())).toBe(explicit.toString());
  await expect(verificationUrl({ ...settings, webBaseUrl: "https://untrusted.example.test" }, "fixture@example.invalid")).rejects.toThrow("trusted");
});

test("split-origin verification returns signup root markers to the console", async () => {
  const { verificationUrlForConsole } = await import("../src/auth/managed-auth");
  const settings = testSettings({
    publicBaseUrl: "https://api.example.test",
    webBaseUrl: "https://console.example.test",
    consoleAllowedOrigins: "https://console.example.test",
  });
  for (const callback of [
    "/?auth_event=email_verified",
    "/?utm_source=fixture&auth_event=email_verified#return",
    "https://api.example.test/?auth_event=email_verified",
  ]) {
    const original = new URL("https://api.example.test/v1/auth/verify-email");
    original.searchParams.set("token", "synthetic-verification-fixture");
    original.searchParams.set("callbackURL", callback);
    const delivered = new URL(verificationUrlForConsole(settings, original.toString()));
    expect(delivered.origin).toBe(original.origin);
    expect(delivered.pathname).toBe(original.pathname);
    expect(delivered.searchParams.get("token")).toBe(original.searchParams.get("token"));
    const expected = new URL(callback, settings.publicBaseUrl);
    expected.host = "console.example.test";
    expect(delivered.searchParams.get("callbackURL")).toBe(expected.toString());
  }
});


test("verification callback rewriting preserves explicit destinations and trust refusal", async () => {
  const { verificationUrlForConsole } = await import("../src/auth/managed-auth");
  const settings = testSettings({
    publicBaseUrl: "https://api.example.test",
    webBaseUrl: "https://console.example.test",
    consoleAllowedOrigins: "https://console.example.test",
  });
  for (const callback of [
    "https://console.example.test/workspaces?auth_event=email_verified",
    "/connect-agent?auth_event=email_verified",
    "//other.example.test/?auth_event=email_verified",
    "https://other.example.test/?auth_event=email_verified",
    "https://fixture:fixture@api.example.test/",
    "javascript:fixture()",
    "https://[invalid",
  ]) {
    const original = new URL("https://api.example.test/v1/auth/verify-email");
    original.searchParams.set("token", "synthetic-verification-fixture");
    original.searchParams.set("callbackURL", callback);
    expect(verificationUrlForConsole(settings, original.toString())).toBe(original.toString());
  }
  const original = new URL("https://api.example.test/v1/auth/verify-email");
  original.searchParams.set("callbackURL", "/?auth_event=email_verified");
  expect(() => verificationUrlForConsole({
    ...settings, webBaseUrl: "https://other.example.test",
  }, original.toString())).toThrow("trusted");
});
