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
/** A host that also lets owners remove workspace access and reactivate natively. */
const removalAllowedPort: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: ({ via, mutation }) =>
    via === "host" || mutation === "workspace_member.remove" || mutation === "membership.reactivate"
      ? "allow"
      : "refuse",
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

function inviteCommand(email: string, workspaceId: string | null) {
  return {
    email,
    role: "member",
    initialWorkspaceIds: workspaceId ? [workspaceId] : [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operationId: crypto.randomUUID(),
  };
}

async function hostToken(organizationId: string, workspaceId: string): Promise<string> {
  return await signDelegatedAccessToken(delegationSecret, {
    accountId: organizationId,
    workspaceId,
    subjectId: owner.subjectId,
    permissions: ["members:manage"],
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: "test-host:governance" },
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

/** `workspaceId` authenticates the token; `invitedTo` is the invitation's workspace, if any. */
async function hostInvite(
  organizationId: string,
  workspaceId: string,
  email: string,
  invitedTo: string | null = workspaceId,
) {
  return await governedApp.request(`/v1/host/organizations/${organizationId}/invitations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await hostToken(organizationId, workspaceId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ actingExternalUser, command: inviteCommand(email, invitedTo) }),
  });
}

function detailCode(body: unknown): string | undefined {
  return (body as { error?: { details?: { code?: string } } }).error?.details?.code;
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
  await freshOwner();
}, 180_000);

/** Each owner may create a bounded number of organizations; later suites take a new one. */
async function freshOwner(): Promise<void> {
  owner = await signUp(stockApp, "Business owner");
  await createManagedOrganization(client.db, {
    subjectId: owner.subjectId,
    subjectLabel: owner.email,
    name: "Owner's first organization",
    operationId: crypto.randomUUID(),
  });
}

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

describe("a governed member always keeps a shared workspace", () => {
  async function invitationCount(organizationId: string): Promise<number> {
    const [row] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from organization_membership_invitations
      where account_id = ${organizationId}`;
    return row!.count;
  }

  /** A governed organization with two shared workspaces and a member in both. */
  async function memberWithTwoWorkspaces(app: App) {
    const { organizationId, businessWorkspaceId } = await hostOrganization(HOST_SOURCE);
    const email = `member-${crypto.randomUUID()}@example.test`;
    expect((await hostInvite(organizationId, businessWorkspaceId, email)).status).toBe(201);
    const member = await acceptAsNewMember(app, email);
    const second = await app.request(`/v1/organizations/${organizationId}/workspaces`, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify({ name: "Second workspace", operationId: crypto.randomUUID() }),
    });
    expect(second.status).toBe(201);
    const secondWorkspaceId = ((await second.json()) as { id: string }).id;
    const [membership] = await shared.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${organizationId} and subject_id = ${member.subjectId}`;
    const granted = await app.request(
      `/v1/host/organizations/${organizationId}/workspaces/${secondWorkspaceId}/members/${membership!.id}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${await hostToken(organizationId, businessWorkspaceId)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actingExternalUser,
          command: { role: "member", expectedUpdatedAt: null, operationId: crypto.randomUUID() },
        }),
      },
    );
    expect(granted.status).toBe(200);
    return {
      organizationId,
      businessWorkspaceId,
      secondWorkspaceId,
      member,
      organizationMembershipId: membership!.id,
    };
  }

  async function revokeNatively(
    app: App,
    input: { organizationId: string; workspaceId: string; organizationMembershipId: string },
    subjectId: string,
  ) {
    // Microsecond precision: the revoke compares it exactly.
    const [row] = await shared.admin<{ updatedAt: string }[]>`
      select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
      from workspace_memberships
      where workspace_id = ${input.workspaceId} and subject_id = ${subjectId}`;
    return await app.request(
      `/v1/organizations/${input.organizationId}/workspaces/${input.workspaceId}/members/${input.organizationMembershipId}/revoke`,
      {
        method: "POST",
        headers: browser(owner.cookie),
        body: JSON.stringify({
          expectedUpdatedAt: row!.updatedAt,
          operationId: crypto.randomUUID(),
        }),
      },
    );
  }

  test("a host invitation without a shared workspace is refused", async () => {
    const { organizationId, businessWorkspaceId } = await hostOrganization(HOST_SOURCE);
    const before = await invitationCount(organizationId);
    const refused = await hostInvite(
      organizationId,
      businessWorkspaceId,
      `x-${crypto.randomUUID()}@example.test`,
      null,
    );
    expect(refused.status).toBe(422);
    expect(detailCode(await refused.json())).toBe("GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE");
    expect(await invitationCount(organizationId)).toBe(before);
  }, 60_000);

  test("removing a governed member's last shared workspace is refused; another one is not", async () => {
    const app = appFor(removalAllowedPort);
    const world = await memberWithTwoWorkspaces(app);
    // The second workspace goes; the business one stays.
    const removed = await revokeNatively(
      app,
      { ...world, workspaceId: world.secondWorkspaceId },
      world.member.subjectId,
    );
    expect(removed.status).toBe(200);
    // Now the business workspace is the member's last one.
    const last = await revokeNatively(
      app,
      { ...world, workspaceId: world.businessWorkspaceId },
      world.member.subjectId,
    );
    expect(last.status).toBe(409);
    expect(detailCode(await last.json())).toBe("GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE");
    const workspaceRoute = await app.request(
      `/v1/workspaces/${world.businessWorkspaceId}/members/${encodeURIComponent(world.member.subjectId)}`,
      { method: "DELETE", headers: browser(owner.cookie) },
    );
    expect(workspaceRoute.status).toBe(409);
    expect(detailCode(await workspaceRoute.json())).toBe(
      "GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE",
    );
    const { defaultWorkspaceId } = await memberAccess(app, world.member, world.organizationId);
    expect(defaultWorkspaceId).toBe(world.businessWorkspaceId);
  }, 120_000);

  test("an ungoverned organization still invites without a workspace and removes the last one", async () => {
    const { organizationId, businessWorkspaceId } = await hostOrganization(null);
    const app = appFor(removalAllowedPort);
    const withoutWorkspace = await app.request(`/v1/organizations/${organizationId}/invitations`, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify(inviteCommand(`x-${crypto.randomUUID()}@example.test`, null)),
    });
    expect(withoutWorkspace.status).toBe(201);
    const email = `member-${crypto.randomUUID()}@example.test`;
    const invited = await app.request(`/v1/organizations/${organizationId}/invitations`, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify(inviteCommand(email, businessWorkspaceId)),
    });
    expect(invited.status).toBe(201);
    const member = await acceptAsNewMember(app, email);
    const [membership] = await shared.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${organizationId} and subject_id = ${member.subjectId}`;
    const removed = await revokeNatively(
      app,
      {
        organizationId,
        workspaceId: businessWorkspaceId,
        organizationMembershipId: membership!.id,
      },
      member.subjectId,
    );
    expect(removed.status).toBe(200);
  }, 120_000);
});

describe("removal guard runs inside the removal command", () => {
  beforeAll(freshOwner, 60_000);

  async function grantHost(
    organizationId: string,
    workspaceId: string,
    membershipId: string,
    role: "member" | "admin",
  ) {
    return await governedApp.request(
      `/v1/host/organizations/${organizationId}/workspaces/${workspaceId}/members/${membershipId}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${await hostToken(organizationId, workspaceId)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actingExternalUser,
          command: {
            role,
            expectedUpdatedAt: await accessUpdatedAt(workspaceId, membershipId),
            operationId: crypto.randomUUID(),
          },
        }),
      },
    );
  }

  async function accessUpdatedAt(
    workspaceId: string,
    membershipId: string,
  ): Promise<string | null> {
    const [row] = await shared.admin<{ updatedAt: string }[]>`
      select to_char(wm.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
      from workspace_memberships wm
      join organization_memberships om on om.subject_id = wm.subject_id and om.account_id = wm.account_id
      where wm.workspace_id = ${workspaceId} and om.id = ${membershipId}`;
    return row?.updatedAt ?? null;
  }

  /** A governed organization with a member and a workspace-only admin, both in the business workspace. */
  async function governedPair(app: App) {
    const { organizationId, businessWorkspaceId } = await hostOrganization(HOST_SOURCE);
    const people: { person: Person; membershipId: string }[] = [];
    for (const label of ["member", "workspace-admin"]) {
      const email = `${label}-${crypto.randomUUID()}@example.test`;
      expect((await hostInvite(organizationId, businessWorkspaceId, email)).status).toBe(201);
      const person = await acceptAsNewMember(app, email);
      const [membership] = await shared.admin<{ id: string }[]>`
        select id from organization_memberships
        where account_id = ${organizationId} and subject_id = ${person.subjectId}`;
      people.push({ person, membershipId: membership!.id });
    }
    const [member, admin] = people as [(typeof people)[0], (typeof people)[0]];
    expect(
      (await grantHost(organizationId, businessWorkspaceId, admin.membershipId, "admin")).status,
    ).toBe(200);
    return { organizationId, businessWorkspaceId, member, admin };
  }

  test("a workspace-only admin gets the route's own answers, never a 500", async () => {
    const app = appFor(removalAllowedPort);
    const world = await governedPair(app);
    // The organization route needs organization administration: its own 403.
    const [row] = await shared.admin<{ updatedAt: string }[]>`
      select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
      from workspace_memberships
      where workspace_id = ${world.businessWorkspaceId} and subject_id = ${world.member.person.subjectId}`;
    const organizationRoute = await app.request(
      `/v1/organizations/${world.organizationId}/workspaces/${world.businessWorkspaceId}/members/${world.member.membershipId}/revoke`,
      {
        method: "POST",
        headers: browser(world.admin.person.cookie),
        body: JSON.stringify({
          expectedUpdatedAt: row!.updatedAt,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(organizationRoute.status).toBe(403);
    // The workspace route lets a workspace admin remove; the last grant is the guard's 409.
    const workspaceRoute = await app.request(
      `/v1/workspaces/${world.businessWorkspaceId}/members/${encodeURIComponent(world.member.person.subjectId)}`,
      { method: "DELETE", headers: browser(world.admin.person.cookie) },
    );
    expect(workspaceRoute.status).toBe(409);
    expect(detailCode(await workspaceRoute.json())).toBe(
      "GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE",
    );
    // A subject without a grant keeps the route's own answer.
    const missing = await app.request(
      `/v1/workspaces/${world.businessWorkspaceId}/members/${encodeURIComponent(`user:${crypto.randomUUID()}`)}`,
      { method: "DELETE", headers: browser(owner.cookie) },
    );
    expect(missing.status).not.toBe(409);
    expect(missing.status).toBeLessThan(500);
  }, 180_000);

  test("a service principal's last grant is removed; only managed humans are checked", async () => {
    const app = appFor(removalAllowedPort);
    const { organizationId, businessWorkspaceId } = await hostOrganization(HOST_SOURCE);
    const service = `service:test-host-${crypto.randomUUID()}`;
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${organizationId}, ${businessWorkspaceId}, ${service}, 'member', ${shared.admin.json(["workspace:read"])})`;
    const removed = await app.request(
      `/v1/workspaces/${businessWorkspaceId}/members/${encodeURIComponent(service)}`,
      { method: "DELETE", headers: browser(owner.cookie) },
    );
    expect(removed.status).toBe(204);
  }, 60_000);
});

describe("reactivating a governed member re-grants a shared workspace", () => {
  beforeAll(freshOwner, 60_000);

  async function lifecycle(
    organizationId: string,
    workspaceId: string,
    membershipId: string,
    kind: "suspend" | "reactivate",
    extra: Record<string, unknown> = {},
  ) {
    const [row] = await shared.admin<{ revision: number }[]>`
      select authorization_revision::int as revision from organization_memberships where id = ${membershipId}`;
    return await governedApp.request(
      `/v1/host/organizations/${organizationId}/members/${membershipId}/${kind}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await hostToken(organizationId, workspaceId)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actingExternalUser,
          command: {
            expectedAuthorizationRevision: row!.revision,
            operationId: crypto.randomUUID(),
            ...extra,
          },
        }),
      },
    );
  }

  async function suspendedMember() {
    const { organizationId, businessWorkspaceId } = await hostOrganization(HOST_SOURCE);
    const email = `member-${crypto.randomUUID()}@example.test`;
    expect((await hostInvite(organizationId, businessWorkspaceId, email)).status).toBe(201);
    const member = await acceptAsNewMember(governedApp, email);
    const [membership] = await shared.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${organizationId} and subject_id = ${member.subjectId}`;
    const membershipId = membership!.id;
    expect(
      (await lifecycle(organizationId, businessWorkspaceId, membershipId, "suspend")).status,
    ).toBe(200);
    // Suspension removes every workspace grant.
    expect(await sharedGrants(organizationId, member.subjectId, businessWorkspaceId)).toBe(0);
    return { organizationId, businessWorkspaceId, member, membershipId };
  }

  async function sharedGrants(organizationId: string, subjectId: string, workspaceId: string) {
    const [row] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from workspace_memberships
      where account_id = ${organizationId} and subject_id = ${subjectId} and workspace_id = ${workspaceId}`;
    return row!.count;
  }

  async function status(membershipId: string): Promise<string> {
    const [row] = await shared.admin<{ status: string }[]>`
      select status from organization_memberships where id = ${membershipId}`;
    return row!.status;
  }

  test("a host reactivation without workspaceIds is refused", async () => {
    const world = await suspendedMember();
    for (const extra of [{}, { workspaceIds: [] }]) {
      const refused = await lifecycle(
        world.organizationId,
        world.businessWorkspaceId,
        world.membershipId,
        "reactivate",
        extra,
      );
      expect(refused.status).toBe(422);
      expect(detailCode(await refused.json())).toBe("GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE");
    }
    expect(await status(world.membershipId)).toBe("suspended");
  }, 120_000);

  test("a host reactivation with workspaceIds grants them in the same command", async () => {
    const world = await suspendedMember();
    const reactivated = await lifecycle(
      world.organizationId,
      world.businessWorkspaceId,
      world.membershipId,
      "reactivate",
      { workspaceIds: [world.businessWorkspaceId] },
    );
    expect(reactivated.status).toBe(200);
    expect(((await reactivated.json()) as { status: string }).status).toBe("active");
    expect(
      await sharedGrants(world.organizationId, world.member.subjectId, world.businessWorkspaceId),
    ).toBe(1);
    const { defaultWorkspaceId } = await memberAccess(
      governedApp,
      world.member,
      world.organizationId,
    );
    expect(defaultWorkspaceId).toBe(world.businessWorkspaceId);
  }, 120_000);

  test("a grant that fails rolls the reactivation back", async () => {
    const world = await suspendedMember();
    const failed = await lifecycle(
      world.organizationId,
      world.businessWorkspaceId,
      world.membershipId,
      "reactivate",
      { workspaceIds: [crypto.randomUUID()] },
    );
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.status).toBeLessThan(500);
    expect(await status(world.membershipId)).toBe("suspended");
  }, 120_000);

  test("a native reactivation in a governed organization is refused", async () => {
    const world = await suspendedMember();
    const [row] = await shared.admin<{ revision: number }[]>`
      select authorization_revision::int as revision from organization_memberships where id = ${world.membershipId}`;
    const refused = await appFor(removalAllowedPort).request(
      `/v1/organizations/${world.organizationId}/members/${world.membershipId}`,
      {
        method: "PATCH",
        headers: browser(owner.cookie),
        body: JSON.stringify({
          kind: "reactivate",
          expectedAuthorizationRevision: row!.revision,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(refused.status).toBe(422);
    expect(detailCode(await refused.json())).toBe("GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE");
    expect(await status(world.membershipId)).toBe("suspended");
  }, 120_000);

  test("an ungoverned organization still suspends and reactivates natively", async () => {
    const { organizationId, businessWorkspaceId } = await hostOrganization(null);
    const email = `member-${crypto.randomUUID()}@example.test`;
    const invited = await governedApp.request(`/v1/organizations/${organizationId}/invitations`, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify(inviteCommand(email, businessWorkspaceId)),
    });
    expect(invited.status).toBe(201);
    const member = await acceptAsNewMember(governedApp, email);
    const [membership] = await shared.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${organizationId} and subject_id = ${member.subjectId}`;
    for (const kind of ["suspend", "reactivate"] as const) {
      const [row] = await shared.admin<{ revision: number }[]>`
        select authorization_revision::int as revision from organization_memberships where id = ${membership!.id}`;
      const response = await governedApp.request(
        `/v1/organizations/${organizationId}/members/${membership!.id}`,
        {
          method: "PATCH",
          headers: browser(owner.cookie),
          body: JSON.stringify({
            kind,
            expectedAuthorizationRevision: row!.revision,
            operationId: crypto.randomUUID(),
          }),
        },
      );
      expect(response.status).toBe(200);
    }
    expect(await status(membership!.id)).toBe("active");
  }, 120_000);
});
