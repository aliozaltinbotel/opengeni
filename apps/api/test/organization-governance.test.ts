import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  organizationAccessPresetPermissions,
  signDelegatedAccessToken,
  type DelegatedAccessTokenPayload,
  type Permission,
} from "@opengeni/contracts";
import {
  GOVERNED_MUTATIONS,
  type GovernedMutation,
  type OrganizationGovernancePort,
} from "@opengeni/contracts/organization-governance";
import type {
  AppDependencies,
  ManagedEmailDeliveryResult,
  ManagedEmailMessage,
} from "@opengeni/core";
import {
  createAdditionalManagedOrganization,
  createDb,
  createManagedOrganization,
  createOrganizationApiKey,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { startApiOrganizationGovernanceOverride, type StartApiOptions } from "../src/index";

/*
 * Organization governance host port, end to end through the real app and
 * PostgreSQL. Without the port every route keeps its native behaviour. With a
 * port that governs an organization (by its external identity source), every
 * native membership, role, workspace-access, external-member, API-key and
 * service-account mutation answers ORGANIZATION_GOVERNED_BY_HOST, even for the
 * owner, while the host's own commands (a service delegated token) run the
 * same operations and record the acting external user next to their receipts.
 */

const origin = "http://opengeni.test";
const delegationSecret = "organization-governance-delegation-secret-at-least-32";
const HOST_SOURCE = "test-host:tenant";
const actingExternalUser = { source: "test-host:user", externalId: "staff-42" };

let shared: SharedTestDatabase;
let client: DbClient;
const sentEmails: ManagedEmailMessage[] = [];
const managedEmailTransport = {
  sender: "Opengeni <auth@mail.opengeni.ai>",
  idempotency: { scope: "test-provider-v1:organization-governance", retentionSeconds: 86_400 },
  send: async (message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult> => {
    sentEmails.push(structuredClone(message));
    return { status: "sent", providerMessageId: `message-${sentEmails.length}` };
  },
};

const decisions: Array<{ mutation: GovernedMutation; via: "native" | "host" }> = [];
const hostPort: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: ({ mutation, via }) => {
    decisions.push({ mutation, via });
    return via === "host" ? "allow" : "refuse";
  },
};

type App = ReturnType<typeof createApp>;
let stockApp: App;
let governedApp: App;

type World = {
  owner: Person;
  governedOrganizationId: string;
  sharedWorkspaceId: string;
  ownerMembershipId: string;
  ungovernedOrganizationId: string;
  ungovernedWorkspaceId: string;
  organizationKeyToken: string;
};
type Person = { cookie: string; email: string; subjectId: string };
let world: World;

function appFor(organizationGovernance?: OrganizationGovernancePort): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "organization-governance-test-secret-32-bytes",
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

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function signUp(app: App, name: string): Promise<Person> {
  const email = `governance-${crypto.randomUUID()}@example.test`;
  const password = "password1234";
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  const response = await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Better Auth response did not set a session cookie");
  const [user] = await shared.admin<{ id: string }[]>`
    select id from auth_users where email = ${email}`;
  return { cookie: cookie.split(";", 1)[0]!, email, subjectId: `user:${user!.id}` };
}

async function serviceToken(overrides: Partial<DelegatedAccessTokenPayload> = {}): Promise<string> {
  return await signDelegatedAccessToken(delegationSecret, {
    accountId: world.governedOrganizationId,
    workspaceId: world.sharedWorkspaceId,
    subjectId: world.owner.subjectId,
    permissions: ["members:manage"],
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: "test-host:governance" },
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function refusalCode(body: Record<string, unknown>): unknown {
  const error = body.error as { details?: { code?: unknown; mutation?: unknown } } | undefined;
  return error?.details?.code;
}

function refusedMutation(body: Record<string, unknown>): unknown {
  const error = body.error as { details?: { mutation?: unknown } } | undefined;
  return error?.details?.mutation;
}

function inviteBody(email: string, operationId = crypto.randomUUID()) {
  return {
    email,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operationId,
  };
}

async function organizationKey(accountId: string): Promise<string> {
  const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
  await createOrganizationApiKey(client.db, {
    accountId,
    name: "Host service key",
    prefix: token.slice(0, 14),
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:read", "members:manage", "account:admin", "api_keys:manage"],
  });
  return token;
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-governance");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  stockApp = appFor();
  governedApp = appFor(hostPort);

  const owner = await signUp(stockApp, "Governance Owner");
  const ungoverned = await createManagedOrganization(client.db, {
    subjectId: owner.subjectId,
    subjectLabel: owner.email,
    name: "Ungoverned organization",
    operationId: crypto.randomUUID(),
  });
  const governed = await createAdditionalManagedOrganization(client.db, {
    subjectId: owner.subjectId,
    subjectLabel: owner.email,
    name: "Host tenant organization",
    workspaceName: "Tenant workspace",
    operationId: crypto.randomUUID(),
  });
  const governedOrganizationId = governed.organization.id;
  // The host's own provisioning marks its organizations with its source.
  await shared.admin`
    update managed_accounts set external_source = ${HOST_SOURCE},
      external_id = ${crypto.randomUUID()}
    where id = ${governedOrganizationId}`;
  const [ownerMembership] = await shared.admin<{ id: string }[]>`
    select id from organization_memberships
    where account_id = ${governedOrganizationId} and subject_id = ${owner.subjectId}`;
  world = {
    owner,
    governedOrganizationId,
    sharedWorkspaceId: governed.workspaceId,
    ownerMembershipId: ownerMembership!.id,
    ungovernedOrganizationId: ungoverned.organization.id,
    ungovernedWorkspaceId: ungoverned.workspaceId,
    organizationKeyToken: await organizationKey(governedOrganizationId),
  };
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

type NativeRoute = {
  mutation: GovernedMutation;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  path: () => string;
  auth: "owner" | "organization_key";
  body?: () => unknown;
};

const id = () => crypto.randomUUID();
const org = () => `/v1/organizations/${world.governedOrganizationId}`;
const ws = () => `/v1/workspaces/${world.sharedWorkspaceId}`;
const readPolicy = () => ({
  preset: "read_only",
  permissions: organizationAccessPresetPermissions("read_only"),
  workspaceScope: { kind: "all" },
});

/**
 * Every native mutation route of the governed groups (Task 3 Step 1:
 * `grep -n "app\.\(post\|patch\|put\|delete\)"` over organization-memberships.ts,
 * api-keys.ts, personal-api-keys.ts, organization-service-accounts.ts and the
 * workspace member routes in workspaces.ts). Each must reach the port.
 */
const nativeRoutes: NativeRoute[] = [
  // organization-memberships.ts
  {
    mutation: "invitation.create",
    method: "POST",
    path: () => `${org()}/invitations`,
    auth: "owner",
    body: () => inviteBody(`invitee-${id()}@example.test`),
  },
  {
    mutation: "invitation.delivery.retry",
    method: "POST",
    path: () => `${org()}/invitations/${id()}/delivery/retry`,
    auth: "owner",
    body: () => ({ operationId: id() }),
  },
  {
    mutation: "invitation.revoke",
    method: "POST",
    path: () => `${org()}/invitations/${id()}/revoke`,
    auth: "owner",
    body: () => ({ expectedRevision: 1, operationId: id() }),
  },
  ...(
    [
      ["membership.role.change", { kind: "change_role", role: "admin" }],
      ["membership.suspend", { kind: "suspend" }],
      ["membership.reactivate", { kind: "reactivate" }],
      ["membership.offboard", { kind: "offboard" }],
    ] as const
  ).map(
    ([mutation, transition]): NativeRoute => ({
      mutation,
      method: "PATCH",
      path: () => `${org()}/members/${id()}`,
      auth: "owner",
      body: () => ({ ...transition, expectedAuthorizationRevision: 1, operationId: id() }),
    }),
  ),
  {
    mutation: "workspace_member.update",
    method: "PUT",
    path: () => `${org()}/workspaces/${world.sharedWorkspaceId}/members/${id()}`,
    auth: "owner",
    body: () => ({ role: "member", expectedUpdatedAt: null, operationId: id() }),
  },
  {
    mutation: "workspace_member.remove",
    method: "POST",
    path: () => `${org()}/workspaces/${world.sharedWorkspaceId}/members/${id()}/revoke`,
    auth: "owner",
    body: () => ({ expectedUpdatedAt: new Date().toISOString(), operationId: id() }),
  },
  {
    mutation: "external_member.update",
    method: "POST",
    path: () => `${org()}/workspaces/${world.sharedWorkspaceId}/members/${id()}/revoke`,
    auth: "organization_key",
    body: () => ({ cancelGrantOperationId: id(), operationId: id() }),
  },
  {
    mutation: "external_member.update",
    method: "PATCH",
    path: () => `${org()}/external-members/${id()}`,
    auth: "organization_key",
    body: () => ({ kind: "suspend", expectedAuthorizationRevision: 1, operationId: id() }),
  },
  {
    mutation: "external_member.update",
    method: "PATCH",
    path: () => `${org()}/workspaces/${world.sharedWorkspaceId}/external-members/${id()}`,
    auth: "organization_key",
    body: () => ({ permissions: ["workspace:read"], operationId: id() }),
  },
  // workspaces.ts: external members and workspace members
  {
    mutation: "external_member.add",
    method: "POST",
    path: () => `${ws()}/external-members`,
    auth: "organization_key",
    body: () => ({
      identity: { source: "test-host:user", externalId: `person-${id()}` },
      permissions: ["workspace:read"],
    }),
  },
  {
    mutation: "external_member.update",
    method: "PATCH",
    path: () => `${ws()}/external-members/${encodeURIComponent(`external_user:${id()}`)}`,
    auth: "organization_key",
    body: () => ({
      identity: { source: "test-host:user", externalId: "person" },
      expectedPermissions: ["workspace:read"],
      permissions: ["workspace:read", "sessions:read"],
    }),
  },
  {
    mutation: "workspace_member.add",
    method: "POST",
    path: () => `${ws()}/members`,
    auth: "owner",
    body: () => ({ organizationMembershipId: id(), permissions: ["workspace:read"] }),
  },
  {
    mutation: "workspace_member.update",
    method: "PATCH",
    path: () => `${ws()}/members/${encodeURIComponent(`user:${id()}`)}`,
    auth: "owner",
    body: () => ({ permissions: ["workspace:read"] }),
  },
  {
    mutation: "workspace_member.remove",
    method: "DELETE",
    path: () => `${ws()}/members/${encodeURIComponent(`user:${id()}`)}`,
    auth: "owner",
  },
  // api-keys.ts
  {
    mutation: "api_key.create",
    method: "POST",
    path: () => `${ws()}/api-keys`,
    auth: "owner",
    body: () => ({ name: "Workspace key", permissions: ["workspace:read"] }),
  },
  {
    mutation: "api_key.revoke",
    method: "DELETE",
    path: () => `${ws()}/api-keys/${id()}`,
    auth: "owner",
  },
  {
    mutation: "api_key.create",
    method: "POST",
    path: () => `${org()}/api-keys`,
    auth: "owner",
    body: () => ({ name: "Organization key", access: "read" }),
  },
  {
    mutation: "api_key.update",
    method: "PATCH",
    path: () => `${org()}/api-keys/${id()}`,
    auth: "owner",
    body: () => ({ name: "Renamed key" }),
  },
  {
    mutation: "api_key.revoke",
    method: "DELETE",
    path: () => `${org()}/api-keys/${id()}`,
    auth: "owner",
  },
  // personal-api-keys.ts (revocation needs an existing key: see its own test)
  {
    mutation: "personal_api_key.create",
    method: "POST",
    path: () => `${org()}/personal-api-keys`,
    auth: "owner",
    body: () => ({ name: "My key", access: readPolicy() }),
  },
  // organization-service-accounts.ts
  {
    mutation: "service_account.create",
    method: "POST",
    path: () => `${org()}/service-accounts`,
    auth: "owner",
    body: () => ({ name: "Robot", role: "member" }),
  },
  {
    mutation: "service_account.update",
    method: "PATCH",
    path: () => `${org()}/service-accounts/${id()}`,
    auth: "owner",
    body: () => ({ name: "Renamed robot" }),
  },
  {
    mutation: "service_account.delete",
    method: "DELETE",
    path: () => `${org()}/service-accounts/${id()}`,
    auth: "owner",
  },
];

async function requestNative(app: App, route: NativeRoute): Promise<Response> {
  const headers =
    route.auth === "owner" ? browser(world.owner.cookie) : bearer(world.organizationKeyToken);
  return await app.request(route.path(), {
    method: route.method,
    headers,
    ...(route.body ? { body: JSON.stringify(route.body()) } : {}),
  });
}

describe("organization governance port", () => {
  test("the route table names every governed mutation the port can be asked about", () => {
    const routed = new Set([
      ...nativeRoutes.map((route) => route.mutation),
      "personal_api_key.revoke",
    ]);
    expect([...routed].sort()).toEqual([...GOVERNED_MUTATIONS].sort());
  });

  test("stock: without the port each route group behaves as today and host commands are absent", async () => {
    const owner = browser(world.owner.cookie);
    const invite = await stockApp.request(`${org()}/invitations`, {
      method: "POST",
      headers: owner,
      body: JSON.stringify(inviteBody(`stock-${id()}@example.test`)),
    });
    expect(invite.status).toBe(201);
    const stockOrganizationKey = await stockApp.request(`${org()}/api-keys`, {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ name: "Stock organization key", access: "read" }),
    });
    expect(stockOrganizationKey.status).toBe(201);
    const workspaceKey = await stockApp.request(`${ws()}/api-keys`, {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ name: "Stock workspace key", permissions: ["workspace:read"] }),
    });
    expect(workspaceKey.status).toBe(201);
    const personalKey = await stockApp.request(`${org()}/personal-api-keys`, {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ name: "Stock personal key", access: readPolicy() }),
    });
    expect(personalKey.status).toBe(201);
    const serviceAccount = await stockApp.request(`${org()}/service-accounts`, {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ name: "Stock robot", role: "member" }),
    });
    expect(serviceAccount.status).toBe(201);
    const externalMember = await stockApp.request(`${ws()}/external-members`, {
      method: "POST",
      headers: bearer(world.organizationKeyToken),
      body: JSON.stringify({
        identity: { source: "test-host:user", externalId: `stock-${id()}` },
        permissions: ["workspace:read"],
      }),
    });
    expect(externalMember.status).toBe(200);
    const hostCommand = await stockApp.request(
      `/v1/host/organizations/${world.governedOrganizationId}/invitations`,
      {
        method: "POST",
        headers: bearer(await serviceToken()),
        body: JSON.stringify({ actingExternalUser, command: inviteBody(`x-${id()}@example.test`) }),
      },
    );
    expect(hostCommand.status).toBe(404);
  }, 60_000);

  test("governed: every native mutation answers ORGANIZATION_GOVERNED_BY_HOST, even for the owner", async () => {
    const [{ count: invitationsBefore } = { count: 0 }] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from organization_membership_invitations
      where account_id = ${world.governedOrganizationId}`;
    for (const route of nativeRoutes) {
      decisions.length = 0;
      const response = await requestNative(governedApp, route);
      const body = await json(response);
      expect({ route: `${route.method} ${route.path()}`, status: response.status }).toMatchObject({
        status: 403,
      });
      expect(refusalCode(body)).toBe("ORGANIZATION_GOVERNED_BY_HOST");
      expect(refusedMutation(body)).toBe(route.mutation);
      expect(decisions).toEqual([{ mutation: route.mutation, via: "native" }]);
    }
    const [{ count: invitationsAfter } = { count: 0 }] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from organization_membership_invitations
      where account_id = ${world.governedOrganizationId}`;
    expect(invitationsAfter).toBe(invitationsBefore);
  }, 60_000);

  test("governed: revoking an existing personal key is decided by the host too", async () => {
    const created = await stockApp.request(`${org()}/personal-api-keys`, {
      method: "POST",
      headers: browser(world.owner.cookie),
      body: JSON.stringify({ name: "Key to revoke", access: readPolicy() }),
    });
    expect(created.status).toBe(201);
    const { apiKey } = (await created.json()) as { apiKey: { id: string } };
    const revoke = await governedApp.request(`${org()}/personal-api-keys/${apiKey.id}`, {
      method: "DELETE",
      headers: browser(world.owner.cookie),
    });
    expect(revoke.status).toBe(403);
    const body = await json(revoke);
    expect(refusalCode(body)).toBe("ORGANIZATION_GOVERNED_BY_HOST");
    expect(refusedMutation(body)).toBe("personal_api_key.revoke");
  }, 60_000);

  test("an organization the host does not govern is unaffected", async () => {
    const ungoverned = `/v1/organizations/${world.ungovernedOrganizationId}`;
    const invite = await governedApp.request(`${ungoverned}/invitations`, {
      method: "POST",
      headers: browser(world.owner.cookie),
      body: JSON.stringify(inviteBody(`ungoverned-${id()}@example.test`)),
    });
    expect(invite.status).toBe(201);
    const key = await governedApp.request(`${ungoverned}/api-keys`, {
      method: "POST",
      headers: browser(world.owner.cookie),
      body: JSON.stringify({ name: "Ungoverned key", access: "read" }),
    });
    expect(key.status).toBe(201);
    const hostCommand = await governedApp.request(
      `/v1/host/organizations/${world.ungovernedOrganizationId}/invitations`,
      {
        method: "POST",
        headers: bearer(
          await serviceToken({
            accountId: world.ungovernedOrganizationId,
            workspaceId: world.ungovernedWorkspaceId,
          }),
        ),
        body: JSON.stringify({ actingExternalUser, command: inviteBody(`x-${id()}@example.test`) }),
      },
    );
    // A service token is never a general administration door.
    expect(hostCommand.status).toBe(403);
    expect(refusalCode(await json(hostCommand))).toBe("ORGANIZATION_NOT_HOST_GOVERNED");
  }, 60_000);

  test("host commands run the native operations and name the acting external user", async () => {
    const host = `/v1/host/organizations/${world.governedOrganizationId}`;
    const headers = bearer(await serviceToken());
    const target = await signUp(stockApp, "Invited Staff");

    const inviteOperationId = id();
    const inviteCommand = inviteBody(target.email, inviteOperationId);
    decisions.length = 0;
    const invite = await governedApp.request(`${host}/invitations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ actingExternalUser, command: inviteCommand }),
    });
    expect(invite.status).toBe(201);
    expect(decisions).toEqual([{ mutation: "invitation.create", via: "host" }]);
    const invitation = (await invite.json()) as { id: string };
    await expectReceipt("invite", inviteOperationId, "invitation.create");
    expect(sentEmails.some((message) => message.to === target.email)).toBe(true);

    // The same command replays; another acting user under its id is refused.
    const replay = await governedApp.request(`${host}/invitations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ actingExternalUser, command: inviteCommand }),
    });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { id: string }).id).toBe(invitation.id);
    const conflicting = await governedApp.request(`${host}/invitations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        actingExternalUser: { ...actingExternalUser, externalId: "someone-else" },
        command: inviteCommand,
      }),
    });
    expect(conflicting.status).toBe(409);
    expect(refusalCode(await json(conflicting))).toBe("HOST_COMMAND_OPERATION_CONFLICT");

    // The invited person accepts natively: acceptance is not governed.
    const listed = (await (
      await stockApp.request("/v1/organization-invitations", { headers: browser(target.cookie) })
    ).json()) as { invitations: Array<{ id: string; revision: number }> };
    const pending = listed.invitations.find((candidate) => candidate.id === invitation.id)!;
    const accept = await governedApp.request(
      `/v1/organization-invitations/${invitation.id}/accept`,
      {
        method: "POST",
        headers: browser(target.cookie),
        body: JSON.stringify({ expectedRevision: pending.revision, operationId: id() }),
      },
    );
    expect(accept.status).toBe(200);
    let member = ((await accept.json()) as { membership: Member }).membership;

    const roleOperationId = id();
    const role = await governedApp.request(`${host}/members/${member.id}/change-role`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        actingExternalUser,
        command: {
          role: "admin",
          expectedAuthorizationRevision: member.authorizationRevision,
          operationId: roleOperationId,
        },
      }),
    });
    expect(role.status).toBe(200);
    member = (await role.json()) as Member;
    expect(member.role).toBe("admin");
    await expectReceipt("change_role", roleOperationId, "membership.role.change");

    const grantOperationId = id();
    const grant = await governedApp.request(
      `${host}/workspaces/${world.sharedWorkspaceId}/members/${member.id}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          actingExternalUser,
          command: { role: "member", expectedUpdatedAt: null, operationId: grantOperationId },
        }),
      },
    );
    expect(grant.status).toBe(200);
    const [workspaceEvent] = await shared.admin<{ kind: string; actor_membership_id: string }[]>`
      select kind, actor_membership_id from organization_workspace_lifecycle_events
      where account_id = ${world.governedOrganizationId} and operation_id = ${grantOperationId}`;
    expect(workspaceEvent).toEqual({ kind: "grant", actor_membership_id: world.ownerMembershipId });
    await expectAttribution(grantOperationId, "workspace_member.update");

    for (const [kind, mutation, status] of [
      ["suspend", "membership.suspend", "suspended"],
      ["reactivate", "membership.reactivate", "active"],
      ["offboard", "membership.offboard", "revoked"],
    ] as const) {
      const operationId = id();
      const response = await governedApp.request(`${host}/members/${member.id}/${kind}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          actingExternalUser,
          command: {
            expectedAuthorizationRevision: member.authorizationRevision,
            operationId,
            ...(kind === "reactivate" ? {} : { reason: "host decision" }),
          },
        }),
      });
      expect({ kind, status: response.status }).toEqual({ kind, status: 200 });
      member = (await response.json()) as Member;
      expect(member.status).toBe(status);
      await expectReceipt(kind, operationId, mutation);
    }

    const second = await governedApp.request(`${host}/invitations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        actingExternalUser,
        command: inviteBody(`later-${id()}@example.test`),
      }),
    });
    expect(second.status).toBe(201);
    const secondInvitation = (await second.json()) as { id: string; revision: number };
    const revokeOperationId = id();
    const revoke = await governedApp.request(`${host}/invitations/${secondInvitation.id}/revoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        actingExternalUser,
        command: { expectedRevision: secondInvitation.revision, operationId: revokeOperationId },
      }),
    });
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { status: string }).status).toBe("revoked");
    await expectReceipt("revoke_invitation", revokeOperationId, "invitation.revoke");
  }, 120_000);

  test("host commands refuse anything but a service token for the governed organization", async () => {
    const path = `/v1/host/organizations/${world.governedOrganizationId}/invitations`;
    const command = () =>
      JSON.stringify({ actingExternalUser, command: inviteBody(`refused-${id()}@example.test`) });
    const ordinaryDelegated = await signDelegatedAccessToken(delegationSecret, {
      accountId: world.governedOrganizationId,
      workspaceId: world.sharedWorkspaceId,
      subjectId: world.owner.subjectId,
      permissions: ["members:manage"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const otherSecret = await signDelegatedAccessToken("another-deployment-secret-at-least-32", {
      accountId: world.governedOrganizationId,
      workspaceId: world.sharedWorkspaceId,
      subjectId: world.owner.subjectId,
      permissions: ["members:manage"],
      principalKind: "service",
      serviceInitiator: { kind: "service", subjectId: "test-host:governance" },
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const refusedCredentials: Array<[string, Record<string, string>]> = [
      ["no credential", { "content-type": "application/json" }],
      ["owner browser session", browser(world.owner.cookie)],
      ["organization API key", bearer(world.organizationKeyToken)],
      ["ordinary ogd_ delegated token", bearer(ordinaryDelegated)],
      ["service token signed with another secret", bearer(otherSecret)],
      ["expired service token", bearer(await serviceToken({ exp: 1 }))],
      [
        "service token for another organization",
        bearer(
          await serviceToken({
            accountId: world.ungovernedOrganizationId,
            workspaceId: world.ungovernedWorkspaceId,
          }),
        ),
      ],
      [
        "service token whose workspace is in another organization",
        bearer(await serviceToken({ workspaceId: world.ungovernedWorkspaceId })),
      ],
    ];
    for (const [label, headers] of refusedCredentials) {
      const response = await governedApp.request(path, {
        method: "POST",
        headers,
        body: command(),
      });
      expect({ label, status: response.status }).toEqual({ label, status: 401 });
      expect(refusalCode(await json(response))).toBe("HOST_COMMAND_SERVICE_TOKEN_REQUIRED");
    }
    const withoutPermission = await governedApp.request(path, {
      method: "POST",
      headers: bearer(await serviceToken({ permissions: ["workspace:read"] as Permission[] })),
      body: command(),
    });
    expect(withoutPermission.status).toBe(403);
    expect(refusalCode(await json(withoutPermission))).toBe("HOST_COMMAND_PERMISSION_REQUIRED");

    // The token's subject is the database actor and is checked like any
    // administrator: a subject that is not an owner or admin changes nothing.
    const outsiderEmail = `outsider-${id()}@example.test`;
    const outsider = await governedApp.request(path, {
      method: "POST",
      headers: bearer(await serviceToken({ subjectId: `user:${id()}` })),
      body: JSON.stringify({ actingExternalUser, command: inviteBody(outsiderEmail) }),
    });
    expect(outsider.status).toBe(403);
    const [{ count: outsiderInvitations } = { count: -1 }] = await shared.admin<
      { count: number }[]
    >`
      select count(*)::int as count from organization_membership_invitations
      where account_id = ${world.governedOrganizationId} and target_email = ${outsiderEmail}`;
    expect(outsiderInvitations).toBe(0);

    const refusingHost = appFor({ governs: () => true, decide: () => "refuse" });
    const refused = await refusingHost.request(path, {
      method: "POST",
      headers: bearer(await serviceToken()),
      body: command(),
    });
    expect(refused.status).toBe(403);
    expect(refusalCode(await json(refused))).toBe("ORGANIZATION_GOVERNED_BY_HOST");

    const notGoverning = appFor({ governs: () => false, decide: () => "allow" });
    const ungoverned = await notGoverning.request(path, {
      method: "POST",
      headers: bearer(await serviceToken()),
      body: command(),
    });
    expect(ungoverned.status).toBe(403);
    expect(refusalCode(await json(ungoverned))).toBe("ORGANIZATION_NOT_HOST_GOVERNED");
  }, 60_000);

  test("startApi forwards the port with the session-authorization option's three shapes", () => {
    expect(startApiOrganizationGovernanceOverride({})).toEqual({});
    expect(startApiOrganizationGovernanceOverride({ organizationGovernance: hostPort })).toEqual({
      organizationGovernance: hostPort,
    });
    expect(startApiOrganizationGovernanceOverride({ organizationGovernance: null })).toEqual({
      organizationGovernance: null,
    });
    const options: StartApiOptions = { organizationGovernance: hostPort };
    expect(options.organizationGovernance).toBe(hostPort);
  });
});

type Member = { id: string; role: string; status: string; authorizationRevision: number };

/** The operation's own lifecycle event, by the token's subject, plus who asked. */
async function expectReceipt(kind: string, operationId: string, mutation: GovernedMutation) {
  const [event] = await shared.admin<
    { kind: string; actor_membership_id: string | null; actor_service_subject: string | null }[]
  >`
    select kind, actor_membership_id, actor_service_subject
    from organization_membership_lifecycle_events
    where account_id = ${world.governedOrganizationId} and operation_id = ${operationId}`;
  expect(event).toEqual({
    kind,
    actor_membership_id: world.ownerMembershipId,
    actor_service_subject: null,
  });
  const [receipt] = await shared.admin<{ action: string }[]>`
    select action from organization_membership_operation_receipts
    where account_id = ${world.governedOrganizationId} and operation_id = ${operationId}`;
  expect(receipt?.action).toBe(kind);
  await expectAttribution(operationId, mutation);
}

async function expectAttribution(operationId: string, mutation: GovernedMutation) {
  const rows = await shared.admin<
    {
      mutation: string;
      service_subject_id: string;
      service_initiator_subject_id: string;
      acting_external_source: string;
      acting_external_id: string;
    }[]
  >`
    select mutation, service_subject_id, service_initiator_subject_id,
      acting_external_source, acting_external_id
    from organization_host_command_attributions
    where account_id = ${world.governedOrganizationId} and operation_id = ${operationId}`;
  expect(rows).toEqual([
    {
      mutation,
      service_subject_id: world.owner.subjectId,
      service_initiator_subject_id: "test-host:governance",
      acting_external_source: actingExternalUser.source,
      acting_external_id: actingExternalUser.externalId,
    },
  ]);
}
