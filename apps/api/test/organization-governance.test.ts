import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
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
import {
  EXTERNAL_FIRST_USE_MEMBER_PERMISSIONS,
  organizationGovernanceDecision,
  organizationGovernedByHost,
  type ApiRouteDeps,
  type AppDependencies,
  type ManagedEmailDeliveryResult,
  type ManagedEmailMessage,
} from "@opengeni/core";
import {
  createAdditionalManagedOrganization,
  createDb,
  createManagedOrganization,
  createOrganizationApiKey,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { createApp } from "../src/app";
import { registerOrganizationMembershipRoutes } from "../src/routes/organization-memberships";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";
import { requireNativeWorkspaceMutation } from "../src/http/organization-governance";
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

function appFor(
  organizationGovernance?: OrganizationGovernancePort,
  options: {
    externalMemberFirstUse?: boolean;
    mcpOAuthHostConsent?: AppDependencies["mcpOAuthHostConsent"];
    structuredLogs?: boolean;
    publicBaseUrl?: string;
    workspaceToolServers?: AppDependencies["workspaceToolServers"];
  } = {},
): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "organization-governance-test-secret-32-bytes",
      publicBaseUrl: options.publicBaseUrl ?? origin,
      delegationSecret,
      organizationUserSetupEmailTokenTransport: "query",
      organizationUserSetupQueryEdgeSanitizationConfirmed: true,
      mcpOauthEnabled: true,
      hostTokenAudience: "https://host-consent.example.test",
      observabilityStructuredLogs: options.structuredLogs === true,
      externalMemberFirstUseEnabled: options.externalMemberFirstUse === true,
      ...(options.workspaceToolServers
        ? {
            mcpServers: [
              {
                id: "consent-tools",
                url: "https://consent-tools.invalid/mcp",
                cacheToolsList: false,
              },
            ],
          }
        : {}),
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    managedEmailTransport,
    ...(options.mcpOAuthHostConsent ? { mcpOAuthHostConsent: options.mcpOAuthHostConsent } : {}),
    ...(options.workspaceToolServers ? { workspaceToolServers: options.workspaceToolServers } : {}),
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

/** A governed organization's invitation names a shared workspace (Task 7). */
function hostInviteBody(email: string, operationId = crypto.randomUUID()) {
  return { ...inviteBody(email, operationId), initialWorkspaceIds: [world.sharedWorkspaceId] };
}

async function organizationKey(
  accountId: string,
  permissions: Permission[] = [
    "workspace:read",
    "members:manage",
    "account:admin",
    "api_keys:manage",
  ],
): Promise<string> {
  const token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
  await createOrganizationApiKey(client.db, {
    accountId,
    name: "Host service key",
    prefix: token.slice(0, 14),
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions,
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
  // organization-recovery.ts: the recovery operations
  ...recoveryRoutes(),
  // workspace deletion: organization-memberships.ts and workspaces.ts
  {
    mutation: "workspace.delete",
    method: "DELETE",
    path: () => `${org()}/workspaces/${world.sharedWorkspaceId}`,
    auth: "owner",
  },
  {
    mutation: "workspace.delete",
    method: "DELETE",
    path: () => ws(),
    auth: "owner",
  },
];

function recoveryRoutes(): NativeRoute[] {
  const operation = () => ({ expectedOperationRevision: 1, operationId: id() });
  return [
    {
      mutation: "organization_recovery.start",
      method: "POST",
      path: () => `${org()}/recovery/operations`,
      auth: "owner",
      body: () => ({ targetMembershipId: id(), expectedPolicyRevision: 1, operationId: id() }),
    },
    ...(["approve", "cancel", "execute"] as const).map(
      (command): NativeRoute => ({
        mutation: `organization_recovery.${command}`,
        method: "POST",
        path: () => `${org()}/recovery/operations/${id()}/${command}`,
        auth: "owner",
        body: operation,
      }),
    ),
  ];
}

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
      // Covered by their own tests below: they need an existing key or an
      // OAuth sign-in in progress.
      "personal_api_key.revoke",
      "mcp_connection.create",
      "mcp_connection.update",
      "mcp_connection.revoke",
      // Host command only (organization-session-policy.test.ts): no native route.
      "session_policy.update",
      // Decided against the person's governed memberships, not the route's
      // organization (organization-create-governance.test.ts).
      "organization.create",
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
    const inviteCommand = hostInviteBody(target.email, inviteOperationId);
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

    // The invitation already granted the shared workspace; the host changes it.
    const [invitedAccess] = await shared.admin<{ updatedAt: string }[]>`
      select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
      from workspace_memberships
      where workspace_id = ${world.sharedWorkspaceId} and subject_id = ${target.subjectId}`;
    const grantOperationId = id();
    const grant = await governedApp.request(
      `${host}/workspaces/${world.sharedWorkspaceId}/members/${member.id}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          actingExternalUser,
          command: {
            role: "viewer",
            expectedUpdatedAt: invitedAccess!.updatedAt,
            operationId: grantOperationId,
          },
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
            // Suspension removed every grant; a governed reactivation re-grants.
            ...(kind === "reactivate"
              ? { workspaceIds: [world.sharedWorkspaceId] }
              : { reason: "host decision" }),
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
        command: hostInviteBody(`later-${id()}@example.test`),
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
      JSON.stringify({
        actingExternalUser,
        command: hostInviteBody(`refused-${id()}@example.test`),
      });
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
      body: JSON.stringify({ actingExternalUser, command: hostInviteBody(outsiderEmail) }),
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

const allowAllNative: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: () => "allow",
};

function externalActor(externalId: string): Record<string, string> {
  return {
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { source: "test-host:user", externalId } }),
    ),
  };
}

async function externalIdentityCount(externalId: string): Promise<number> {
  const [row] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from external_identities
    where account_id = ${world.governedOrganizationId}
      and source = 'test-host:user' and external_id = ${externalId}`;
  return row?.count ?? -1;
}

describe("organization governance port, fix round 1", () => {
  test("a failed workspace lookup fails the gate closed; without a port nothing is read", async () => {
    const failing = {
      select: () => {
        throw new Error("connection terminated");
      },
    } as unknown as Database;
    await expect(
      requireNativeWorkspaceMutation(
        { db: failing, organizationGovernance: hostPort },
        id(),
        "external_member.add",
      ),
    ).rejects.toThrow("connection terminated");
    await expect(
      requireNativeWorkspaceMutation({ db: failing }, id(), "external_member.add"),
    ).resolves.toBeUndefined();
  });

  test("stock: body-first external handlers keep their status order without a port", async () => {
    // Handler level, as an embedding host mounts them: unauthenticated requests
    // whose bodies are invalid. Without a port the handlers that validate the
    // body first still answer the validation error, not 401; with a port the
    // caller is authenticated before the host is asked.
    const handlers = (organizationGovernance?: OrganizationGovernancePort) => {
      const app = new Hono();
      app.onError((error, c) =>
        error instanceof HTTPException
          ? c.json({ message: error.message }, error.status)
          : error instanceof ZodError
            ? c.json({ message: "invalid request" }, 400)
            : c.json({ message: "internal" }, 500),
      );
      const deps = {
        db: client.db,
        settings: testSettings({ productAccessMode: "managed" }),
        managedAuth: null,
        ...(organizationGovernance ? { organizationGovernance } : {}),
      } as unknown as ApiRouteDeps;
      registerWorkspaceRoutes(app, deps);
      registerOrganizationMembershipRoutes(app, deps);
      return app;
    };
    const stock = handlers();
    const bound = handlers(hostPort);
    const cases: Array<[string, string, string, number]> = [
      ["PATCH", `${org()}/external-members/${id()}`, "{}", 401],
      [
        "PATCH",
        `${org()}/workspaces/${world.sharedWorkspaceId}/external-members/${id()}`,
        "{}",
        401,
      ],
      [
        "POST",
        `${org()}/workspaces/${world.sharedWorkspaceId}/members/${id()}/revoke`,
        JSON.stringify({ cancelGrantOperationId: "not-a-uuid" }),
        401,
      ],
      ["POST", `${ws()}/external-members`, JSON.stringify({ identity: {} }), 400],
      [
        "PATCH",
        `${ws()}/external-members/${encodeURIComponent(`external_user:${id()}`)}`,
        JSON.stringify({ identity: {} }),
        400,
      ],
    ];
    for (const [method, path, body, status] of cases) {
      const init = { method, headers: { "content-type": "application/json" }, body };
      const response = await stock.request(path, init);
      expect({ method, path, status: response.status }).toEqual({ method, path, status });
    }
    // The body-first PATCH authenticates before the host is asked once a port is bound.
    const patch = cases[4]!;
    const governed = await bound.request(patch[1], {
      method: patch[0],
      headers: { "content-type": "application/json" },
      body: patch[2],
    });
    expect(governed.status).toBe(401);
  }, 60_000);

  test("first-use external provisioning through an organization key asks the host", async () => {
    const key = bearer(world.organizationKeyToken);
    const refusedId = `first-use-${id()}`;
    const refused = await governedApp.request("/v1/access/me", {
      headers: { ...key, ...externalActor(refusedId) },
    });
    expect(refused.status).toBe(403);
    const body = await json(refused);
    expect(refusalCode(body)).toBe("ORGANIZATION_GOVERNED_BY_HOST");
    expect(refusedMutation(body)).toBe("external_member.add");
    expect(await externalIdentityCount(refusedId)).toBe(0);

    // Stock provisions as before; an identity that already exists still
    // resolves when the host refuses provisioning.
    const existingId = `first-use-${id()}`;
    const stock = await stockApp.request("/v1/access/me", {
      headers: { ...key, ...externalActor(existingId) },
    });
    expect(stock.status).toBe(200);
    expect(await externalIdentityCount(existingId)).toBe(1);
    const existing = await governedApp.request("/v1/access/me", {
      headers: { ...key, ...externalActor(existingId) },
    });
    expect(existing.status).toBe(200);

    const allowedId = `first-use-${id()}`;
    const allowed = await appFor(allowAllNative).request("/v1/access/me", {
      headers: { ...key, ...externalActor(allowedId) },
    });
    expect(allowed.status).toBe(200);
    expect(await externalIdentityCount(allowedId)).toBe(1);
  }, 60_000);

  test("first-use workspace membership asks the host when it would be created", async () => {
    const key = bearer(
      await organizationKey(world.governedOrganizationId, [
        "members:manage",
        "account:admin",
        ...(EXTERNAL_FIRST_USE_MEMBER_PERMISSIONS as Permission[]),
      ]),
    );
    const grantPath = `${ws()}/access/grant`;
    const provision = async (externalId: string) => {
      const response = await stockApp.request("/v1/access/me", {
        headers: { ...key, ...externalActor(externalId) },
      });
      expect(response.status).toBe(200);
    };
    const refusedId = `member-${id()}`;
    await provision(refusedId);
    const refused = await appFor(hostPort, { externalMemberFirstUse: true }).request(grantPath, {
      headers: { ...key, ...externalActor(refusedId) },
    });
    expect(refused.status).toBe(403);
    expect(refusalCode(await json(refused))).toBe("ORGANIZATION_GOVERNED_BY_HOST");

    const allowedId = `member-${id()}`;
    await provision(allowedId);
    const allowed = await appFor(allowAllNative, { externalMemberFirstUse: true }).request(
      grantPath,
      { headers: { ...key, ...externalActor(allowedId) } },
    );
    expect(allowed.status).toBe(200);

    const stockId = `member-${id()}`;
    await provision(stockId);
    const stock = await appFor(undefined, { externalMemberFirstUse: true }).request(grantPath, {
      headers: { ...key, ...externalActor(stockId) },
    });
    expect(stock.status).toBe(200);
  }, 60_000);

  test("connecting, changing and disconnecting an MCP agent is decided by the host", async () => {
    const owner = browser(world.owner.cookie);
    const readOnly = readPolicy();
    const approve = (app: App, requestToken: string) =>
      app.request(`/v1/mcp-connections/requests/${requestToken}`, {
        method: "POST",
        headers: owner,
        body: JSON.stringify({
          decision: "approve",
          organizationId: world.governedOrganizationId,
          access: readOnly,
        }),
      });

    const pending = await startOrganizationSignIn();
    const refused = await approve(governedApp, pending.requestToken);
    expect(refused.status).toBe(403);
    const refusedBody = await json(refused);
    expect(refusalCode(refusedBody)).toBe("ORGANIZATION_GOVERNED_BY_HOST");
    expect(refusedMutation(refusedBody)).toBe("mcp_connection.create");
    // Refused before the request was bound or answered: it is still pending.
    const stillPending = await approve(stockApp, pending.requestToken);
    expect(stillPending.status).toBe(200);
    await exchangeCode(stillPending, pending);

    const allowedSignIn = await startOrganizationSignIn();
    expect((await approve(appFor(allowAllNative), allowedSignIn.requestToken)).status).toBe(200);

    const listed = (await (
      await stockApp.request(`${org()}/mcp-connections`, { headers: owner })
    ).json()) as { connections: Array<{ id: string }> };
    const connectionId = listed.connections[0]!.id;
    const connection = `${org()}/mcp-connections/${connectionId}`;
    const patch = (app: App) =>
      app.request(connection, {
        method: "PATCH",
        headers: owner,
        body: JSON.stringify({ access: readOnly }),
      });
    const refusedPatch = await patch(governedApp);
    expect(refusedPatch.status).toBe(403);
    expect(refusedMutation(await json(refusedPatch))).toBe("mcp_connection.update");
    const refusedDelete = await governedApp.request(connection, {
      method: "DELETE",
      headers: owner,
    });
    expect(refusedDelete.status).toBe(403);
    expect(refusedMutation(await json(refusedDelete))).toBe("mcp_connection.revoke");
    expect((await patch(stockApp)).status).toBe(200);
    expect(
      (await appFor(allowAllNative).request(connection, { method: "DELETE", headers: owner }))
        .status,
    ).toBe(204);
  }, 60_000);

  test("a workspace MCP sign-in is refused before a code is issued", async () => {
    const mcpClient = await registerMcpClient();
    const authorize = authorizeUrl(
      mcpClient,
      `${origin}/v1/workspaces/${world.sharedWorkspaceId}/mcp`,
    );
    const consent = await governedApp.request(authorize.pathname + authorize.search, {
      headers: { cookie: world.owner.cookie },
    });
    expect(consent.status).toBe(200);
    const requestToken = /ogmcp_req_[A-Za-z0-9_-]+/u.exec(await consent.text())?.[0];
    expect(requestToken).toBeDefined();
    const form = (app: App) =>
      app.request("/oauth/authorize", {
        method: "POST",
        headers: {
          cookie: world.owner.cookie,
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          request: requestToken!,
          decision: "approve",
          workspace_id: world.sharedWorkspaceId,
        }).toString(),
      });
    const refused = await form(governedApp);
    expect(refused.status).toBe(403);
    expect(refusedMutation(await json(refused))).toBe("mcp_connection.create");
    const stock = await form(stockApp);
    expect(stock.status).toBe(200);
    expect(stock.headers.get("refresh") ?? "").toContain("code=");
  }, 60_000);
});

type McpClient = { clientId: string; verifier: string; challenge: string };
const redirectUri = "http://127.0.0.1:4567/callback";

async function registerMcpClient(): Promise<McpClient> {
  const registered = await stockApp.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Governance agent",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { clientId, verifier, challenge };
}

function authorizeUrl(mcpClient: McpClient, resource: string): URL {
  const authorize = new URL("/oauth/authorize", origin);
  for (const [key, value] of Object.entries({
    response_type: "code",
    scope: "mcp:access",
    client_id: mcpClient.clientId,
    redirect_uri: redirectUri,
    code_challenge: mcpClient.challenge,
    code_challenge_method: "S256",
    resource,
    state: "governance-state",
  }))
    authorize.searchParams.set(key, value);
  return authorize;
}

async function startOrganizationSignIn(): Promise<McpClient & { requestToken: string }> {
  const mcpClient = await registerMcpClient();
  const authorize = authorizeUrl(mcpClient, `${origin}/v1/mcp`);
  const started = await stockApp.request(authorize.pathname + authorize.search, {
    headers: { cookie: world.owner.cookie },
  });
  expect(started.status).toBe(302);
  const requestToken = new URL(started.headers.get("location")!).searchParams.get("request")!;
  return { ...mcpClient, requestToken };
}

async function exchangeCode(approved: Response, mcpClient: McpClient): Promise<void> {
  const redirect = new URL(((await approved.json()) as { redirectTo: string }).redirectTo);
  const token = await stockApp.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: mcpClient.clientId,
      code: redirect.searchParams.get("code")!,
      code_verifier: mcpClient.verifier,
      redirect_uri: redirectUri,
      resource: `${origin}/v1/mcp`,
    }),
  });
  expect(token.status).toBe(200);
}

describe("organization governance port, final review", () => {
  test("governs must answer a boolean: a Promise-returning port fails the caller closed", async () => {
    const asyncPort = {
      governs: async () => false,
      decide: () => "allow",
    } as unknown as OrganizationGovernancePort;
    const deps = { db: client.db, organizationGovernance: asyncPort };
    const contractError = {
      name: "OrganizationGovernancePortContractError",
    };
    await expect(
      organizationGovernanceDecision(deps, {
        organizationId: world.governedOrganizationId,
        mutation: "invitation.create",
        via: "native",
      }),
    ).rejects.toMatchObject(contractError);
    await expect(
      organizationGovernedByHost(deps, world.ungovernedOrganizationId),
    ).rejects.toMatchObject(contractError);
    // Through a native route the mutation is not performed.
    const invite = await appFor(asyncPort).request(`${org()}/invitations`, {
      method: "POST",
      headers: browser(world.owner.cookie),
      body: JSON.stringify(inviteBody(`async-port-${id()}@example.test`)),
    });
    expect(invite.status).toBe(500);
  }, 60_000);
});

describe("organization recovery and workspace deletion are governed", () => {
  const allowingPort: OrganizationGovernancePort = {
    governs: ({ externalSource }) => externalSource === HOST_SOURCE,
    decide: ({ mutation, via }) => {
      decisions.push({ mutation, via });
      return "allow";
    },
  };

  async function createSharedWorkspace(): Promise<string> {
    const created = await stockApp.request(`${org()}/workspaces`, {
      method: "POST",
      headers: browser(world.owner.cookie),
      body: JSON.stringify({ name: `Disposable ${id()}`, operationId: id() }),
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as { id: string }).id;
  }

  async function workspaceExists(workspaceId: string): Promise<boolean> {
    const [row] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from workspaces where id = ${workspaceId}`;
    return row?.count === 1;
  }

  const recovery = () => recoveryRoutes();

  test("stock: recovery operations keep their own answer and no port is asked", async () => {
    for (const route of recovery()) {
      decisions.length = 0;
      const response = await requestNative(stockApp, route);
      // Legacy browser sessions have no actor fence: recovery's own 409.
      expect({ route: route.mutation, status: response.status }).toEqual({
        route: route.mutation,
        status: 409,
      });
      expect(refusalCode(await json(response))).toBeUndefined();
      expect(decisions).toEqual([]);
    }
  }, 60_000);

  test("allowed natively: recovery operations reach their own checks", async () => {
    const app = appFor(allowingPort);
    for (const route of recovery()) {
      decisions.length = 0;
      const response = await requestNative(app, route);
      expect({ route: route.mutation, status: response.status }).toEqual({
        route: route.mutation,
        status: 409,
      });
      expect(decisions).toEqual([{ mutation: route.mutation, via: "native" }]);
    }
  }, 60_000);

  test("a refused workspace deletion keeps the workspace; stock and allowed delete it", async () => {
    // The organization route also takes an organization key with workspace:admin.
    const adminKey = await organizationKey(world.governedOrganizationId, [
      "workspace:read",
      "workspace:admin",
    ]);
    type DeletePath = "organization" | "organization_key" | "workspace";
    const deleteVia = async (app: App, workspaceId: string, path: DeletePath) =>
      await app.request(
        path === "workspace"
          ? `/v1/workspaces/${workspaceId}`
          : `${org()}/workspaces/${workspaceId}`,
        {
          method: "DELETE",
          headers: path === "organization_key" ? bearer(adminKey) : browser(world.owner.cookie),
        },
      );
    for (const path of ["organization", "organization_key", "workspace"] as const) {
      const workspaceId = await createSharedWorkspace();
      decisions.length = 0;
      const refused = await deleteVia(governedApp, workspaceId, path);
      expect(refused.status).toBe(403);
      const body = await json(refused);
      expect(refusalCode(body)).toBe("ORGANIZATION_GOVERNED_BY_HOST");
      expect(refusedMutation(body)).toBe("workspace.delete");
      expect(decisions).toEqual([{ mutation: "workspace.delete", via: "native" }]);
      expect(await workspaceExists(workspaceId)).toBe(true);

      decisions.length = 0;
      const allowed = await deleteVia(appFor(allowingPort), workspaceId, path);
      expect(allowed.status).toBe(204);
      expect(decisions).toEqual([{ mutation: "workspace.delete", via: "native" }]);
      expect(await workspaceExists(workspaceId)).toBe(false);

      const stockWorkspaceId = await createSharedWorkspace();
      decisions.length = 0;
      expect((await deleteVia(stockApp, stockWorkspaceId, path)).status).toBe(204);
      expect(decisions).toEqual([]);
      expect(await workspaceExists(stockWorkspaceId)).toBe(false);
    }
  }, 120_000);
});

async function startHostWorkspaceConsent(app: App) {
  const mcpClient = await registerMcpClient();
  const url = authorizeUrl(mcpClient, `${origin}/v1/workspaces/${world.sharedWorkspaceId}/mcp`);
  const response = await app.request(url.pathname + url.search, {
    headers: { cookie: world.owner.cookie },
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  const request = /ogmcp_req_[A-Za-z0-9_-]+/u.exec(html)?.[0];
  const revision = /name="host_revision" value="([0-9]+)"/u.exec(html)?.[1];
  const digest = /name="host_digest" value="([a-f0-9]+)"/u.exec(html)?.[1];
  if (!request || !revision || !digest) throw new Error("Displayed native proposal is absent");
  const form = new URLSearchParams({
    request,
    workspace_id: world.sharedWorkspaceId,
    decision: "approve",
    access_preset: "full",
    host_revision: revision,
    host_digest: digest,
  });
  const minted = await app.request(`/v1/auth/host-token?workspace=${world.sharedWorkspaceId}`, {
    headers: { cookie: world.owner.cookie, origin },
  });
  expect(minted.status).toBe(200);
  const { token } = await minted.json();
  return {
    form,
    token: token as string,
    preflight: (overrides: Record<string, string> = {}) =>
      app.request("/oauth/authorize/host-consent", {
        method: "POST",
        headers: {
          ...browser(world.owner.cookie),
          "x-opengeni-host-consent-credential": token,
          ...overrides,
        },
        body: JSON.stringify({ form: form.toString() }),
      }),
    approve: (overrides: Record<string, string> = {}) =>
      app.request("/oauth/authorize", {
        method: "POST",
        headers: {
          ...browser(world.owner.cookie),
          "content-type": "application/x-www-form-urlencoded",
          ...overrides,
        },
        body: form,
      }),
  };
}

type HostConsentInput = Parameters<NonNullable<AppDependencies["mcpOAuthHostConsent"]>["admit"]>[0];
/** Test embedding host: real JWT/JWKS and HOST routes; no Cendra authority claim. */
async function admitWithVerifiedHumanHost(
  app: App,
  input: HostConsentInput,
  issuer = origin,
): Promise<void> {
  const { createLocalJWKSet, jwtVerify } = await import("jose");
  const keys = await (await app.request("/v1/auth/jwks")).json();
  const { payload } = await jwtVerify(input.readCredential(), createLocalJWKSet(keys), {
    issuer,
    audience: "https://host-consent.example.test",
    algorithms: ["ES256"],
  });
  const path = `/v1/host/organizations/${input.proposal.organizationId}/mcp-consent-requests/${input.proposal.requestHash}`;
  const service = await serviceToken();
  const response = await app.request(path, { headers: bearer(service) });
  if (!response.ok) throw new Error("Host proposal unavailable");
  const stored = await response.json();
  if (
    payload.purpose !== undefined ||
    payload.identity_status !== "active" ||
    payload.org !== stored.organizationId ||
    payload.ws !== stored.workspaceId ||
    payload.sub !== stored.material.human.identityId ||
    payload.sid !== stored.material.human.authSessionId ||
    payload.login_binding_id !== stored.material.human.loginBindingId ||
    payload.login_binding_revision !== stored.material.human.loginBindingRevision ||
    input.proposal.digest !== stored.digest ||
    input.proposal.revision !== stored.revision ||
    input.proposal.operationId !== stored.operationId
  )
    throw new Error("Host human/proposal binding refused");
  const admitted = await app.request(`${path}/admit`, {
    method: "POST",
    headers: bearer(service),
    body: JSON.stringify({
      actingExternalUser: { source: "test:consent", externalId: world.owner.subjectId },
      command: {
        revision: stored.revision,
        digest: stored.digest,
        operationId: stored.operationId,
      },
    }),
  });
  if (!admitted.ok) throw new Error("Host admission refused");
}

describe("governed workspace OAuth HOST consent", () => {
  test("connects explicit native approval through a real HOST admission command", async () => {
    let callbackCount = 0;
    let app: App;
    app = appFor(hostPort, {
      mcpOAuthHostConsent: {
        async admit({ proposal, readCredential }) {
          callbackCount += 1;
          const { createLocalJWKSet, jwtVerify } = await import("jose");
          const keys = await (await app.request("/v1/auth/jwks")).json();
          const verified = await jwtVerify(readCredential(), createLocalJWKSet(keys), {
            issuer: origin,
            audience: "https://host-consent.example.test",
            algorithms: ["ES256"],
          });
          expect(verified.payload.org).toBe(proposal.organizationId);
          expect(verified.payload.ws).toBe(proposal.workspaceId);
          const path = `/v1/host/organizations/${proposal.organizationId}/mcp-consent-requests/${proposal.requestHash}`;
          const service = await serviceToken();
          const canonical = await app.request(path, { headers: bearer(service) });
          expect(canonical.status).toBe(200);
          const stored = await canonical.json();
          expect(stored.material.human.identityId).toBe(verified.payload.sub);
          expect(stored.material.human.authSessionId).toBe(verified.payload.sid);
          expect(stored.material.human.loginBindingRevision).toBe(
            verified.payload.login_binding_revision,
          );
          const admitted = await app.request(`${path}/admit`, {
            method: "POST",
            headers: bearer(service),
            body: JSON.stringify({
              actingExternalUser: { source: "test:consent", externalId: world.owner.subjectId },
              command: {
                revision: stored.revision,
                digest: stored.digest,
                operationId: stored.operationId,
              },
            }),
          });
          expect(admitted.status).toBe(200);
          expect(await admitted.json()).toEqual({ outcome: "admitted" });
        },
      },
    });
    const mcpClient = await registerMcpClient();
    const resource = `${origin}/v1/workspaces/${world.sharedWorkspaceId}/mcp`;
    const url = authorizeUrl(mcpClient, resource);
    const started = await app.request(url.pathname + url.search, {
      headers: { cookie: world.owner.cookie },
    });
    expect(started.status).toBe(200);
    const html = await started.text();
    const requestToken = /ogmcp_req_[A-Za-z0-9_-]+/u.exec(html)?.[0];
    const revision = /name="host_revision" value="([0-9]+)"/u.exec(html)?.[1];
    const digest = /name="host_digest" value="([a-f0-9]+)"/u.exec(html)?.[1];
    expect(requestToken).toBeDefined();
    expect(revision).toBeDefined();
    expect(digest).toBeDefined();
    const form = new URLSearchParams({
      request: requestToken!,
      workspace_id: world.sharedWorkspaceId,
      decision: "approve",
      access_preset: "full",
      host_revision: revision!,
      host_digest: digest!,
    });
    const tokenResponse = await app.request(
      `/v1/auth/host-token?workspace=${world.sharedWorkspaceId}`,
      { headers: { cookie: world.owner.cookie, origin } },
    );
    expect(tokenResponse.status).toBe(200);
    const minted = await tokenResponse.json();
    const preflight = await app.request("/oauth/authorize/host-consent", {
      method: "POST",
      headers: {
        ...browser(world.owner.cookie),
        "x-opengeni-host-consent-credential": minted.token,
      },
      body: JSON.stringify({ form: form.toString() }),
    });
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toEqual({ outcome: "admitted" });
    expect(callbackCount).toBe(1);
    const approved = await app.request("/oauth/authorize", {
      method: "POST",
      headers: {
        ...browser(world.owner.cookie),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(approved.status).toBe(200);
    expect(approved.headers.get("refresh") ?? "").toContain("code=");
    const replay = await app.request("/oauth/authorize", {
      method: "POST",
      headers: {
        ...browser(world.owner.cookie),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(await replay.text()).not.toContain("code=");
  }, 180_000);
  test("callback allow without stored admission never issues a native code", async () => {
    let callbacks = 0;
    const app = appFor(hostPort, {
      mcpOAuthHostConsent: {
        async admit() {
          callbacks += 1;
        },
      },
    });
    const pending = await startHostWorkspaceConsent(app);
    expect((await pending.preflight()).status).toBe(503);
    expect(callbacks).toBe(1);
    expect((await pending.approve()).status).toBe(403);
  }, 60_000);

  test("scope changes visibly refresh consent and require another explicit approval", async () => {
    let callbacks = 0;
    const app = appFor(hostPort, {
      mcpOAuthHostConsent: {
        async admit() {
          callbacks += 1;
        },
      },
    });
    const pending = await startHostWorkspaceConsent(app);
    pending.form.set("access_preset", "read_only");
    const changed = await pending.preflight();
    expect(changed.status).toBe(409);
    const page = await changed.text();
    expect(page).toContain(
      "Access changed. Review the permissions and tools below, then authorize again.",
    );
    expect(page).toContain('value="read_only" checked');
    expect(page).toContain("Permissions and tools");
    expect(callbacks).toBe(0);
    expect((await pending.approve()).status).toBe(409);
    pending.form.set("host_revision", /name="host_revision" value="([0-9]+)"/u.exec(page)![1]!);
    pending.form.set("host_digest", /name="host_digest" value="([a-f0-9]+)"/u.exec(page)![1]!);
    expect((await pending.preflight()).status).toBe(503);
    expect(callbacks).toBe(1);
  }, 60_000);

  test("native service or bearer context and cross-origin requests cannot perform the browser handoff", async () => {
    let callbacks = 0;
    const app = appFor(hostPort, {
      mcpOAuthHostConsent: {
        async admit() {
          callbacks += 1;
        },
      },
    });
    const pending = await startHostWorkspaceConsent(app);
    const service = await serviceToken();
    for (const credential of [service, pending.token]) {
      expect([401, 403]).toContain(
        (await pending.preflight({ authorization: `Bearer ${credential}` })).status,
      );
      expect([401, 403]).toContain(
        (await pending.approve({ authorization: `Bearer ${credential}` })).status,
      );
    }
    expect((await pending.preflight({ origin: "https://foreign.example" })).status).toBe(403);
    expect((await pending.approve({ origin: "https://foreign.example" })).status).toBe(403);
    expect(callbacks).toBe(0);
  }, 60_000);

  test("opaque credential and credential-bearing host failures never enter native logs or errors", async () => {
    const app = appFor(hostPort, {
      structuredLogs: true,
      mcpOAuthHostConsent: {
        async admit({ readCredential }) {
          throw new Error(`host failed: ${readCredential()}`);
        },
      },
    });
    const pending = await startHostWorkspaceConsent(app);
    const logs: string[] = [];
    const originals = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...args: unknown[]) => {
      logs.push(JSON.stringify(args));
    };
    console.error = (...args: unknown[]) => {
      logs.push(JSON.stringify(args));
    };
    console.warn = (...args: unknown[]) => {
      logs.push(JSON.stringify(args));
    };
    let response: Response;
    try {
      response = await pending.preflight();
    } finally {
      Object.assign(console, originals);
    }
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(pending.token);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(pending.token);
    expect(logs.join("\n")).not.toContain("host failed:");
    expect(logs.join("\n")).not.toContain("x-opengeni-host-consent-credential");
  }, 60_000);

  test("a committed HOST admission survives response loss and preserves the same operation", async () => {
    let app: App;
    const operations: string[] = [];
    app = appFor(hostPort, {
      mcpOAuthHostConsent: {
        async admit(input) {
          operations.push(input.proposal.operationId);
          await admitWithVerifiedHumanHost(app, input);
          throw new Error(input.readCredential());
        },
      },
    });
    const pending = await startHostWorkspaceConsent(app);
    expect((await pending.preflight()).status).toBe(200);
    expect((await pending.preflight()).status).toBe(200);
    expect(operations).toHaveLength(2);
    expect(operations[1]).toBe(operations[0]);
    const approved = await pending.approve();
    expect(approved.status).toBe(200);
    expect(approved.headers.get("refresh") ?? "").toContain("code=");
    const attribution =
      await shared.admin`select count(*)::int as count from organization_host_command_attributions where account_id = ${world.governedOrganizationId} and operation_id = ${operations[0]}`;
    expect(attribution[0]!.count).toBe(1);
  }, 60_000);

  test("the test embedding host refuses registration, foreign-workspace and another-session JWTs", async () => {
    let app: App;
    app = appFor(hostPort, {
      mcpOAuthHostConsent: {
        async admit(input) {
          await admitWithVerifiedHumanHost(app, input);
        },
      },
    });
    const pending = await startHostWorkspaceConsent(app);
    const registration = await app.request("/v1/auth/host-token?purpose=registration", {
      headers: { cookie: world.owner.cookie, origin },
    });
    expect(registration.status).toBe(200);
    const foreign = await app.request(
      `/v1/auth/host-token?workspace=${world.ungovernedWorkspaceId}`,
      { headers: { cookie: world.owner.cookie, origin } },
    );
    expect(foreign.status).toBe(200);
    const signedIn = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: world.owner.email, password: "password1234" }),
    });
    const cookie = signedIn.headers
      .getSetCookie()
      .find((value) => value.includes("better-auth.session_token="))
      ?.split(";", 1)[0];
    if (!cookie) throw new Error("Second genuine browser session is absent");
    const second = await app.request(`/v1/auth/host-token?workspace=${world.sharedWorkspaceId}`, {
      headers: { cookie, origin },
    });
    expect(second.status).toBe(200);
    for (const response of [registration, foreign, second]) {
      const { token } = await response.json();
      expect(
        (await pending.preflight({ "x-opengeni-host-consent-credential": token })).status,
      ).toBe(503);
    }
    expect(
      (await pending.preflight({ "x-opengeni-host-consent-credential": await serviceToken() }))
        .status,
    ).toBe(401);
    expect((await pending.approve()).status).toBe(403);
  }, 60_000);

  test("a changed native login-binding revision invalidates a previously stored admission", async () => {
    let app: App;
    app = appFor(hostPort, {
      mcpOAuthHostConsent: {
        async admit(input) {
          await admitWithVerifiedHumanHost(app, input);
        },
      },
    });
    const pending = await startHostWorkspaceConsent(app);
    expect((await pending.preflight()).status).toBe(200);
    const [binding] =
      await shared.admin`select host_proposal->'human'->>'loginBindingId' as id from mcp_oauth_authorization_requests where request_hash = ${createHash("sha256").update(pending.form.get("request")!).digest("hex")}`;
    // A fixture-only concurrent native identity revision; this does not qualify
    // any Cendra login-binding or member-resolution policy.
    await shared.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.canonical_human_identity_lifecycle', 'active', true)`;
      await tx`update canonical_human_login_bindings set revision = revision + 1 where id = ${binding!.id}`;
    });
    expect((await pending.approve()).status).toBe(409);
  }, 60_000);
  test("browser reviews changed access and explicitly approves the real native workspace path", async () => {
    const { chromium } = await import("playwright");
    let app: App | undefined;
    let callbackCount = 0;
    let returned = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (app ? app.fetch(request) : new Response(null, { status: 503 })),
    });
    const browserOrigin = server.url.origin;
    app = appFor(hostPort, {
      publicBaseUrl: browserOrigin,
      mcpOAuthHostConsent: {
        async admit(input) {
          callbackCount += 1;
          await admitWithVerifiedHumanHost(app!, input, browserOrigin);
        },
      },
    });
    const mcpClient = await registerMcpClient();
    const authorization = authorizeUrl(
      mcpClient,
      `${browserOrigin}/v1/workspaces/${world.sharedWorkspaceId}/mcp`,
    );
    const url = new URL(authorization.pathname + authorization.search, browserOrigin);
    const browserInstance = await chromium.launch({ headless: true });
    const context = await browserInstance.newContext({ viewport: { width: 1440, height: 1000 } });
    const cookieSeparator = world.owner.cookie.indexOf("=");
    await context.addCookies([
      {
        name: world.owner.cookie.slice(0, cookieSeparator),
        value: world.owner.cookie.slice(cookieSeparator + 1),
        domain: new URL(browserOrigin).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    await page.route("http://127.0.0.1:4567/**", async (route) => {
      returned = new URL(route.request().url()).searchParams.has("code");
      await route.fulfill({ status: 200, contentType: "text/plain", body: "Connected" });
    });
    try {
      await page.goto(url.toString());
      await page.getByRole("heading", { name: "Authorize this client" }).waitFor();
      expect(callbackCount).toBe(0);
      await page.screenshot({ path: "/tmp/q15-native-consent-1440.png", fullPage: true });
      await page.getByRole("radio", { name: "Read only", exact: false }).check();
      await page.getByRole("button", { name: "Authorize", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Access changed" })
        .waitFor({ timeout: 5000 });
      expect(callbackCount).toBe(0);
      expect(await page.getByRole("radio", { name: "Read only", exact: false }).isChecked()).toBe(
        true,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: "/tmp/q15-native-consent-review-390.png", fullPage: true });
      await page.getByRole("button", { name: "Authorize", exact: true }).click();
      await page.getByText("Connected", { exact: true }).waitFor({ timeout: 5000 });
      expect(callbackCount).toBe(1);
      expect(returned).toBe(true);
    } finally {
      await context.close();
      await browserInstance.close();
      await server.stop(true);
    }
  }, 60_000);

  test("a changed live tool catalog invalidates the admitted proposal before native issuance", async () => {
    let app: App;
    let version = "v1";
    let callbacks = 0;
    app = appFor(hostPort, {
      workspaceToolServers: async () => [
        {
          id: "consent-tools",
          toolSetVersion: version,
          server: {
            name: "host:consent-tools",
            cacheToolsList: false,
            connect: async () => {},
            close: async () => {},
            listTools: async () => [
              {
                name: version === "v1" ? "read_record" : "read_new",
                description: "Read a fixture record",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
            callTool: async () => [{ type: "text", text: "fixture" }],
            invalidateToolsCache: async () => {},
          },
        },
      ],
      mcpOAuthHostConsent: {
        async admit(input) {
          callbacks += 1;
          await admitWithVerifiedHumanHost(app, input);
        },
      },
    });
    const pending = await startHostWorkspaceConsent(app);
    expect((await pending.preflight()).status).toBe(200);
    version = "v2";
    expect((await pending.approve()).status).toBe(409);
    const refreshed = await pending.preflight();
    expect(refreshed.status).toBe(409);
    expect(await refreshed.text()).toContain("read_new");
    expect(callbacks).toBe(1);
    const [row] =
      await shared.admin`select host_admitted_at, host_proposal->'toolSetVersions'->>'consent-tools' as version from mcp_oauth_authorization_requests where request_hash = ${createHash("sha256").update(pending.form.get("request")!).digest("hex")}`;
    expect(row!.host_admitted_at).toBeNull();
    expect(row!.version).toBe("v2");
  }, 60_000);

  test("cancellation during the host handoff leaves no consumable request", async () => {
    let app: App;
    let pending: Awaited<ReturnType<typeof startHostWorkspaceConsent>>;
    app = appFor(hostPort, {
      mcpOAuthHostConsent: {
        async admit() {
          const form = new URLSearchParams(pending.form);
          form.set("decision", "deny");
          const denied = await app.request("/oauth/authorize", {
            method: "POST",
            headers: {
              ...browser(world.owner.cookie),
              "content-type": "application/x-www-form-urlencoded",
            },
            body: form,
          });
          expect(denied.status).toBe(200);
        },
      },
    });
    pending = await startHostWorkspaceConsent(app);
    expect((await pending.preflight()).status).toBe(503);
    expect((await pending.approve()).status).toBe(400);
  }, 60_000);
  test("HOST consent path validation stays behind service authentication and returns a client refusal", async () => {
    const app = appFor(hostPort);
    const path = `/v1/host/organizations/${world.governedOrganizationId}/mcp-consent-requests/not-a-hash`;
    expect((await app.request(path)).status).toBe(401);
    const service = await serviceToken();
    expect((await app.request(path, { headers: bearer(service) })).status).toBe(422);
    expect(
      (await app.request(`${path}/admit`, { method: "POST", headers: bearer(service), body: "{}" }))
        .status,
    ).toBe(422);
    const pending = await startHostWorkspaceConsent(
      appFor(hostPort, { mcpOAuthHostConsent: { async admit() {} } }),
    );
    expect((await app.request(path, { headers: bearer(pending.token) })).status).toBe(401);
  }, 60_000);
});
