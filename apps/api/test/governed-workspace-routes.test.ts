import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  WORKSPACE_ROUTE_NOT_ALLOWED,
  type OrganizationGovernancePort,
} from "@opengeni/contracts/organization-governance";
import type { AppDependencies } from "@opengeni/core";
import {
  createAdditionalManagedOrganization,
  createDb,
  createManagedOrganization,
  type DbClient,
} from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  createApp,
  GOVERNED_MEMBER_SESSION_OPERATIONS,
  governedMemberRouteAllowed,
  governedRouteTable,
} from "../src/app";

/*
 * Default-deny in a host-governed organization: its people reach a workspace
 * or organization route only when it is on the governed allowlist; every other
 * route answers 403 WORKSPACE_ROUTE_NOT_ALLOWED by name. Organizations the
 * host does not govern, deployments without a port, the host's own tokens and
 * anonymous callers keep each route's own answer.
 */

const origin = "http://opengeni.test";
const delegationSecret = "governed-workspace-routes-delegation-secret-32";
const HOST_SOURCE = "test-host:tenant";

const hostPort: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: ({ via }) => (via === "host" ? "allow" : "refuse"),
  memberRouteAccess: "allowlist",
};
/** A host that governs the same organizations but keeps every route's own checks. */
const portWithoutAllowlist: OrganizationGovernancePort = {
  governs: hostPort.governs,
  decide: hostPort.decide,
};

type App = ReturnType<typeof createApp>;
type Person = { cookie: string; email: string; subjectId: string };

let shared: SharedTestDatabase;
let client: DbClient;
let stockApp: App;
let governedApp: App;
let owner: Person;
let governed: { organizationId: string; workspaceId: string };
let ungoverned: { organizationId: string; workspaceId: string };

function appFor(organizationGovernance?: OrganizationGovernancePort): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "governed-workspace-routes-secret-32-bytes",
      publicBaseUrl: origin,
      delegationSecret,
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

async function signUp(app: App): Promise<Person> {
  const email = `${crypto.randomUUID()}@example.test`;
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Owner", email, password: "password1234" }),
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
  await createManagedOrganization(client.db, {
    subjectId,
    subjectLabel: email,
    name: "Owner's first organization",
    operationId: crypto.randomUUID(),
  });
  return { cookie: cookie.split(";", 1)[0]!, email, subjectId };
}

async function organization(source: string | null) {
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
  return { organizationId: created.organization.id, workspaceId: created.workspaceId };
}

function detailCode(body: unknown): string | undefined {
  return (body as { error?: { details?: { code?: string } } } | null)?.error?.details?.code;
}

async function call(app: App, path: string, init: RequestInit = {}) {
  const response = await app.request(path, init);
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, code: detailCode(body) };
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("governed-workspace-routes");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  stockApp = appFor();
  governedApp = appFor(hostPort);
  owner = await signUp(stockApp);
  governed = await organization(HOST_SOURCE);
  ungoverned = await organization("another-host:tenant");
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";

describe("default-deny in a governed organization", () => {
  test.each([
    ["GET", "automations/sources"],
    ["GET", "automations/triggers"],
    ["GET", "automations/runs"],
    ["GET", "claude/accounts"],
    ["GET", "codex/status"],
    ["GET", "tools/catalog"],
    ["POST", `sessions/${SESSION_ID}/fs/read`],
    ["POST", `sessions/${SESSION_ID}/terminal/exec`],
    ["PUT", `sessions/${SESSION_ID}/tool-policy`],
  ])("a member's %s %s answers 403 WORKSPACE_ROUTE_NOT_ALLOWED", async (method, suffix) => {
    const result = await call(governedApp, `/v1/workspaces/${governed.workspaceId}/${suffix}`, {
      method,
      headers: browser(owner.cookie),
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    expect(result).toEqual({ status: 403, code: WORKSPACE_ROUTE_NOT_ALLOWED });
  });

  test("an organization route answers 403 WORKSPACE_ROUTE_NOT_ALLOWED", async () => {
    const result = await call(governedApp, `/v1/organizations/${governed.organizationId}/members`, {
      headers: browser(owner.cookie),
    });
    expect(result).toEqual({ status: 403, code: WORKSPACE_ROUTE_NOT_ALLOWED });
  });

  test.each(["", "/sessions"])("an allowed route %p answers 200", async (suffix) => {
    const result = await call(governedApp, `/v1/workspaces/${governed.workspaceId}${suffix}`, {
      headers: browser(owner.cookie),
    });
    expect(result.status).toBe(200);
  });

  test("an allowed session route keeps its own answer (no named refusal)", async () => {
    const result = await call(
      governedApp,
      `/v1/workspaces/${governed.workspaceId}/sessions/${SESSION_ID}`,
      { headers: browser(owner.cookie) },
    );
    expect(result.code).not.toBe(WORKSPACE_ROUTE_NOT_ALLOWED);
    expect(result.status).toBe(404);
  });

  test("an anonymous caller keeps the route's 401", async () => {
    const result = await call(
      governedApp,
      `/v1/workspaces/${governed.workspaceId}/automations/sources`,
    );
    expect(result.status).toBe(401);
    expect(result.code).not.toBe(WORKSPACE_ROUTE_NOT_ALLOWED);
  });

  test("the host's own service token keeps the route's own checks", async () => {
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: governed.organizationId,
      workspaceId: governed.workspaceId,
      subjectId: owner.subjectId,
      permissions: ["workspace:read", "workspace:admin"],
      principalKind: "service",
      serviceInitiator: { kind: "service", subjectId: "test-host:governance" },
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const result = await call(
      governedApp,
      `/v1/workspaces/${governed.workspaceId}/automations/sources`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(result.code).not.toBe(WORKSPACE_ROUTE_NOT_ALLOWED);
    expect(result.status).toBe(200);
  });
});

describe("unchanged outside governed organizations", () => {
  test("an organization the host does not govern answers the route's own 200", async () => {
    for (const path of [
      `/v1/workspaces/${ungoverned.workspaceId}/automations/sources`,
      `/v1/organizations/${ungoverned.organizationId}/members`,
    ]) {
      const result = await call(governedApp, path, { headers: browser(owner.cookie) });
      expect(result).toEqual({ status: 200, code: undefined });
    }
  });

  test("without a bound port the governed organization's route answers 200", async () => {
    const result = await call(
      stockApp,
      `/v1/workspaces/${governed.workspaceId}/automations/sources`,
      { headers: browser(owner.cookie) },
    );
    expect(result).toEqual({ status: 200, code: undefined });
  });

  test("a port that does not opt in keeps every route's own answer", async () => {
    const result = await call(
      appFor(portWithoutAllowlist),
      `/v1/workspaces/${governed.workspaceId}/automations/sources`,
      { headers: browser(owner.cookie) },
    );
    expect(result).toEqual({ status: 200, code: undefined });
  });
});

describe("the exported route table", () => {
  test("classifies every mounted workspace and organization route once", () => {
    const table = governedRouteTable(governedApp.routes);
    expect(table.length).toBeGreaterThan(500);
    const keys = table.map((row) => `${row.method} ${row.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const allowed = (method: string, path: string) =>
      table.find((row) => row.method === method && row.path === path)?.allowed;
    const ws = "/v1/workspaces/:workspaceId";
    expect(allowed("POST", `${ws}/sessions`)).toBe(true);
    expect(allowed("POST", `${ws}/sessions/:sessionId/events`)).toBe(true);
    expect(allowed("GET", `${ws}/sessions/:sessionId/events/stream`)).toBe(true);
    expect(allowed("POST", `${ws}/sessions/:sessionId/context/compact`)).toBe(true);
    expect(allowed("POST", `${ws}/sessions/:sessionId/fs/read`)).toBe(false);
    expect(allowed("GET", `${ws}/automations/sources`)).toBe(false);
    expect(allowed("GET", `${ws}/codex/status`)).toBe(false);
    expect(allowed("GET", `${ws}/subscription-usage-pools`)).toBe(false);
    expect(
      table.filter((row) => row.path.startsWith("/v1/organizations/")).every((row) => !row.allowed),
    ).toBe(true);
  });

  test("a session route is allowed exactly when its operation is in the member set", () => {
    expect(GOVERNED_MEMBER_SESSION_OPERATIONS).toContain("session.queue.control");
    expect(GOVERNED_MEMBER_SESSION_OPERATIONS).not.toContain("session.files.read");
    expect(
      governedMemberRouteAllowed(
        "POST",
        "/v1/workspaces/:workspaceId/sessions/:sessionId/queue/:queueItemId/cancel",
      ),
    ).toBe(true);
    expect(
      governedMemberRouteAllowed(
        "PUT",
        "/v1/workspaces/:workspaceId/sessions/:sessionId/model-account",
      ),
    ).toBe(false);
  });
});
