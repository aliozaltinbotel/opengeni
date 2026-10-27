import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { OrganizationGovernancePort } from "@opengeni/contracts/organization-governance";
import type {
  AppDependencies,
  ManagedEmailDeliveryResult,
  ManagedEmailMessage,
} from "@opengeni/core";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import { getCanonicalHumanIdentityProjection } from "@opengeni/db/canonical-human-identities";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * A host provisions its organizations out of band with bootstrapWorkspace,
 * naming one service subject, and then governs them with host commands signed
 * for that subject. Host commands and reads run as that subject, checked like
 * any administrator, so the subject must be the organization's owner:
 * bootstrapWorkspace makes it the owner of a new organization, and an
 * organization bootstrapped before that gets its owner through the host's
 * ensure command, which only ever makes the token's own subject the owner of
 * the token's own organization.
 */

const origin = "http://opengeni.test";
const delegationSecret = "host-organization-owner-delegation-secret-32b";
const HOST_SOURCE = "test-host:tenant";
const ENSURE_ROUTINE = "opengeni_private.ensure_organization_host_owner(uuid, text, uuid)";
const actingExternalUser = { source: "test-host:user", externalId: "staff-7" };

let shared: SharedTestDatabase;
let client: DbClient;
const managedEmailTransport = {
  sender: "Opengeni <auth@mail.opengeni.ai>",
  idempotency: { scope: "test-provider-v1:host-organization-owner", retentionSeconds: 86_400 },
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
type HostOrganization = { organizationId: string; workspaceId: string; subjectId: string };
type MembershipRow = {
  id: string;
  subject_id: string;
  role: string;
  status: string;
  authorization_revision: string;
  personal_workspace_id: string | null;
  updated_at: Date;
};

function appFor(organizationGovernance?: OrganizationGovernancePort): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "host-organization-owner-secret-32-bytes-long",
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

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

async function setEnsureGrant(granted: boolean): Promise<void> {
  await shared.admin.unsafe(
    `${granted ? "GRANT" : "REVOKE"} EXECUTE ON FUNCTION ${ENSURE_ROUTINE} ${granted ? "TO" : "FROM"} opengeni_app`,
  );
  const [row] = await shared.admin<{ granted: boolean | null }[]>`
    select has_function_privilege('opengeni_app', to_regprocedure(${ENSURE_ROUTINE})::oid,
      'EXECUTE') as granted`;
  expect(row?.granted === true).toBe(granted);
}

/** An organization the host provisions with bootstrapWorkspace for its own subject. */
async function bootstrapHostOrganization(source = HOST_SOURCE): Promise<HostOrganization> {
  const tenant = crypto.randomUUID();
  const subjectId = `test-host:provisioner:${tenant}`;
  const context = await bootstrapWorkspace(client.db, {
    accountExternalSource: source,
    accountExternalId: tenant,
    accountName: `Tenant ${tenant}`,
    workspaceExternalSource: source,
    workspaceExternalId: tenant,
    workspaceName: `Workspace ${tenant}`,
    subjectId,
    subjectLabel: "Host provisioner",
  });
  return {
    organizationId: context.defaultAccountId!,
    workspaceId: context.defaultWorkspaceId!,
    subjectId,
  };
}

async function hostToken(
  organization: HostOrganization,
  subjectId = organization.subjectId,
  workspaceId = organization.workspaceId,
): Promise<string> {
  return await signDelegatedAccessToken(delegationSecret, {
    accountId: organization.organizationId,
    workspaceId,
    subjectId,
    permissions: ["members:manage"],
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: "test-host:governance" },
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

async function ensureOwner(
  app: App,
  organization: HostOrganization,
  options: { token?: string; body?: unknown; operationId?: string } = {},
): Promise<Response> {
  return await app.request(
    `/v1/host/organizations/${organization.organizationId}/host-owner/ensure`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token ?? (await hostToken(organization))}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        options.body ?? {
          actingExternalUser,
          command: { operationId: options.operationId ?? crypto.randomUUID() },
        },
      ),
    },
  );
}

async function membershipsOf(organizationId: string): Promise<MembershipRow[]> {
  return await shared.admin<MembershipRow[]>`
    select id, subject_id, role, status, authorization_revision, personal_workspace_id, updated_at
    from organization_memberships where account_id = ${organizationId}
    order by created_at, id`;
}

async function signUp(app: App, name: string, email: string): Promise<Person> {
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
  };
}

async function hostInvite(organization: HostOrganization, email: string): Promise<Response> {
  return await governedApp.request(
    `/v1/host/organizations/${organization.organizationId}/invitations`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await hostToken(organization)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actingExternalUser,
        command: {
          email,
          role: "member",
          initialWorkspaceIds: [organization.workspaceId],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          operationId: crypto.randomUUID(),
        },
      }),
    },
  );
}

/** A person the host invites, who signs up and accepts natively. */
async function invitedMember(organization: HostOrganization): Promise<Person> {
  const email = `${crypto.randomUUID()}@example.test`;
  const invited = await hostInvite(organization, email);
  expect(invited.status).toBe(201);
  const member = await signUp(governedApp, "Invited member", email);
  const listed = await governedApp.request("/v1/organization-invitations", {
    headers: browser(member.cookie),
  });
  const { invitations } = (await listed.json()) as {
    invitations: { id: string; revision: number }[];
  };
  expect(invitations).toHaveLength(1);
  const accepted = await governedApp.request(
    `/v1/organization-invitations/${invitations[0]!.id}/accept`,
    {
      method: "POST",
      headers: browser(member.cookie),
      body: JSON.stringify({
        expectedRevision: invitations[0]!.revision,
        operationId: crypto.randomUUID(),
      }),
    },
  );
  expect(accepted.status).toBe(200);
  return member;
}

async function lookup(organization: HostOrganization, identityId: string): Promise<Response> {
  return await governedApp.request(
    `/v1/host/organizations/${organization.organizationId}/identities/lookup`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await hostToken(organization)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ identityId }),
    },
  );
}

async function identityIdOf(person: Person): Promise<string> {
  return (await getCanonicalHumanIdentityProjection(client.db, person.userId)).activeIdentity.id;
}

function detailCode(body: unknown): string | undefined {
  return (body as { error?: { details?: { code?: string } } }).error?.details?.code;
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-organization-owner");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  stockApp = appFor();
  governedApp = appFor(hostPort);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("bootstrapWorkspace makes the host's subject the owner of a new organization", () => {
  test("a freshly bootstrapped organization accepts the host's commands and lookup", async () => {
    await setEnsureGrant(true);
    const organization = await bootstrapHostOrganization();
    const [owner, ...others] = await membershipsOf(organization.organizationId);
    expect(others).toEqual([]);
    expect(owner).toMatchObject({
      subject_id: organization.subjectId,
      role: "owner",
      status: "active",
    });
    // An active membership always has its (hidden) Personal workspace; it is
    // never the organization's shared workspace.
    expect(owner!.personal_workspace_id).not.toBeNull();
    expect(owner!.personal_workspace_id).not.toBe(organization.workspaceId);
    const member = await invitedMember(organization);
    const response = await lookup(organization, await identityIdOf(member));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { memberships: { id: string; status: string }[] };
    expect(body.memberships.map((membership) => membership.status)).toEqual(["active"]);
  }, 180_000);

  test("bootstrapping an existing organization again adds no owner", async () => {
    await setEnsureGrant(false);
    const organization = await bootstrapHostOrganization();
    await setEnsureGrant(true);
    const again = await bootstrapWorkspace(client.db, {
      accountExternalSource: HOST_SOURCE,
      accountExternalId: organization.subjectId.slice("test-host:provisioner:".length),
      accountName: "Renamed tenant",
      workspaceExternalSource: HOST_SOURCE,
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Second workspace",
      subjectId: organization.subjectId,
    });
    expect(again.defaultAccountId).toBe(organization.organizationId);
    expect(await membershipsOf(organization.organizationId)).toEqual([]);
  }, 60_000);

  test("the stock local, configured and managed sources keep their own membership story", async () => {
    await setEnsureGrant(true);
    for (const source of ["opengeni:configured", "better-auth:user"]) {
      const organization = await bootstrapHostOrganization(source);
      expect(await membershipsOf(organization.organizationId)).toEqual([]);
    }
  }, 60_000);

  test("until the routine is granted, a new organization gets no owner", async () => {
    await setEnsureGrant(false);
    const organization = await bootstrapHostOrganization();
    expect(await membershipsOf(organization.organizationId)).toEqual([]);
  }, 60_000);
});

describe("the host ensures its owner in an organization bootstrapped earlier", () => {
  let legacy: HostOrganization;
  let member: Person;
  let firstOperationId: string;
  let ownerMembershipId: string;

  beforeAll(async () => {
    await setEnsureGrant(false);
    legacy = await bootstrapHostOrganization();
    await setEnsureGrant(true);
  }, 60_000);

  test("its host lookup and commands are refused before ensure, and answer after", async () => {
    const before = await lookup(legacy, crypto.randomUUID());
    expect(before.status).toBe(403);
    expect(detailCode(await before.json())).toBe("HOST_COMMAND_ACTOR_NOT_AUTHORIZED");
    const invite = await hostInvite(legacy, `${crypto.randomUUID()}@example.test`);
    expect(invite.status).toBe(403);
    expect(detailCode(await invite.json())).toBe("HOST_COMMAND_ACTOR_NOT_AUTHORIZED");

    firstOperationId = crypto.randomUUID();
    const ensured = await ensureOwner(governedApp, legacy, { operationId: firstOperationId });
    expect(ensured.status).toBe(200);
    expect(ensured.headers.get("cache-control")).toBe("no-store");
    const body = (await ensured.json()) as {
      membershipId: string;
      subjectId: string;
      created: boolean;
    };
    const [owner, ...others] = await membershipsOf(legacy.organizationId);
    expect(others).toEqual([]);
    expect(owner).toMatchObject({ subject_id: legacy.subjectId, role: "owner", status: "active" });
    expect(body).toEqual({ membershipId: owner!.id, subjectId: legacy.subjectId, created: true });
    ownerMembershipId = owner!.id;

    member = await invitedMember(legacy);
    const after = await lookup(legacy, await identityIdOf(member));
    expect(after.status).toBe(200);
    // The first host command is where the organization learns it is governed.
    const [preferences] = await shared.admin<{ personal_workspaces_enabled: boolean }[]>`
      select personal_workspaces_enabled from organization_privacy_preferences
      where account_id = ${legacy.organizationId}`;
    expect(preferences?.personal_workspaces_enabled).toBe(false);
  }, 180_000);

  test("ensure is idempotent, audited, and touches no other member", async () => {
    const before = await membershipsOf(legacy.organizationId);
    expect(before.map((row) => row.subject_id)).toEqual([legacy.subjectId, member.subjectId]);
    for (const operationId of [crypto.randomUUID(), firstOperationId]) {
      const response = await ensureOwner(governedApp, legacy, { operationId });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        membershipId: ownerMembershipId,
        subjectId: legacy.subjectId,
        created: false,
      });
    }
    expect(await membershipsOf(legacy.organizationId)).toEqual(before);
    const attributions = await shared.admin<
      {
        operation_id: string;
        mutation: string;
        service_subject_id: string;
        acting_external_source: string;
        acting_external_id: string;
      }[]
    >`
      select operation_id, mutation, service_subject_id, acting_external_source, acting_external_id
      from organization_host_command_attributions
      where account_id = ${legacy.organizationId} and mutation = 'host_owner.ensure'`;
    expect(attributions).toHaveLength(2);
    for (const attribution of attributions)
      expect(attribution).toMatchObject({
        mutation: "host_owner.ensure",
        service_subject_id: legacy.subjectId,
        acting_external_source: actingExternalUser.source,
        acting_external_id: actingExternalUser.externalId,
      });
    // The same operation id for another acting user is a different command.
    const reused = await ensureOwner(governedApp, legacy, {
      body: {
        actingExternalUser: { source: "test-host:user", externalId: "someone-else" },
        command: { operationId: firstOperationId },
      },
    });
    expect(reused.status).toBe(409);
    expect(detailCode(await reused.json())).toBe("HOST_COMMAND_OPERATION_CONFLICT");
  }, 120_000);

  test("ensure cannot target another organization or another subject", async () => {
    await setEnsureGrant(false);
    const other = await bootstrapHostOrganization();
    await setEnsureGrant(true);
    const before = await membershipsOf(legacy.organizationId);

    // The other organization's token, at this organization's path.
    const crossOrganization = await ensureOwner(governedApp, legacy, {
      token: await hostToken(other),
    });
    expect(crossOrganization.status).toBe(401);
    expect(detailCode(await crossOrganization.json())).toBe("HOST_COMMAND_SERVICE_TOKEN_REQUIRED");
    expect(await membershipsOf(other.organizationId)).toEqual([]);

    // The subject is the token's alone: the body cannot name one.
    const named = await ensureOwner(governedApp, other, {
      body: {
        actingExternalUser,
        command: { operationId: crypto.randomUUID(), subjectId: "test-host:someone" },
      },
    });
    expect(named.status).toBe(422);

    // A token for this organization whose subject the host never bootstrapped
    // it for, and one whose subject is an identity-backed member.
    for (const subjectId of [other.subjectId, `test-host:provisioner:${crypto.randomUUID()}`]) {
      const refused = await ensureOwner(governedApp, legacy, {
        token: await hostToken(legacy, subjectId),
      });
      expect(refused.status).toBe(403);
      expect(detailCode(await refused.json())).toBe("HOST_COMMAND_ACTOR_NOT_AUTHORIZED");
    }
    const memberToken = await hostToken(legacy, member.subjectId);
    const memberRefused = await ensureOwner(governedApp, legacy, { token: memberToken });
    expect(memberRefused.status).toBe(403);
    expect(detailCode(await memberRefused.json())).toBe("HOST_COMMAND_ACTOR_NOT_AUTHORIZED");

    expect(await membershipsOf(legacy.organizationId)).toEqual(before);
    expect(await membershipsOf(other.organizationId)).toEqual([]);
  }, 120_000);

  test("a membership of the subject that is not an active owner is never promoted", async () => {
    const organization = await bootstrapHostOrganization();
    const [owner] = await membershipsOf(organization.organizationId);
    for (const change of ["role = 'admin'", "status = 'suspended'"]) {
      await shared.admin.unsafe(
        `update organization_memberships set role = 'owner', status = 'active' where id = '${owner!.id}'`,
      );
      await shared.admin.unsafe(
        `update organization_memberships set ${change} where id = '${owner!.id}'`,
      );
      const before = await membershipsOf(organization.organizationId);
      const refused = await ensureOwner(governedApp, organization);
      expect(refused.status).toBe(409);
      expect(detailCode(await refused.json())).toBe("HOST_ORGANIZATION_OWNER_CONFLICT");
      expect(await membershipsOf(organization.organizationId)).toEqual(before);
    }
  }, 120_000);
});

describe("ensure refusals", () => {
  test("until the routine is granted, ensure answers not yet and writes nothing", async () => {
    await setEnsureGrant(false);
    const organization = await bootstrapHostOrganization();
    const response = await ensureOwner(governedApp, organization);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { retryable: boolean } };
    expect(detailCode(body)).toBe("HOST_ORGANIZATION_OWNER_UNAVAILABLE");
    expect(body.error.retryable).toBe(true);
    expect(await membershipsOf(organization.organizationId)).toEqual([]);
    const [attributions] = await shared.admin<{ count: string }[]>`
      select count(*) from organization_host_command_attributions
      where account_id = ${organization.organizationId}`;
    expect(Number(attributions!.count)).toBe(0);
    await setEnsureGrant(true);
  }, 60_000);

  test("an organization the host does not govern is refused", async () => {
    await setEnsureGrant(false);
    const organization = await bootstrapHostOrganization("test-host:ungoverned");
    await setEnsureGrant(true);
    const refused = await ensureOwner(governedApp, organization);
    expect(refused.status).toBe(403);
    expect(detailCode(await refused.json())).toBe("ORGANIZATION_NOT_HOST_GOVERNED");
    expect(await membershipsOf(organization.organizationId)).toEqual([]);
  }, 60_000);

  test("stock: without a port there is no ensure route", async () => {
    await setEnsureGrant(false);
    const organization = await bootstrapHostOrganization();
    await setEnsureGrant(true);
    expect((await ensureOwner(stockApp, organization)).status).toBe(404);
    expect(await membershipsOf(organization.organizationId)).toEqual([]);
  }, 60_000);
});
