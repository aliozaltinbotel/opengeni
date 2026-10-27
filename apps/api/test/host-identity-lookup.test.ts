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
  type DbClient,
} from "@opengeni/db";
import { getCanonicalHumanIdentityProjection } from "@opengeni/db/canonical-human-identities";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * A host links its own people to native identities: it invites them with a
 * host command, they accept and sign in natively, and the host then reads back
 * which of its invitations the native identity accepted, the identity's
 * verified email and its active login binding. The read answers only for
 * identities in the addressed organization, and an identity elsewhere looks
 * exactly like one that does not exist.
 */

const origin = "http://opengeni.test";
const delegationSecret = "host-identity-lookup-delegation-secret-32-bytes";
const HOST_SOURCE = "test-host:tenant";
const actingExternalUser = { source: "test-host:user", externalId: "staff-11" };

let shared: SharedTestDatabase;
let client: DbClient;
const managedEmailTransport = {
  sender: "Opengeni <auth@mail.opengeni.ai>",
  idempotency: { scope: "test-provider-v1:host-identity-lookup", retentionSeconds: 86_400 },
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
type LookupBody = {
  identityStatus: string;
  verifiedEmail: string | null;
  activeLoginBinding: { id: string; revision: number } | null;
  memberships: { id: string; status: string; role: string }[];
  acceptedInvitations: { id: string; acceptedMembershipId: string; acceptedAt: string }[];
};

function appFor(organizationGovernance?: OrganizationGovernancePort): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "host-identity-lookup-secret-32-bytes-long",
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
async function hostOrganization(source: string | null = HOST_SOURCE): Promise<HostOrganization> {
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

async function hostToken(
  organization: HostOrganization,
  permissions: string[] = ["members:manage"],
  subjectId = owner.subjectId,
): Promise<string> {
  return await signDelegatedAccessToken(delegationSecret, {
    accountId: organization.organizationId,
    workspaceId: organization.businessWorkspaceId,
    subjectId,
    permissions: permissions as never,
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: "test-host:governance" },
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

/** A host command invitation into the organization's business workspace. */
async function hostInvite(organization: HostOrganization, email: string): Promise<string> {
  const response = await governedApp.request(
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
          initialWorkspaceIds: [organization.businessWorkspaceId],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          operationId: crypto.randomUUID(),
        },
      }),
    },
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** The invitee signs up after the invitations, then accepts every one of them. */
async function acceptAll(email: string): Promise<Person> {
  const member = await signUp(governedApp, "Business member", email);
  const listed = await governedApp.request("/v1/organization-invitations", {
    headers: browser(member.cookie),
  });
  expect(listed.status).toBe(200);
  const { invitations } = (await listed.json()) as {
    invitations: { id: string; revision: number }[];
  };
  if (invitations.length === 0) throw new Error("no invitation was bound to the new member");
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

async function identityOf(person: Person) {
  return (await getCanonicalHumanIdentityProjection(client.db, person.userId)).activeIdentity;
}

async function lookup(
  app: App,
  organizationId: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return await app.request(`/v1/host/organizations/${organizationId}/identities/lookup`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function membershipOf(organizationId: string, subjectId: string) {
  const [row] = await shared.admin<{ id: string; authorization_revision: string }[]>`
    select id, authorization_revision from organization_memberships
    where account_id = ${organizationId} and subject_id = ${subjectId}`;
  return { id: row!.id, authorizationRevision: Number(row!.authorization_revision) };
}

async function membershipIdOf(organizationId: string, subjectId: string): Promise<string> {
  return (await membershipOf(organizationId, subjectId)).id;
}

/** Suspend or offboard a member through the host's own command. */
async function hostTransition(
  organization: HostOrganization,
  person: Person,
  kind: "suspend" | "offboard",
): Promise<void> {
  const membership = await membershipOf(organization.organizationId, person.subjectId);
  const response = await governedApp.request(
    `/v1/host/organizations/${organization.organizationId}/members/${membership.id}/${kind}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await hostToken(organization)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        actingExternalUser,
        command: {
          expectedAuthorizationRevision: membership.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      }),
    },
  );
  expect(response.status).toBe(200);
}

/** Whether the runtime role may call 1016's lookup by identity. */
async function lookupByIdentityGranted(): Promise<boolean> {
  const [row] = await shared.admin<{ granted: boolean | null }[]>`
    select has_function_privilege('opengeni_app',
      to_regprocedure('opengeni_private.lookup_organization_host_identity(uuid, text, uuid)')::oid,
      'EXECUTE') as granted`;
  return row?.granted === true;
}

/** Every response carries its own request id; everything else must match. */
function withoutRequestId(body: unknown): unknown {
  const { error } = body as { error: Record<string, unknown> };
  const { requestId: _requestId, ...rest } = error;
  return { ...(body as object), error: rest };
}

function detailCode(body: unknown): string | undefined {
  return (body as { error?: { details?: { code?: string } } }).error?.details?.code;
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-identity-lookup");
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

/*
 * 1016 creates the lookup by identity without runtime EXECUTE (granted one
 * release later); until then the route resolves the identity through the
 * member list. Both paths answer every case the same way.
 */
for (const path of ["member list (1016 not granted)", "lookup by identity (1016 granted)"]) {
  const granted = path.startsWith("lookup by identity");

  describe(`the host looks up a native identity in its organization: ${path}`, () => {
    let first: HostOrganization;
    let second: HostOrganization;
    let member: Person;
    let firstInvitationId: string;
    let secondInvitationId: string;

    beforeAll(async () => {
      if (granted) await grantDeferredRuntimeAccess(shared.admin);
      else
        await shared.admin.unsafe(`REVOKE EXECUTE ON FUNCTION
          opengeni_private.lookup_organization_host_identity(uuid, text, uuid) FROM opengeni_app`);
      expect(await lookupByIdentityGranted()).toBe(granted);
      first = await hostOrganization();
      second = await hostOrganization();
      const email = `${crypto.randomUUID()}@example.test`;
      firstInvitationId = await hostInvite(first, email);
      secondInvitationId = await hostInvite(second, email);
      member = await acceptAll(email);
    }, 180_000);

    test("answers the membership, accepted invitation, verified email and login binding", async () => {
      const identity = await identityOf(member);
      const response = await lookup(governedApp, first.organizationId, await hostToken(first), {
        identityId: identity.id,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as LookupBody;
      const projection = await getCanonicalHumanIdentityProjection(client.db, member.userId);
      const binding = projection.loginBindings.find(
        (candidate) => candidate.id === identity.activeLoginBindingId,
      );
      expect(binding?.status).toBe("active");
      const [invitation] = await shared.admin<
        { accepted_membership_id: string; accepted_at: Date | null; updated_at: Date }[]
      >`
        select accepted_membership_id, accepted_at, updated_at
        from organization_membership_invitations where id = ${firstInvitationId}`;
      // 1016's trigger records the acceptance time from the accepting write.
      expect(invitation!.accepted_at).toEqual(invitation!.updated_at);
      const membershipId = await membershipIdOf(first.organizationId, member.subjectId);
      expect(invitation!.accepted_membership_id).toBe(membershipId);
      expect(body).toEqual({
        identityStatus: "active",
        verifiedEmail: member.email,
        activeLoginBinding: { id: binding!.id, revision: binding!.revision },
        memberships: [{ id: membershipId, status: "active", role: "member" }],
        acceptedInvitations: [
          {
            id: firstInvitationId,
            acceptedMembershipId: membershipId,
            acceptedAt: invitation!.accepted_at!.toISOString(),
          },
        ],
      });
    }, 60_000);

    test("lists only this organization's membership and invitations", async () => {
      const identity = await identityOf(member);
      for (const [organization, invitationId] of [
        [first, firstInvitationId],
        [second, secondInvitationId],
      ] as const) {
        const response = await lookup(
          governedApp,
          organization.organizationId,
          await hostToken(organization),
          { identityId: identity.id },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as LookupBody;
        const membershipId = await membershipIdOf(organization.organizationId, member.subjectId);
        expect(body.memberships.map((membership) => membership.id)).toEqual([membershipId]);
        expect(body.acceptedInvitations.map((accepted) => accepted.id)).toEqual([invitationId]);
        expect(body.acceptedInvitations[0]!.acceptedMembershipId).toBe(membershipId);
      }
    }, 60_000);

    test("a suspended and an offboarded member still answer, with their status", async () => {
      for (const [kind, status] of [
        ["suspend", "suspended"],
        ["offboard", "revoked"],
      ] as const) {
        const email = `${crypto.randomUUID()}@example.test`;
        const invitationId = await hostInvite(first, email);
        const person = await acceptAll(email);
        await hostTransition(first, person, kind);
        const response = await lookup(governedApp, first.organizationId, await hostToken(first), {
          identityId: (await identityOf(person)).id,
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as LookupBody;
        expect(body.memberships).toEqual([
          {
            id: await membershipIdOf(first.organizationId, person.subjectId),
            status,
            role: "member",
          },
        ]);
        expect(body.acceptedInvitations.map((accepted) => accepted.id)).toEqual([invitationId]);
      }
    }, 180_000);

    test("an unverified email answers verifiedEmail null", async () => {
      const email = `${crypto.randomUUID()}@example.test`;
      await hostInvite(first, email);
      const unverified = await acceptAll(email);
      await shared.admin`
        update auth_users set email_verified = false where id = ${unverified.userId}`;
      const response = await lookup(governedApp, first.organizationId, await hostToken(first), {
        identityId: (await identityOf(unverified)).id,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as LookupBody;
      expect(body.verifiedEmail).toBeNull();
      expect(body.acceptedInvitations).toHaveLength(1);
    }, 120_000);

    test("an unknown identity and one from another organization get the same 404", async () => {
      const elsewhere = await hostOrganization();
      const email = `${crypto.randomUUID()}@example.test`;
      await hostInvite(elsewhere, email);
      const foreigner = await acceptAll(email);
      const token = await hostToken(first);
      const foreign = await lookup(governedApp, first.organizationId, token, {
        identityId: (await identityOf(foreigner)).id,
      });
      const unknown = await lookup(governedApp, first.organizationId, token, {
        identityId: crypto.randomUUID(),
      });
      for (const response of [foreign, unknown]) {
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      const foreignBody = withoutRequestId(await foreign.json());
      expect(detailCode(foreignBody)).toBe("HOST_IDENTITY_NOT_IN_ORGANIZATION");
      expect(withoutRequestId(await unknown.json())).toEqual(foreignBody);
    }, 120_000);

    test("a service token for another organization is refused", async () => {
      const identity = await identityOf(member);
      const refused = await lookup(governedApp, first.organizationId, await hostToken(second), {
        identityId: identity.id,
      });
      expect(refused.status).toBe(401);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(detailCode(await refused.json())).toBe("HOST_COMMAND_SERVICE_TOKEN_REQUIRED");
    }, 60_000);

    test("a token without members:manage is refused", async () => {
      const identity = await identityOf(member);
      const refused = await lookup(
        governedApp,
        first.organizationId,
        await hostToken(first, ["account:read"]),
        { identityId: identity.id },
      );
      expect(refused.status).toBe(403);
      expect(detailCode(await refused.json())).toBe("HOST_COMMAND_PERMISSION_REQUIRED");
    }, 60_000);

    test("a token whose subject is not an organization administrator is refused", async () => {
      const identity = await identityOf(member);
      const refused = await lookup(
        governedApp,
        first.organizationId,
        await hostToken(first, ["members:manage"], member.subjectId),
        { identityId: identity.id },
      );
      expect(refused.status).toBe(403);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(detailCode(await refused.json())).toBe("HOST_COMMAND_ACTOR_NOT_AUTHORIZED");
    }, 60_000);

    test("an organization the host does not govern is refused", async () => {
      const ungoverned = await hostOrganization(null);
      const refused = await lookup(
        governedApp,
        ungoverned.organizationId,
        await hostToken(ungoverned),
        { identityId: (await identityOf(member)).id },
      );
      expect(refused.status).toBe(403);
      expect(detailCode(await refused.json())).toBe("ORGANIZATION_NOT_HOST_GOVERNED");
    }, 60_000);

    test("a body without a UUID identityId is refused", async () => {
      const token = await hostToken(first);
      for (const body of [
        {},
        { identityId: "user:abc" },
        { identityId: crypto.randomUUID(), x: 1 },
      ])
        expect((await lookup(governedApp, first.organizationId, token, body)).status).toBe(422);
    }, 60_000);

    test("stock: without a port there is no lookup route", async () => {
      const response = await lookup(stockApp, first.organizationId, await hostToken(first), {
        identityId: (await identityOf(member)).id,
      });
      expect(response.status).toBe(404);
    }, 60_000);
  });
}

describe("a host command refused by the database names the actor", () => {
  test("a non-administrator subject gets HOST_COMMAND_ACTOR_NOT_AUTHORIZED", async () => {
    const organization = await hostOrganization();
    const email = `${crypto.randomUUID()}@example.test`;
    await hostInvite(organization, email);
    const person = await acceptAll(email);
    const response = await governedApp.request(
      `/v1/host/organizations/${organization.organizationId}/invitations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await hostToken(organization, ["members:manage"], person.subjectId)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actingExternalUser,
          command: {
            email: `${crypto.randomUUID()}@example.test`,
            role: "member",
            initialWorkspaceIds: [organization.businessWorkspaceId],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            operationId: crypto.randomUUID(),
          },
        }),
      },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toBe("organization administration is not authorized");
    expect(detailCode(body)).toBe("HOST_COMMAND_ACTOR_NOT_AUTHORIZED");
  }, 120_000);
});
