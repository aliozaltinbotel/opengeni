import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { OrganizationGovernancePort } from "@opengeni/contracts/organization-governance";
import {
  GOVERNED_ORGANIZATION_SESSION_POLICY,
  STOCK_ORGANIZATION_SESSION_POLICY,
} from "@opengeni/contracts/organization-session-policy";
import type { AppDependencies } from "@opengeni/core";
import {
  completeFileUpload,
  createAdditionalManagedOrganization,
  createManagedOrganization,
  createDb,
  createFileUpload,
  getOrganizationSessionPolicy,
  type DbClient,
} from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

/*
 * A host-governed organization's sessions get no file attachments and no
 * generic shell, Codemode, browser or computer-use tools unless its host says
 * otherwise. The host sets the policy through a host command; no native route
 * writes it. Stock deployments, and organizations the host does not govern,
 * are unchanged.
 */

const delegationSecret = "organization-session-policy-delegation-32";
const HOST_SOURCE = "test-host:tenant";
const actingExternalUser = { source: "test-host:user", externalId: "staff-9" };
const SIGNED_URL = "https://storage.example.test/opaque?signature=x";

const hostPort: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: ({ via }) => (via === "host" ? "allow" : "refuse"),
};

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-session-policy");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

async function signUpOwner(app: App): Promise<string> {
  const email = `session-policy-${crypto.randomUUID()}@example.test`;
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Organization owner", email, password: "password1234" }),
  });
  await shared.admin`update auth_users set email_verified = true where email = ${email}`;
  // Signing in provisions the person's first organization.
  const signedIn = await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", rememberMe: true }),
  });
  if (signedIn.status !== 200) throw new Error(`sign-in failed: ${signedIn.status}`);
  const [user] = await shared.admin<{ id: string }[]>`
    select id from auth_users where email = ${email}`;
  if (!user) throw new Error("the owner was not signed up");
  const subjectId = `user:${user.id}`;
  await createManagedOrganization(client.db, {
    subjectId,
    subjectLabel: email,
    name: "Owner's first organization",
    operationId: crypto.randomUUID(),
  });
  return subjectId;
}

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function storageStub(): ObjectStorage {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected object-storage operation");
  };
  return {
    bucket: "session-policy-bucket",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    async createPutUrl() {
      return {
        url: SIGNED_URL,
        requiredHeaders: { "content-type": "text/plain" },
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    async createGetUrl() {
      return { url: SIGNED_URL, expiresAt: new Date(Date.now() + 300_000) };
    },
    headFile: unavailable,
    fileExists: async () => true,
    getFileBytes: unavailable,
    getFileRange: unavailable,
    getObjectBytes: unavailable,
    putObject: unavailable,
    deleteObject: unavailable,
  } as unknown as ObjectStorage;
}

type App = ReturnType<typeof createApp>;

function appFor(organizationGovernance?: OrganizationGovernancePort): App {
  return createApp({
    settings: testSettings({
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "organization-session-policy-secret-32-bytes",
      publicBaseUrl: "http://opengeni.test",
      delegationSecret,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    objectStorage: storageStub(),
    ...(organizationGovernance ? { organizationGovernance } : {}),
  } as AppDependencies);
}

/** An organization the host provisions out of band, like a tenant, with its own owner. */
async function organization(source: string) {
  const ownerSubjectId = await signUpOwner(appFor());
  const created = await createAdditionalManagedOrganization(client.db, {
    subjectId: ownerSubjectId,
    subjectLabel: "Organization owner",
    name: "Session policy organization",
    workspaceName: "Session policy workspace",
    operationId: crypto.randomUUID(),
  });
  await shared.admin`
    update managed_accounts set external_source = ${source}, external_id = ${crypto.randomUUID()}
    where id = ${created.organization.id}`;
  return {
    organizationId: created.organization.id,
    workspaceId: created.workspaceId,
    ownerSubjectId,
  };
}

type Organization = Awaited<ReturnType<typeof organization>>;

const PERSON_PERMISSIONS: Permission[] = [
  "workspace:read",
  "workspace:admin",
  "files:read",
  "files:upload",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:write",
  "documents:manage",
  "scheduled_tasks:manage",
  "enrollments:manage",
];

async function personBearer(org: Organization): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId: org.organizationId,
    workspaceId: org.workspaceId,
    subjectId: org.ownerSubjectId,
    permissions: PERSON_PERMISSIONS,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function hostBearer(org: Organization): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId: org.organizationId,
    workspaceId: org.workspaceId,
    subjectId: org.ownerSubjectId,
    permissions: ["members:manage"],
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: "test-host:governance" },
    exp: Math.floor(Date.now() / 1000) + 300,
  })}`;
}

function detailCode(body: unknown): string | undefined {
  return (body as { error?: { details?: { code?: string } } }).error?.details?.code;
}

async function requestUpload(app: App, org: Organization): Promise<Response> {
  return await app.request(`/v1/workspaces/${org.workspaceId}/files/uploads`, {
    method: "POST",
    headers: { authorization: await personBearer(org), "content-type": "application/json" },
    body: JSON.stringify({ filename: "notes.txt", contentType: "text/plain", sizeBytes: 12 }),
  });
}

async function uploadCount(org: Organization): Promise<number> {
  const [row] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from file_uploads where workspace_id = ${org.workspaceId}`;
  return row!.count;
}

async function workspaceClientConfig(app: App, org: Organization) {
  const response = await app.request(`/v1/config/client?workspaceId=${org.workspaceId}`, {
    headers: { authorization: await personBearer(org) },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { fileUploads: { enabled: boolean; maxSizeBytes: number } };
}

async function putHostPolicy(
  app: App,
  org: Organization,
  policy: unknown,
  options: { operationId?: string; expectedRevision?: number; authorization?: string } = {},
): Promise<Response> {
  return await app.request(`/v1/host/organizations/${org.organizationId}/session-policy`, {
    method: "PUT",
    headers: {
      authorization: options.authorization ?? (await hostBearer(org)),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      actingExternalUser,
      command: {
        policy,
        operationId: options.operationId ?? crypto.randomUUID(),
        expectedRevision: options.expectedRevision ?? 0,
      },
    }),
  });
}

async function getHostPolicy(app: App, org: Organization): Promise<Response> {
  return await app.request(`/v1/host/organizations/${org.organizationId}/session-policy`, {
    headers: { authorization: await hostBearer(org) },
  });
}

async function post(app: App, org: Organization, path: string, body: unknown = {}) {
  return await app.request(`/v1/workspaces/${org.workspaceId}${path}`, {
    method: "POST",
    headers: { authorization: await personBearer(org), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const OPEN_ALL = {
  attachments: "enabled",
  toolFamilies: { mode: "deny", families: [] },
} as const;

async function readyFile(org: Organization): Promise<string> {
  const fileId = crypto.randomUUID();
  const upload = await createFileUpload(client.db, {
    accountId: org.organizationId,
    workspaceId: org.workspaceId,
    fileId,
    filename: "notes.txt",
    safeFilename: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 12,
    sha256: null,
    bucket: "session-policy-bucket",
    objectKey: `workspaces/${org.workspaceId}/files/${fileId}/original/notes.txt`,
    expiresAt: new Date(Date.now() + 900_000),
    privateOwnerSubjectId: null,
    appShot: null,
  });
  await completeFileUpload(client.db, org.workspaceId, upload.uploadId);
  return fileId;
}

describe("attachment kill switch", () => {
  test("stock: uploads and the workspace client config are unchanged, and nothing is stored", async () => {
    const app = appFor();
    const org = await organization(HOST_SOURCE);
    const response = await requestUpload(app, org);
    expect(response.status).toBe(201);
    expect((await workspaceClientConfig(app, org)).fileUploads.enabled).toBe(true);
    expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toBeNull();
    const host = await putHostPolicy(app, org, STOCK_ORGANIZATION_SESSION_POLICY);
    expect(host.status).toBe(404);
  });

  test("a governed organization refuses uploads with ATTACHMENTS_DISABLED and reports uploads off", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const response = await requestUpload(app, org);
    expect(response.status).toBe(403);
    expect(detailCode(await response.json())).toBe("ATTACHMENTS_DISABLED");
    expect(await uploadCount(org)).toBe(0);
    expect((await workspaceClientConfig(app, org)).fileUploads.enabled).toBe(false);
    // The default is stored the first time the fork sees the organization
    // governed, so the worker, which has no port, reads the same policy.
    expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toMatchObject({
      policy: GOVERNED_ORGANIZATION_SESSION_POLICY,
      source: "governed_default",
    });
  });

  test("a governed organization refuses a message that attaches a file", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const fileId = await readyFile(org);
    const response = await app.request(`/v1/workspaces/${org.workspaceId}/sessions`, {
      method: "POST",
      headers: { authorization: await personBearer(org), "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "Summarize the attached notes.",
        resources: [{ kind: "file", fileId }],
      }),
    });
    expect(response.status).toBe(403);
    expect(detailCode(await response.json())).toBe("ATTACHMENTS_DISABLED");
  });

  test("an organization the host does not govern is unchanged", async () => {
    const app = appFor(hostPort);
    const org = await organization("someone-else");
    expect((await requestUpload(app, org)).status).toBe(201);
    expect((await workspaceClientConfig(app, org)).fileUploads.enabled).toBe(true);
    expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toBeNull();
    const host = await putHostPolicy(app, org, STOCK_ORGANIZATION_SESSION_POLICY);
    expect(host.status).toBe(403);
    expect(detailCode(await host.json())).toBe("ORGANIZATION_NOT_HOST_GOVERNED");
  });
});

describe("host session policy command", () => {
  test("until 1018's routine is granted, the command is unavailable and the default holds", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const response = await putHostPolicy(app, org, OPEN_ALL);
    expect(response.status).toBe(503);
    expect(detailCode(await response.json())).toBe("HOST_SESSION_POLICY_UNAVAILABLE");
    expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toMatchObject({
      policy: GOVERNED_ORGANIZATION_SESSION_POLICY,
      source: "governed_default",
    });
    expect((await requestUpload(app, org)).status).toBe(403);
    // Every later test runs as a deployment that has granted it.
    await grantDeferredRuntimeAccess(shared.admin);
  });

  test("the host turns attachments on; uploads then succeed and the client config follows", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const policy = {
      attachments: "enabled",
      toolFamilies: { mode: "deny", families: ["shell", "codemode", "browser", "computerUse"] },
    };
    const response = await putHostPolicy(app, org, policy);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { revision: number };
    expect(body).toMatchObject({ policy, source: "host", replay: false });
    expect((await requestUpload(app, org)).status).toBe(201);
    expect((await workspaceClientConfig(app, org)).fileUploads.enabled).toBe(true);
    const read = await getHostPolicy(app, org);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ policy, source: "host", revision: body.revision });
  });

  test("an operation id replays its own body, refuses another, and a stale revision never overwrites", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const operationId = crypto.randomUUID();
    const first = await putHostPolicy(app, org, OPEN_ALL, { operationId });
    expect(first.status).toBe(200);
    const { revision } = (await first.json()) as { revision: number };
    const replay = await putHostPolicy(app, org, OPEN_ALL, { operationId });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ revision, replay: true });
    const otherBody = await putHostPolicy(
      app,
      org,
      { ...OPEN_ALL, attachments: "disabled" },
      { operationId, expectedRevision: revision },
    );
    expect(otherBody.status).toBe(409);
    expect(detailCode(await otherBody.json())).toBe("SESSION_POLICY_OPERATION_CONFLICT");
    // A delayed command that still expects "no host policy" is refused.
    const delayed = await putHostPolicy(app, org, GOVERNED_ORGANIZATION_SESSION_POLICY, {
      expectedRevision: 0,
    });
    expect(delayed.status).toBe(409);
    expect(detailCode(await delayed.json())).toBe("SESSION_POLICY_REVISION_CONFLICT");
    expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toMatchObject({
      policy: OPEN_ALL,
      revision,
    });
    const next = await putHostPolicy(app, org, GOVERNED_ORGANIZATION_SESSION_POLICY, {
      expectedRevision: revision,
    });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ revision: revision + 1, replay: false });
  });

  test("the host's read has no side effect", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const read = await getHostPolicy(app, org);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      policy: GOVERNED_ORGANIZATION_SESSION_POLICY,
      source: "governed_default",
      revision: 0,
    });
    expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toBeNull();
    const [privacy] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from organization_host_command_attributions
      where account_id = ${org.organizationId}`;
    expect(privacy!.count).toBe(0);
  });

  test("native credentials cannot set the policy, and native settings cannot widen it", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const native = await putHostPolicy(app, org, OPEN_ALL, {
      authorization: await personBearer(org),
    });
    expect(native.status).toBe(401);
    expect(detailCode(await native.json())).toBe("HOST_COMMAND_SERVICE_TOKEN_REQUIRED");
    // A workspace admin turning every capability on for new sessions does not
    // reach the host's policy.
    const settings = await app.request(`/v1/workspaces/${org.workspaceId}`, {
      method: "PATCH",
      headers: { authorization: await personBearer(org), "content-type": "application/json" },
      body: JSON.stringify({ settings: { agent: { capabilities: "all" } } }),
    });
    expect(settings.status).toBeLessThan(500);
    expect((await requestUpload(app, org)).status).toBe(403);
    expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toMatchObject({
      policy: GOVERNED_ORGANIZATION_SESSION_POLICY,
    });
  });

  test("an invalid policy is refused and nothing changes", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const response = await putHostPolicy(app, org, {
      attachments: "enabled",
      toolFamilies: { mode: "deny", families: ["mcp"] },
    });
    expect(response.status).toBe(422);
    expect((await requestUpload(app, org)).status).toBe(403);
  });
});

describe("attachments on every person-facing entry", () => {
  test("knowledge drops, session file writes and schedule templates are refused", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    // Shell open, so the session file routes reach their attachment check.
    expect(
      (
        await putHostPolicy(app, org, {
          attachments: "disabled",
          toolFamilies: { mode: "allow", families: ["shell"] },
        })
      ).status,
    ).toBe(200);
    const drop = await post(app, org, "/knowledge/drops", { kind: "text", text: "Door code 1234" });
    expect(drop.status).toBe(403);
    expect(detailCode(await drop.json())).toBe("ATTACHMENTS_DISABLED");
    const sessionId = crypto.randomUUID();
    for (const operation of ["write", "move", "mkdir"]) {
      const response = await post(app, org, `/sessions/${sessionId}/fs/${operation}`, {});
      expect(response.status).toBe(403);
      expect(detailCode(await response.json())).toBe("ATTACHMENTS_DISABLED");
    }
    const schedule = await post(app, org, "/scheduled-tasks", {
      name: "Read notes",
      schedule: { type: "manual" },
      agentConfig: {
        prompt: "Read the notes.",
        resources: [{ kind: "file", fileId: await readyFile(org) }],
        tools: [],
      },
    });
    expect(schedule.status).toBe(403);
    expect(detailCode(await schedule.json())).toBe("ATTACHMENTS_DISABLED");
  });
});

describe("generic tool families", () => {
  test("Codemode refuses a governed organization with SESSION_TOOL_FAMILY_DENIED", async () => {
    const governed = await organization(HOST_SOURCE);
    const response = await appFor(hostPort).request(
      `/v1/workspaces/${governed.workspaceId}/codemode/catalog`,
      { headers: { authorization: await personBearer(governed) } },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { details: { code: "SESSION_TOOL_FAMILY_DENIED", family: "codemode" } },
    });
    // Stock keeps its own refusal for a credential that is not Codemode's.
    const stock = await organization(HOST_SOURCE);
    const stockResponse = await appFor().request(
      `/v1/workspaces/${stock.workspaceId}/codemode/catalog`,
      { headers: { authorization: await personBearer(stock) } },
    );
    expect(stockResponse.status).toBe(403);
    expect(detailCode(await stockResponse.json())).toBeUndefined();
  });

  test("browser, computer and terminal routes refuse a governed organization", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const sessionId = crypto.randomUUID();
    const enrollmentId = crypto.randomUUID();
    for (const [path, family] of [
      [`/v1/workspaces/${org.workspaceId}/browser-sessions`, "browser"],
      [`/v1/workspaces/${org.workspaceId}/computer-sessions`, "computerUse"],
      [`/v1/workspaces/${org.workspaceId}/machines/${enrollmentId}/screen-control`, "computerUse"],
      [`/v1/workspaces/${org.workspaceId}/enrollments/token`, "shell"],
      [`/v1/workspaces/${org.workspaceId}/enrollments/device/approve`, "shell"],
      [`/v1/workspaces/${org.workspaceId}/sessions/${sessionId}/terminal/exec`, "shell"],
      [`/v1/workspaces/${org.workspaceId}/sessions/${sessionId}/fs/list`, "shell"],
      [`/v1/workspaces/${org.workspaceId}/sessions/${sessionId}/fs/write`, "shell"],
      [`/v1/workspaces/${org.workspaceId}/sessions/${sessionId}/git/status`, "shell"],
      [`/v1/workspaces/${org.workspaceId}/codemode/calls`, "codemode"],
    ] as const) {
      const response = await app.request(path, {
        method: "POST",
        headers: { authorization: await personBearer(org), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toMatchObject({
        error: { details: { code: "SESSION_TOOL_FAMILY_DENIED", family } },
      });
    }
    // Unauthenticated callers learn nothing about the policy.
    const anonymous = await app.request(`/v1/workspaces/${org.workspaceId}/browser-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(anonymous.status).toBe(401);
  });

  test("a host allowlist reopens only the families it names", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const put = await putHostPolicy(app, org, {
      attachments: "disabled",
      toolFamilies: { mode: "allow", families: ["browser"] },
    });
    expect(put.status).toBe(200);
    const browser = await app.request(`/v1/workspaces/${org.workspaceId}/browser-sessions`, {
      method: "POST",
      headers: { authorization: await personBearer(org), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(detailCode(await browser.json())).not.toBe("SESSION_TOOL_FAMILY_DENIED");
    const computer = await app.request(`/v1/workspaces/${org.workspaceId}/computer-sessions`, {
      method: "POST",
      headers: { authorization: await personBearer(org), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(detailCode(await computer.json())).toBe("SESSION_TOOL_FAMILY_DENIED");
  });

  test("stock and ungoverned organizations keep their browser routes", async () => {
    for (const [app, source] of [
      [appFor(), HOST_SOURCE],
      [appFor(hostPort), "someone-else"],
    ] as const) {
      const org = await organization(source);
      const response = await app.request(`/v1/workspaces/${org.workspaceId}/browser-sessions`, {
        method: "POST",
        headers: { authorization: await personBearer(org), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(detailCode(await response.json())).not.toBe("SESSION_TOOL_FAMILY_DENIED");
    }
  });
});
