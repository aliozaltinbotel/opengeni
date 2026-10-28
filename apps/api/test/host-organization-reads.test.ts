import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { OrganizationGovernancePort } from "@opengeni/contracts/organization-governance";
import type {
  AppDependencies,
  ManagedEmailDeliveryResult,
  ManagedEmailMessage,
} from "@opengeni/core";
import {
  organizationAccessPresetPermissions,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import {
  consumeMcpOAuthAuthorizationRequest,
  createAdditionalManagedOrganization,
  createDb,
  createManagedOrganization,
  createMcpOAuthAuthorizationRequest,
  exchangeMcpOAuthAuthorizationCode,
  revokeOrganizationMcpConnection,
  type DbClient,
} from "@opengeni/db";
import { getCanonicalHumanIdentityProjection } from "@opengeni/db/canonical-human-identities";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * A host keeps its own record of the people it linked to native memberships.
 * Before acting on one it reads the membership back with its service token:
 * where it stands (any status), its fences and its shared-workspace grants.
 * The read answers only for this organization's memberships; one elsewhere
 * looks exactly like one that does not exist.
 */

const origin = "http://opengeni.test";
const delegationSecret = "host-organization-reads-delegation-secret-32b";
const HOST_SOURCE = "test-host:tenant";
const actingExternalUser = { source: "test-host:user", externalId: "staff-21" };

let shared: SharedTestDatabase;
let client: DbClient;
const managedEmailTransport = {
  sender: "Opengeni <auth@mail.opengeni.ai>",
  idempotency: { scope: "test-provider-v1:host-organization-reads", retentionSeconds: 86_400 },
  send: async (_message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult> => ({
    status: "sent",
    providerMessageId: `message-${crypto.randomUUID()}`,
  }),
};

const hostPort: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: ({ via }) => (via === "host" ? "allow" : "refuse"),
};

type App = ReturnType<typeof createApp>;
type Person = { cookie: string; email: string; userId: string; subjectId: string };
type HostOrganization = { organizationId: string; businessWorkspaceId: string };

function appFor(organizationGovernance?: OrganizationGovernancePort): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "host-organization-reads-secret-32-bytes-long",
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
async function hostOrganization(): Promise<HostOrganization> {
  const created = await createAdditionalManagedOrganization(client.db, {
    subjectId: owner.subjectId,
    subjectLabel: owner.email,
    name: "Business organization",
    workspaceName: "Business workspace",
    operationId: crypto.randomUUID(),
  });
  await shared.admin`
    update managed_accounts set external_source = ${HOST_SOURCE}, external_id = ${crypto.randomUUID()}
    where id = ${created.organization.id}`;
  return { organizationId: created.organization.id, businessWorkspaceId: created.workspaceId };
}

async function hostToken(organization: HostOrganization): Promise<string> {
  return await signDelegatedAccessToken(delegationSecret, {
    accountId: organization.organizationId,
    workspaceId: organization.businessWorkspaceId,
    subjectId: owner.subjectId,
    permissions: ["members:manage"] as never,
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: "test-host:governance" },
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

async function hostCommand(
  organization: HostOrganization,
  path: string,
  command: Record<string, unknown>,
): Promise<Response> {
  return await governedApp.request(`/v1/host/organizations/${organization.organizationId}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await hostToken(organization)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ actingExternalUser, command }),
  });
}

/** A new person invited by a host command into the business workspace, who accepts. */
async function invitedMember(organization: HostOrganization): Promise<Person> {
  const email = `${crypto.randomUUID()}@example.test`;
  const invited = await hostCommand(organization, "/invitations", {
    email,
    role: "member",
    initialWorkspaceIds: [organization.businessWorkspaceId],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    operationId: crypto.randomUUID(),
  });
  expect(invited.status).toBe(201);
  const member = await signUp(governedApp, "Business member", email);
  const listed = await governedApp.request("/v1/organization-invitations", {
    headers: browser(member.cookie),
  });
  const { invitations } = (await listed.json()) as {
    invitations: { id: string; revision: number }[];
  };
  for (const invitation of invitations) {
    const accepted = await governedApp.request(
      `/v1/organization-invitations/${invitation.id}/accept`,
      {
        method: "POST",
        headers: browser(member.cookie),
        body: JSON.stringify({
          expectedRevision: invitation.revision,
          operationId: crypto.randomUUID(),
        }),
      },
    );
    expect(accepted.status).toBe(200);
  }
  return member;
}

async function membershipOf(organizationId: string, subjectId: string) {
  const [row] = await shared.admin<
    { id: string; authorization_revision: string; updated_at: Date }[]
  >`
    select id, authorization_revision, updated_at from organization_memberships
    where account_id = ${organizationId} and subject_id = ${subjectId}`;
  return {
    id: row!.id,
    authorizationRevision: Number(row!.authorization_revision),
    updatedAt: row!.updated_at,
  };
}

/** Offboard a member through the host's own command. */
async function offboard(organization: HostOrganization, person: Person): Promise<void> {
  const membership = await membershipOf(organization.organizationId, person.subjectId);
  const response = await hostCommand(organization, `/members/${membership.id}/offboard`, {
    expectedAuthorizationRevision: membership.authorizationRevision,
    operationId: crypto.randomUUID(),
  });
  expect(response.status).toBe(200);
}

async function hostRead(
  organization: HostOrganization,
  path: string,
  token: string | null,
): Promise<Response> {
  return await governedApp.request(`/v1/host/organizations/${organization.organizationId}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function detailCode(body: unknown): string | undefined {
  return (body as { error?: { details?: { code?: string } } }).error?.details?.code;
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-organization-reads");
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

describe("the host reads back one of its organization's memberships", () => {
  let first: HostOrganization;
  let second: HostOrganization;
  let member: Person;
  let ended: Person;

  beforeAll(async () => {
    first = await hostOrganization();
    second = await hostOrganization();
    member = await invitedMember(first);
    ended = await invitedMember(first);
    await offboard(first, ended);
  }, 180_000);

  test("an active member answers its identity, fences and shared-workspace access", async () => {
    const membership = await membershipOf(first.organizationId, member.subjectId);
    const response = await hostRead(first, `/members/${membership.id}`, await hostToken(first));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown> & { updatedAt: string };
    const identity = (await getCanonicalHumanIdentityProjection(client.db, member.userId))
      .activeIdentity;
    const [access] = await shared.admin<{ id: string; updatedAt: string }[]>`
      select id, to_jsonb(updated_at) #>> '{}' as "updatedAt" from workspace_memberships
      where workspace_id = ${first.businessWorkspaceId} and subject_id = ${member.subjectId}`;
    expect(body).toEqual({
      membershipId: membership.id,
      organizationId: first.organizationId,
      userId: member.userId,
      identityId: identity.id,
      status: "active",
      role: "member",
      authorizationRevision: membership.authorizationRevision,
      sharedWorkspaceAccess: [
        {
          workspaceId: first.businessWorkspaceId,
          membershipId: access!.id,
          role: "member",
          permissions: expect.any(Array),
          updatedAt: access!.updatedAt,
        },
      ],
      updatedAt: body.updatedAt,
    });
    expect(new Date(body.updatedAt).getTime()).toBe(membership.updatedAt.getTime());
  }, 60_000);

  test("an offboarded member answers its status, not a 404", async () => {
    const membership = await membershipOf(first.organizationId, ended.subjectId);
    const response = await hostRead(first, `/members/${membership.id}`, await hostToken(first));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      sharedWorkspaceAccess: unknown[];
      authorizationRevision: number;
    };
    expect(body.status).toBe("revoked");
    expect(body.sharedWorkspaceAccess).toEqual([]);
    expect(body.authorizationRevision).toBe(membership.authorizationRevision);
  }, 60_000);

  test("a member of another organization and an unknown one get the same 404", async () => {
    const membership = await membershipOf(first.organizationId, member.subjectId);
    const elsewhere = await hostRead(second, `/members/${membership.id}`, await hostToken(second));
    const unknown = await hostRead(
      second,
      `/members/${crypto.randomUUID()}`,
      await hostToken(second),
    );
    for (const response of [elsewhere, unknown]) {
      expect(response.status).toBe(404);
      expect(detailCode(await response.json())).toBe("HOST_MEMBER_NOT_IN_ORGANIZATION");
    }
  }, 60_000);

  test("without a service token the read is refused", async () => {
    const membership = await membershipOf(first.organizationId, member.subjectId);
    for (const token of [null, "not-a-service-token"]) {
      const response = await hostRead(first, `/members/${membership.id}`, token);
      expect(response.status).toBe(401);
      expect(detailCode(await response.json())).toBe("HOST_COMMAND_SERVICE_TOKEN_REQUIRED");
    }
  }, 60_000);
});

const mcpClientId = `ogmcp_client_${crypto.randomUUID()}`;
const mcpRedirectUri = "http://127.0.0.1:4567/callback";
const tokenHash = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);
const readOnlyEverywhere: OrganizationAccessPolicy = {
  preset: "read_only",
  permissions: organizationAccessPresetPermissions("read_only"),
  workspaceScope: { kind: "all" },
};

/**
 * A person's MCP sign-in, as the OAuth flow stores it: an organization
 * connection with an access setting, or a workspace connection with
 * permissions. Its id is the refresh-token family.
 */
async function connect(
  organization: HostOrganization,
  person: Person,
  bound: { organizationAccess: OrganizationAccessPolicy } | { workspaceId: string },
): Promise<string> {
  const requestHash = tokenHash();
  const resource =
    "workspaceId" in bound
      ? `${origin}/v1/workspaces/${bound.workspaceId}/mcp`
      : `${origin}/v1/mcp`;
  await createMcpOAuthAuthorizationRequest(client.db, {
    requestHash,
    clientId: mcpClientId,
    accountId: organization.organizationId,
    workspaceId: "workspaceId" in bound ? bound.workspaceId : null,
    subjectId: person.subjectId,
    resource,
    redirectUri: mcpRedirectUri,
    codeChallenge: "c".repeat(43),
    state: null,
    permissions: "workspaceId" in bound ? ["workspace:read", "sessions:read"] : [],
    toolIdentities: [],
    organizationAccess: "organizationAccess" in bound ? bound.organizationAccess : null,
    expiresAt: inDays(1),
  });
  const codeHash = tokenHash();
  expect(
    await consumeMcpOAuthAuthorizationRequest(client.db, {
      requestHash,
      subjectId: person.subjectId,
      codeHash,
      codeExpiresAt: inDays(1),
    }),
  ).not.toBeNull();
  const exchanged = await exchangeMcpOAuthAuthorizationCode(client.db, {
    codeHash,
    clientId: mcpClientId,
    redirectUri: mcpRedirectUri,
    resource,
    codeChallenge: "c".repeat(43),
    accessTokenHash: tokenHash(),
    refreshTokenHash: tokenHash(),
    accessExpiresAt: inDays(1),
    refreshExpiresAt: inDays(30),
  });
  return exchanged!.refreshFamilyId;
}

type ConnectionBody = {
  connectionId: string;
  organizationId: string;
  workspaceId: string | null;
  clientId: string;
  status: string;
  reason: string | null;
  consentScope: unknown;
  revokedAt: string | null;
  updatedAt: string;
};

async function readConnection(
  organization: HostOrganization,
  connectionId: string,
): Promise<{ status: number; body: ConnectionBody }> {
  const response = await hostRead(
    organization,
    `/mcp-connections/${connectionId}`,
    await hostToken(organization),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, body: (await response.json()) as ConnectionBody };
}

describe("the host reads back one of its organization's MCP connections", () => {
  let first: HostOrganization;
  let second: HostOrganization;
  let member: Person;
  let leaver: Person;

  beforeAll(async () => {
    await shared.admin`insert into mcp_oauth_clients (
      client_id, redirect_uris, client_name, grant_types, response_types, registration_scope_hash,
      expires_at
    ) values (
      ${mcpClientId}, ${shared.admin.json([mcpRedirectUri])}, 'Outside agent',
      ${shared.admin.json(["authorization_code", "refresh_token"])},
      ${shared.admin.json(["code"])}, ${"5".repeat(64)}, ${inDays(30)}
    )`;
    first = await hostOrganization();
    second = await hostOrganization();
    member = await invitedMember(first);
    leaver = await invitedMember(first);
  }, 180_000);

  test("an active organization connection answers its consent and no reason", async () => {
    const connectionId = await connect(first, member, { organizationAccess: readOnlyEverywhere });
    const { status, body } = await readConnection(first, connectionId);
    expect(status).toBe(200);
    expect(body).toEqual({
      connectionId,
      organizationId: first.organizationId,
      workspaceId: null,
      clientId: mcpClientId,
      status: "active",
      reason: null,
      consentScope: readOnlyEverywhere,
      revokedAt: null,
      updatedAt: body.updatedAt,
    });
  }, 60_000);

  test("an active workspace connection answers its one workspace", async () => {
    const connectionId = await connect(first, member, { workspaceId: first.businessWorkspaceId });
    const { status, body } = await readConnection(first, connectionId);
    expect(status).toBe(200);
    expect(body.status).toBe("active");
    expect(body.workspaceId).toBe(first.businessWorkspaceId);
    expect(body.consentScope).toEqual({
      preset: null,
      permissions: ["workspace:read", "sessions:read"],
      workspaceScope: { kind: "selected", workspaceIds: [first.businessWorkspaceId] },
    });
  }, 60_000);

  test("a disconnected connection answers revoked, with when", async () => {
    const connectionId = await connect(first, member, { organizationAccess: readOnlyEverywhere });
    expect(
      await revokeOrganizationMcpConnection(client.db, {
        accountId: first.organizationId,
        connectionId,
      }),
    ).toBe(true);
    const { status, body } = await readConnection(first, connectionId);
    expect(status).toBe(200);
    expect(body.status).toBe("revoked");
    expect(body.reason).toBe("revoked");
    const [row] = await shared.admin<{ revoked_at: Date }[]>`
      select revoked_at from mcp_oauth_refresh_tokens
      where family_id = ${connectionId} order by generation desc limit 1`;
    expect(body.revokedAt).toBe(row!.revoked_at.toISOString());
    expect(body.updatedAt).toBe(row!.revoked_at.toISOString());
  }, 60_000);

  test("a connection whose member was offboarded is not live", async () => {
    const organizationConnection = await connect(first, leaver, {
      organizationAccess: readOnlyEverywhere,
    });
    const workspaceConnection = await connect(first, leaver, {
      workspaceId: first.businessWorkspaceId,
    });
    for (const connectionId of [organizationConnection, workspaceConnection])
      expect((await readConnection(first, connectionId)).body.status).toBe("active");
    await offboard(first, leaver);
    for (const connectionId of [organizationConnection, workspaceConnection]) {
      const { status, body } = await readConnection(first, connectionId);
      expect(status).toBe(200);
      expect({ status: body.status, reason: body.reason, revokedAt: body.revokedAt }).toEqual({
        status: "revoked",
        reason: "membership_not_live",
        revokedAt: null,
      });
    }
  }, 60_000);

  test("another organization's connection and an unknown one get the same 404", async () => {
    const connectionId = await connect(first, member, { organizationAccess: readOnlyEverywhere });
    for (const id of [connectionId, crypto.randomUUID()]) {
      const { status, body } = await readConnection(second, id);
      expect(status).toBe(404);
      expect(detailCode(body)).toBe("HOST_MCP_CONNECTION_NOT_IN_ORGANIZATION");
    }
  }, 60_000);

  test("without a service token the read is refused", async () => {
    const connectionId = await connect(first, member, { organizationAccess: readOnlyEverywhere });
    for (const token of [null, "not-a-service-token"]) {
      const response = await hostRead(first, `/mcp-connections/${connectionId}`, token);
      expect(response.status).toBe(401);
      expect(detailCode(await response.json())).toBe("HOST_COMMAND_SERVICE_TOKEN_REQUIRED");
    }
  }, 60_000);
});
