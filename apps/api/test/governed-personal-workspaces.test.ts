import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { OrganizationGovernancePort } from "@opengeni/contracts/organization-governance";
import type {
  AppDependencies,
  ManagedEmailDeliveryResult,
  ManagedEmailMessage,
} from "@opengeni/core";
import {
  createAdditionalManagedOrganization,
  createDb,
  createManagedOrganization,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getOrganizationPrivacyPreferences,
  personalWorkspaceClosedToNewWork,
  type DbClient,
} from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * A host-governed organization gives its people no Personal workspace to see
 * or work in: the fork turns upstream's `personal_workspaces_enabled` (0918)
 * off when it learns the organization is governed (native creation, and every
 * host command before it runs), so a member lands in the business workspace.
 * Owners cannot turn it back on natively. Ungoverned organizations, and every
 * organization without a bound port, are unchanged.
 */

const origin = "http://opengeni.test";
const delegationSecret = "governed-personal-workspaces-delegation-secret-32";
const HOST_SOURCE = "test-host:tenant";
const actingExternalUser = { source: "test-host:user", externalId: "staff-7" };

let shared: SharedTestDatabase;
let client: DbClient;
const managedEmailTransport = {
  sender: "Opengeni <auth@mail.opengeni.ai>",
  idempotency: { scope: "test-provider-v1:governed-personal", retentionSeconds: 86_400 },
  send: async (_message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult> => ({
    status: "sent",
    providerMessageId: `message-${crypto.randomUUID()}`,
  }),
};

const hostPort: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: ({ via }) => (via === "host" ? "allow" : "refuse"),
};
const governsEveryOrganization: OrganizationGovernancePort = {
  governs: () => true,
  decide: ({ via }) => (via === "host" ? "allow" : "refuse"),
};

type App = ReturnType<typeof createApp>;
type Person = { cookie: string; email: string; userId: string; subjectId: string };

function appFor(organizationGovernance?: OrganizationGovernancePort): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "governed-personal-workspaces-secret-32-bytes",
      publicBaseUrl: origin,
      delegationSecret,
      organizationUserSetupEmailTokenTransport: "query",
      organizationUserSetupQueryEdgeSanitizationConfirmed: true,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    managedEmailTransport,
    ...(organizationGovernance ? { organizationGovernance } : {}),
  } as AppDependencies);
}

let stockApp: App;
let governedApp: App;
let owner: Person;

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

async function signUp(app: App, name: string, email = `${crypto.randomUUID()}@example.test`) {
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password: "password1234" }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const response = await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", rememberMe: true }),
  });
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Better Auth response did not set a session cookie");
  const [user] = await shared.admin<{ id: string }[]>`
    select id from auth_users where email = ${email}`;
  return {
    cookie: cookie.split(";", 1)[0]!,
    email,
    userId: user!.id,
    subjectId: `user:${user!.id}`,
  } satisfies Person;
}

/** An organization the host provisions out of band and marks with its source. */
async function hostOrganization(source: string | null) {
  const created = await createAdditionalManagedOrganization(client.db, {
    subjectId: owner.subjectId,
    subjectLabel: owner.email,
    name: "Business organization",
    workspaceName: "Business workspace",
    operationId: crypto.randomUUID(),
  });
  if (source)
    await shared.admin`
      update managed_accounts set external_source = ${source}, external_id = ${crypto.randomUUID()}
      where id = ${created.organization.id}`;
  return { organizationId: created.organization.id, businessWorkspaceId: created.workspaceId };
}

async function personalWorkspacesEnabled(organizationId: string): Promise<boolean> {
  return (await getOrganizationPrivacyPreferences(client.db, organizationId))
    .personalWorkspacesEnabled;
}

function inviteCommand(email: string, workspaceId: string) {
  return {
    email,
    role: "member",
    initialWorkspaceIds: [workspaceId],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operationId: crypto.randomUUID(),
  };
}

async function hostInvite(organizationId: string, workspaceId: string, email: string) {
  const token = await signDelegatedAccessToken(delegationSecret, {
    accountId: organizationId,
    workspaceId,
    subjectId: owner.subjectId,
    permissions: ["members:manage"],
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: "test-host:governance" },
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  return await governedApp.request(`/v1/host/organizations/${organizationId}/invitations`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ actingExternalUser, command: inviteCommand(email, workspaceId) }),
  });
}

/** The invitee signs up after the invitation, then accepts it. */
async function acceptAsNewMember(app: App, email: string): Promise<Person> {
  const member = await signUp(app, "Business member", email);
  const listed = await app.request("/v1/organization-invitations", {
    headers: browser(member.cookie),
  });
  expect(listed.status).toBe(200);
  const [invitation] = (
    (await listed.json()) as { invitations: { id: string; revision: number }[] }
  ).invitations;
  if (!invitation) throw new Error("the invitation was not bound to the new member");
  const accepted = await app.request(`/v1/organization-invitations/${invitation.id}/accept`, {
    method: "POST",
    headers: browser(member.cookie),
    body: JSON.stringify({
      expectedRevision: invitation.revision,
      operationId: crypto.randomUUID(),
    }),
  });
  expect(accepted.status).toBe(200);
  return member;
}

async function memberAccess(app: App, member: Person, organizationId: string) {
  const memberships = await app.request("/v1/organization-memberships", {
    headers: browser(member.cookie),
  });
  expect(memberships.status).toBe(200);
  const listed = (
    (await memberships.json()) as {
      memberships: {
        organizationId: string;
        personalWorkspaceId: string | null;
        personalWorkspacesEnabled: boolean;
      }[];
    }
  ).memberships;
  expect(listed.map((membership) => membership.organizationId)).toEqual([organizationId]);
  const access = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId: member.userId,
    email: member.email,
    name: "Business member",
    emailVerified: true,
    provisionFallbackOrganization: false,
  });
  return { membership: listed[0]!, defaultWorkspaceId: access.accessContext.defaultWorkspaceId };
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("governed-personal-workspaces");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  stockApp = appFor();
  governedApp = appFor(hostPort);
  owner = await signUp(stockApp, "Business owner");
  await createManagedOrganization(client.db, {
    subjectId: owner.subjectId,
    subjectLabel: owner.email,
    name: "Owner's first organization",
    operationId: crypto.randomUUID(),
  });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("organization creation", () => {
  test("a governed organization is created with Personal workspaces off", async () => {
    const created = await appFor(governsEveryOrganization).request("/v1/organizations/additional", {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify({
        name: "Governed at creation",
        workspaceName: "Business workspace",
        operationId: crypto.randomUUID(),
      }),
    });
    expect(created.status).toBe(201);
    const { organization } = (await created.json()) as { organization: { id: string } };
    expect(await personalWorkspacesEnabled(organization.id)).toBe(false);
  }, 60_000);

  test("stock: without a port a new organization keeps Personal workspaces on", async () => {
    const created = await stockApp.request("/v1/organizations/additional", {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify({
        name: "Stock organization",
        workspaceName: "Shared workspace",
        operationId: crypto.randomUUID(),
      }),
    });
    expect(created.status).toBe(201);
    const { organization } = (await created.json()) as { organization: { id: string } };
    expect(await personalWorkspacesEnabled(organization.id)).toBe(true);
  }, 60_000);
});

describe("members of a host-provisioned organization", () => {
  test("a governed organization's member gets no Personal workspace and lands in the business one", async () => {
    const { organizationId, businessWorkspaceId } = await hostOrganization(HOST_SOURCE);
    // Provisioned out of band: the fork has not seen it yet.
    expect(await personalWorkspacesEnabled(organizationId)).toBe(true);
    const email = `member-${crypto.randomUUID()}@example.test`;
    const invited = await hostInvite(organizationId, businessWorkspaceId, email);
    expect(invited.status).toBe(201);
    expect(await personalWorkspacesEnabled(organizationId)).toBe(false);

    const member = await acceptAsNewMember(governedApp, email);
    const { membership, defaultWorkspaceId } = await memberAccess(
      governedApp,
      member,
      organizationId,
    );
    expect(membership.personalWorkspacesEnabled).toBe(false);
    expect(defaultWorkspaceId).toBe(businessWorkspaceId);
    // Upstream keeps the row as an anchor for the person's own machines; it
    // is hidden and closed to new chats and schedules.
    expect(
      await personalWorkspaceClosedToNewWork(client.db, {
        accountId: organizationId,
        workspaceId: membership.personalWorkspaceId!,
      }),
    ).toBe(true);
    expect(
      await personalWorkspaceClosedToNewWork(client.db, {
        accountId: organizationId,
        workspaceId: businessWorkspaceId,
      }),
    ).toBe(false);
  }, 120_000);

  test("an ungoverned organization is unchanged", async () => {
    const { organizationId, businessWorkspaceId } = await hostOrganization(null);
    const email = `member-${crypto.randomUUID()}@example.test`;
    const invited = await governedApp.request(`/v1/organizations/${organizationId}/invitations`, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify(inviteCommand(email, businessWorkspaceId)),
    });
    expect(invited.status).toBe(201);
    expect(await personalWorkspacesEnabled(organizationId)).toBe(true);

    const member = await acceptAsNewMember(governedApp, email);
    const { membership, defaultWorkspaceId } = await memberAccess(
      governedApp,
      member,
      organizationId,
    );
    expect(membership.personalWorkspacesEnabled).toBe(true);
    expect(membership.personalWorkspaceId).not.toBeNull();
    expect(defaultWorkspaceId).toBe(membership.personalWorkspaceId);
    expect(await personalWorkspacesEnabled(organizationId)).toBe(true);
  }, 120_000);
});

describe("the privacy setting", () => {
  async function setPersonalWorkspaces(app: App, organizationId: string, enabled: boolean) {
    return await app.request(`/v1/organizations/${organizationId}/privacy-settings`, {
      method: "PATCH",
      headers: browser(owner.cookie),
      body: JSON.stringify({ personalWorkspaces: enabled }),
    });
  }

  test("a governed organization's owner cannot turn Personal workspaces back on", async () => {
    const { organizationId, businessWorkspaceId } = await hostOrganization(HOST_SOURCE);
    expect(
      (
        await hostInvite(
          organizationId,
          businessWorkspaceId,
          `x-${crypto.randomUUID()}@example.test`,
        )
      ).status,
    ).toBe(201);
    const refused = await setPersonalWorkspaces(governedApp, organizationId, true);
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: { details?: { code?: string } } };
    expect(body.error.details?.code).toBe("ORGANIZATION_GOVERNED_BY_HOST");
    expect(await personalWorkspacesEnabled(organizationId)).toBe(false);
    // Keeping it off is still accepted.
    expect((await setPersonalWorkspaces(governedApp, organizationId, false)).status).toBe(200);
  }, 60_000);

  test("an ungoverned organization's owner still turns it off and on", async () => {
    const { organizationId } = await hostOrganization(null);
    expect((await setPersonalWorkspaces(governedApp, organizationId, false)).status).toBe(200);
    expect(await personalWorkspacesEnabled(organizationId)).toBe(false);
    expect((await setPersonalWorkspaces(governedApp, organizationId, true)).status).toBe(200);
    expect(await personalWorkspacesEnabled(organizationId)).toBe(true);
  }, 60_000);
});
