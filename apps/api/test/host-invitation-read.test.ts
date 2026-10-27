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
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * A host that issued an invitation through a host command retries its revoke
 * until it settles. It must tell a stale revision (retry at the newer one)
 * from an invitation that is no longer pending (accepted, revoked or expired:
 * settled), and it can read the invitation back with its service token. The
 * read answers only for this organization's invitations; one elsewhere looks
 * exactly like one that does not exist.
 */

const origin = "http://opengeni.test";
const delegationSecret = "host-invitation-read-delegation-secret-32-bytes";
const HOST_SOURCE = "test-host:tenant";
const actingExternalUser = { source: "test-host:user", externalId: "staff-12" };

let shared: SharedTestDatabase;
let client: DbClient;
const managedEmailTransport = {
  sender: "Opengeni <auth@mail.opengeni.ai>",
  idempotency: { scope: "test-provider-v1:host-invitation-read", retentionSeconds: 86_400 },
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
type Invitation = { id: string; revision: number; status: string; expiresAt: string };

function appFor(organizationGovernance?: OrganizationGovernancePort): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "host-invitation-read-secret-32-bytes-long",
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

function hostHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** A host command invitation into the organization's business workspace. */
async function hostInvite(
  organization: HostOrganization,
  email = `${crypto.randomUUID()}@example.test`,
): Promise<Invitation> {
  const response = await governedApp.request(
    `/v1/host/organizations/${organization.organizationId}/invitations`,
    {
      method: "POST",
      headers: hostHeaders(await hostToken(organization)),
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
  return (await response.json()) as Invitation;
}

/** The invitee signs up after the invitation, then accepts it. */
async function accept(email: string): Promise<Person> {
  const member = await signUp(governedApp, "Business member", email);
  const listed = await governedApp.request("/v1/organization-invitations", {
    headers: browser(member.cookie),
  });
  expect(listed.status).toBe(200);
  const { invitations } = (await listed.json()) as { invitations: Invitation[] };
  if (invitations.length !== 1) throw new Error("expected one invitation for the new member");
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

async function revoke(
  organization: HostOrganization,
  invitationId: string,
  command: { expectedRevision: number; operationId: string },
  token?: string,
): Promise<Response> {
  return await governedApp.request(
    `/v1/host/organizations/${organization.organizationId}/invitations/${invitationId}/revoke`,
    {
      method: "POST",
      headers: hostHeaders(token ?? (await hostToken(organization))),
      body: JSON.stringify({ actingExternalUser, command }),
    },
  );
}

async function read(
  app: App,
  organizationId: string,
  invitationId: string,
  token: string,
): Promise<Response> {
  return await app.request(`/v1/host/organizations/${organizationId}/invitations/${invitationId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Every response carries its own request id; everything else must match. */
function withoutRequestId(body: unknown): unknown {
  const { error } = body as { error: Record<string, unknown> };
  const { requestId: _requestId, ...rest } = error;
  return { ...(body as object), error: rest };
}

type ErrorBody = {
  error: { code: string; details?: { code?: string; status?: string } };
};

async function stored(invitationId: string) {
  const [row] = await shared.admin<
    {
      revision: string;
      accepted_membership_id: string | null;
      updated_at: Date;
      accepted_at: Date | null;
      expires_at: Date;
    }[]
  >`
    select revision, accepted_membership_id, updated_at, accepted_at, expires_at
    from organization_membership_invitations where id = ${invitationId}`;
  return row!;
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-invitation-read");
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

describe("the host reads back one of its organization's invitations", () => {
  let organization: HostOrganization;

  beforeAll(async () => {
    organization = await hostOrganization();
  }, 60_000);

  test("a pending invitation", async () => {
    const invitation = await hostInvite(organization);
    const response = await read(
      governedApp,
      organization.organizationId,
      invitation.id,
      await hostToken(organization),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      id: invitation.id,
      organizationId: organization.organizationId,
      status: "pending",
      revision: invitation.revision,
      acceptedMembershipId: null,
      acceptedAt: null,
      expiresAt: (await stored(invitation.id)).expires_at.toISOString(),
    });
  }, 60_000);

  test("an accepted invitation answers its membership and acceptance time", async () => {
    const email = `${crypto.randomUUID()}@example.test`;
    const invitation = await hostInvite(organization, email);
    const member = await accept(email);
    const row = await stored(invitation.id);
    const [membership] = await shared.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${organization.organizationId} and subject_id = ${member.subjectId}`;
    expect(row.accepted_membership_id).toBe(membership!.id);
    const response = await read(
      governedApp,
      organization.organizationId,
      invitation.id,
      await hostToken(organization),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: invitation.id,
      organizationId: organization.organizationId,
      status: "accepted",
      revision: Number(row.revision),
      acceptedMembershipId: membership!.id,
      acceptedAt: row.updated_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    });
    // The read derives acceptedAt from updated_at; this pins the invariant that
    // it equals the accepting write's accepted_at (1016), so a later writer
    // that touches an accepted row fails here.
    expect(row.accepted_at?.toISOString()).toBe(row.updated_at.toISOString());
  }, 120_000);

  test("a revoked and an expired invitation answer their status", async () => {
    const revoked = await hostInvite(organization);
    expect(
      (
        await revoke(organization, revoked.id, {
          expectedRevision: revoked.revision,
          operationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    const expired = await hostInvite(organization);
    await shared.admin`
      update organization_membership_invitations
      set expires_at = clock_timestamp() - interval '1 minute' where id = ${expired.id}`;
    const token = await hostToken(organization);
    for (const [invitation, status] of [
      [revoked, "revoked"],
      [expired, "expired"],
    ] as const) {
      const response = await read(governedApp, organization.organizationId, invitation.id, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Invitation & { acceptedAt: string | null };
      expect(body.status).toBe(status);
      expect(body.acceptedAt).toBeNull();
      expect(body.revision).toBe(Number((await stored(invitation.id)).revision));
    }
  }, 60_000);

  test("an unknown invitation and one from another organization get the same 404", async () => {
    const elsewhere = await hostOrganization();
    const foreignInvitation = await hostInvite(elsewhere);
    const token = await hostToken(organization);
    const foreign = await read(
      governedApp,
      organization.organizationId,
      foreignInvitation.id,
      token,
    );
    const unknown = await read(
      governedApp,
      organization.organizationId,
      crypto.randomUUID(),
      token,
    );
    for (const response of [foreign, unknown]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const foreignBody = withoutRequestId(await foreign.json()) as ErrorBody;
    expect(foreignBody.error.code).toBe("not_found");
    expect(foreignBody.error.details?.code).toBe("HOST_INVITATION_NOT_IN_ORGANIZATION");
    expect(withoutRequestId(await unknown.json())).toEqual(foreignBody);
  }, 60_000);

  test("refusals: another organization's token, no members:manage, a non-administrator, an ungoverned organization", async () => {
    const invitation = await hostInvite(organization);
    const email = `${crypto.randomUUID()}@example.test`;
    await hostInvite(organization, email);
    const member = await accept(email);
    const other = await hostOrganization();
    const ungoverned = await hostOrganization(null);
    const cases: [string, Response, number, string][] = [
      [
        "cross-organization token",
        await read(governedApp, organization.organizationId, invitation.id, await hostToken(other)),
        401,
        "HOST_COMMAND_SERVICE_TOKEN_REQUIRED",
      ],
      [
        "no members:manage",
        await read(
          governedApp,
          organization.organizationId,
          invitation.id,
          await hostToken(organization, ["account:read"]),
        ),
        403,
        "HOST_COMMAND_PERMISSION_REQUIRED",
      ],
      [
        "non-administrator subject",
        await read(
          governedApp,
          organization.organizationId,
          invitation.id,
          await hostToken(organization, ["members:manage"], member.subjectId),
        ),
        403,
        "HOST_COMMAND_ACTOR_NOT_AUTHORIZED",
      ],
      [
        "ungoverned organization",
        await read(
          governedApp,
          ungoverned.organizationId,
          crypto.randomUUID(),
          await hostToken(ungoverned),
        ),
        403,
        "ORGANIZATION_NOT_HOST_GOVERNED",
      ],
    ];
    for (const [name, response, status, code] of cases) {
      expect({ name, status: response.status }).toEqual({ name, status });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(((await response.json()) as ErrorBody).error.details?.code).toBe(code);
    }
  }, 120_000);

  test("a non-UUID invitation id is refused", async () => {
    const response = await read(
      governedApp,
      organization.organizationId,
      "not-a-uuid",
      await hostToken(organization),
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }, 60_000);

  test("stock: without a port there is no read route", async () => {
    const invitation = await hostInvite(organization);
    const response = await read(
      stockApp,
      organization.organizationId,
      invitation.id,
      await hostToken(organization),
    );
    expect(response.status).toBe(404);
  }, 60_000);
});

describe("a refused host revoke says why", () => {
  let organization: HostOrganization;

  beforeAll(async () => {
    organization = await hostOrganization();
  }, 60_000);

  test("a pending invitation at a newer revision is a revision conflict", async () => {
    const invitation = await hostInvite(organization);
    const response = await revoke(organization, invitation.id, {
      expectedRevision: invitation.revision + 1,
      operationId: crypto.randomUUID(),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({
      code: "HOST_INVITATION_REVISION_CONFLICT",
      status: "pending",
    });
    expect((await stored(invitation.id)).revision).toBe(String(invitation.revision));
  }, 60_000);

  test("an accepted, revoked or expired invitation is not pending, at any revision", async () => {
    const email = `${crypto.randomUUID()}@example.test`;
    const accepted = await hostInvite(organization, email);
    await accept(email);
    const revoked = await hostInvite(organization);
    expect(
      (
        await revoke(organization, revoked.id, {
          expectedRevision: revoked.revision,
          operationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    const expired = await hostInvite(organization);
    await shared.admin`
      update organization_membership_invitations
      set expires_at = clock_timestamp() - interval '1 minute' where id = ${expired.id}`;
    const current = async (invitation: Invitation) =>
      Number((await stored(invitation.id)).revision);
    for (const [invitation, status, revisions] of [
      // The host's old revision (the accept and the revoke bumped it) and the current one.
      [accepted, "accepted", [accepted.revision, await current(accepted)]],
      [revoked, "revoked", [revoked.revision, await current(revoked)]],
      // The stored row is still pending at its revision, so only a stale one is refused.
      [expired, "expired", [(await current(expired)) + 1]],
    ] as const) {
      for (const expectedRevision of revisions) {
        const response = await revoke(organization, invitation.id, {
          expectedRevision,
          operationId: crypto.randomUUID(),
        });
        expect({ status, expectedRevision, http: response.status }).toEqual({
          status,
          expectedRevision,
          http: 409,
        });
        const body = (await response.json()) as ErrorBody;
        expect(body.error.code).toBe("conflict");
        expect(body.error.details).toEqual({ code: "HOST_INVITATION_NOT_PENDING", status });
      }
    }
  }, 180_000);

  test("an unknown invitation keeps the native 404", async () => {
    const response = await revoke(organization, crypto.randomUUID(), {
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
    });
    expect(response.status).toBe(404);
  }, 60_000);

  test("a replay of the same operation id after success returns the original receipt", async () => {
    const invitation = await hostInvite(organization);
    const command = { expectedRevision: invitation.revision, operationId: crypto.randomUUID() };
    const first = await revoke(organization, invitation.id, command);
    expect(first.status).toBe(200);
    const receipt = (await first.json()) as Invitation;
    expect(receipt.status).toBe("revoked");
    const replay = await revoke(organization, invitation.id, command);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    // The replay changed nothing: one revoke, one receipt.
    expect((await stored(invitation.id)).revision).toBe(String(receipt.revision));
    const [counts] = await shared.admin<{ receipts: string; events: string }[]>`
      select
        (select count(*) from organization_membership_operation_receipts
          where account_id = ${organization.organizationId}
            and operation_id = ${command.operationId}) as receipts,
        (select count(*) from organization_membership_lifecycle_events
          where account_id = ${organization.organizationId}
            and operation_id = ${command.operationId}) as events`;
    expect(counts).toEqual({ receipts: "1", events: "1" });
    // The same operation id with another input is refused, and changes nothing.
    const reused = await revoke(organization, invitation.id, {
      ...command,
      expectedRevision: receipt.revision,
    });
    expect(reused.status).toBe(409);
    expect((await stored(invitation.id)).revision).toBe(String(receipt.revision));
  }, 60_000);
});
