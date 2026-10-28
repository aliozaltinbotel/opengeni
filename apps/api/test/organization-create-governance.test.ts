import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ORGANIZATION_CREATE_GOVERNED,
  type OrganizationGovernancePort,
} from "@opengeni/contracts/organization-governance";
import type { AppDependencies } from "@opengeni/core";
import { createDb, createManagedOrganization, type DbClient } from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * A person who belongs to a host-governed organization creates no organization
 * of their own (`POST /v1/organizations`, `POST /v1/organizations/additional`)
 * unless that organization's host allows `organization.create` natively: the
 * new organization would sit outside the host's governance with the person as
 * its owner. People without a governed membership, and deployments without a
 * port, are unchanged.
 */

const origin = "http://opengeni.test";
const HOST_SOURCE = "test-host:tenant";

const refusingHost: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: ({ via }) => (via === "host" ? "allow" : "refuse"),
};
const allowingHost: OrganizationGovernancePort = {
  governs: refusingHost.governs,
  decide: ({ via, mutation }) =>
    via === "host" || mutation === "organization.create" ? "allow" : "refuse",
};

type App = ReturnType<typeof createApp>;
type Person = { cookie: string; email: string; subjectId: string };

let shared: SharedTestDatabase;
let client: DbClient;

function appFor(organizationGovernance?: OrganizationGovernancePort): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "organization-create-governance-secret-32",
      publicBaseUrl: origin,
      delegationSecret: "organization-create-governance-delegation-32",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    ...(organizationGovernance ? { organizationGovernance } : {}),
  } as AppDependencies);
}

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

/** A signed-in person whose first organization carries `source` (null: ungoverned). */
async function personWithFirstOrganization(source: string | null): Promise<Person> {
  const app = appFor();
  const email = `${crypto.randomUUID()}@example.test`;
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Staff member", email, password: "password1234" }),
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
  const subjectId = `user:${user!.id}`;
  const created = await createManagedOrganization(client.db, {
    subjectId,
    subjectLabel: email,
    name: "First organization",
    operationId: crypto.randomUUID(),
  });
  if (source)
    await shared.admin`
      update managed_accounts set external_source = ${source}, external_id = ${crypto.randomUUID()}
      where id = ${created.organization.id}`;
  return { cookie: cookie.split(";", 1)[0]!, email, subjectId };
}

function detailCode(body: unknown): string | undefined {
  return (body as { error?: { details?: { code?: string } } } | null)?.error?.details?.code;
}

async function create(app: App, person: Person, route: "initial" | "additional") {
  const response = await app.request(
    route === "initial" ? "/v1/organizations" : "/v1/organizations/additional",
    {
      method: "POST",
      headers: browser(person.cookie),
      body: JSON.stringify({
        name: "Own organization",
        ...(route === "additional" ? { workspaceName: "Own workspace" } : {}),
        operationId: crypto.randomUUID(),
      }),
    },
  );
  return { status: response.status, code: detailCode(await response.json().catch(() => null)) };
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-create-governance");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("organization creation by a governed organization's people", () => {
  test.each(["initial", "additional"] as const)(
    "POST %s answers 403 ORGANIZATION_CREATE_GOVERNED when the host refuses",
    async (route) => {
      const person = await personWithFirstOrganization(HOST_SOURCE);
      const before = await shared.admin<{ count: number }[]>`
        select count(*)::int as count from organization_memberships
        where subject_id = ${person.subjectId}`;
      expect(await create(appFor(refusingHost), person, route)).toEqual({
        status: 403,
        code: ORGANIZATION_CREATE_GOVERNED,
      });
      const after = await shared.admin<{ count: number }[]>`
        select count(*)::int as count from organization_memberships
        where subject_id = ${person.subjectId}`;
      expect(after[0]!.count).toBe(before[0]!.count);
    },
    60_000,
  );

  test("POST additional creates the organization when the host allows organization.create", async () => {
    const person = await personWithFirstOrganization(HOST_SOURCE);
    expect((await create(appFor(allowingHost), person, "additional")).status).toBe(201);
  }, 60_000);

  test("POST initial reaches its own answer when the host allows organization.create", async () => {
    const person = await personWithFirstOrganization(HOST_SOURCE);
    const allowed = await create(appFor(allowingHost), person, "initial");
    const stock = await create(appFor(), person, "initial");
    expect(allowed.code).not.toBe(ORGANIZATION_CREATE_GOVERNED);
    // The same answer as a deployment without a port.
    expect(allowed.status).toBe(stock.status);
  }, 60_000);
});

describe("unchanged without a governed membership", () => {
  test.each(["initial", "additional"] as const)(
    "POST %s keeps its stock answer for a person of an ungoverned organization",
    async (route) => {
      const person = await personWithFirstOrganization(null);
      const governed = await create(appFor(refusingHost), person, route);
      const stock = await create(appFor(), person, route);
      expect(governed.code).not.toBe(ORGANIZATION_CREATE_GOVERNED);
      expect(governed.status).toBe(stock.status);
    },
    60_000,
  );

  test("without a port a governed-source person creates an organization", async () => {
    const person = await personWithFirstOrganization(HOST_SOURCE);
    expect((await create(appFor(), person, "additional")).status).toBe(201);
  }, 60_000);
});
