import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { OrganizationGovernancePort } from "@opengeni/contracts/organization-governance";
import {
  GOVERNED_ORGANIZATION_SESSION_POLICY,
  STOCK_ORGANIZATION_SESSION_POLICY,
} from "@opengeni/contracts/organization-session-policy";
import {
  storeGovernedOrganizationSessionPolicyDefaults,
  type AppDependencies,
} from "@opengeni/core";
import {
  completeFileUpload,
  createAdditionalManagedOrganization,
  createAutomationSource,
  createAutomationTrigger,
  createManagedOrganization,
  createDb,
  createFileUpload,
  getOrganizationSessionPolicy,
  type DbClient,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import type { ObjectStorage } from "@opengeni/storage";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, createAppComposition } from "../src/app";
import { startGovernedSessionPolicyBackfill } from "../src/governed-session-policy-backfill";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

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
  // Tests run as a deployment that has granted 1020's recordings routine; the
  // one that needs it withheld revokes it and restores the grant.
  await grantDeferredRuntimeAccess(shared.admin);
}, 180_000);

const HOST_ROUTINE =
  "opengeni_private.put_host_organization_session_policy(uuid, text, uuid, text, text, text[], text, bigint)";

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
  return createApp(depsFor(organizationGovernance));
}

function depsFor(organizationGovernance?: OrganizationGovernancePort): AppDependencies {
  return {
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
    workflowClient: {
      syncScheduledTask: async () => undefined,
      deleteScheduledTask: async () => undefined,
      triggerAutomationRun: async () => undefined,
    } as never,
    objectStorage: storageStub(),
    ...(organizationGovernance ? { organizationGovernance } : {}),
  } as AppDependencies;
}

/** An organization the host provisions out of band, like a tenant, with its own owner. */
// Each owner creates a bounded number of organizations, and sign-ins are rate
// limited, so a few organizations share one owner.
let currentOwner: { subjectId: string; organizations: number } | null = null;
async function nextOwner(): Promise<string> {
  if (!currentOwner || currentOwner.organizations >= 3)
    currentOwner = { subjectId: await signUpOwner(appFor()), organizations: 0 };
  currentOwner.organizations += 1;
  return currentOwner.subjectId;
}

async function organization(source: string) {
  const ownerSubjectId = await nextOwner();
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

  test("the workspace client config reports a governed organization's uploads off without storing anything", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    expect((await workspaceClientConfig(app, org)).fileUploads.enabled).toBe(false);
    expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toBeNull();
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
  test("1019 grants 1018's routine to the runtime", async () => {
    const [row] = await shared.admin<{ granted: boolean | null }[]>`
      select has_function_privilege('opengeni_app', to_regprocedure(${HOST_ROUTINE})::oid,
        'EXECUTE') as granted`;
    expect(row?.granted).toBe(true);
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

describe("automations, MCP and the startup pass", () => {
  test("automation triggers and manual events that attach files are refused", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const fileId = await readyFile(org);
    const source = await createAutomationSource(client.db, {
      accountId: org.organizationId,
      workspaceId: org.workspaceId,
      createdBySubjectId: org.ownerSubjectId,
      webhookSecretEncrypted: "test-ciphertext",
      request: {
        name: "Events",
        adapterId: "signed-json.v1",
        webhookSecret: "never-stored",
        configuration: {},
      },
    });
    const template = {
      prompt: "Read the notes",
      instructions: null,
      resources: [{ kind: "file", fileId }],
      skills: [],
      tools: [],
      firstPartyMcpTools: [],
      firstPartyMcpPermissions: [],
      model: null,
      reasoningEffort: null,
      sandboxBackend: null,
      policyRole: null,
      metadata: {},
    };
    const created = await post(app, org, "/automations/triggers", {
      sourceId: source.id,
      name: "Notes",
      eventTypes: ["notes.arrived"],
      configuration: {},
      parameters: {},
      sessionTemplate: template,
      status: "active",
    });
    expect(created.status).toBe(403);
    expect(detailCode(await created.json())).toBe("ATTACHMENTS_DISABLED");
    // A trigger saved while the organization was stock.
    await createAutomationTrigger(client.db, {
      accountId: org.organizationId,
      workspaceId: org.workspaceId,
      createdBySubjectId: org.ownerSubjectId,
      adapterId: source.adapterId,
      request: {
        sourceId: source.id,
        name: "Notes",
        eventTypes: ["notes.arrived"],
        configuration: {},
        parameters: {},
        sessionTemplate: template as never,
        status: "active",
      },
    });
    const event = await post(app, org, `/automations/sources/${source.id}/events`, {
      eventType: "notes.arrived",
      occurrenceKey: crypto.randomUUID(),
      payload: {},
    });
    expect(event.status).toBe(403);
    expect(detailCode(await event.json())).toBe("ATTACHMENTS_DISABLED");
  });

  test("MCP scheduled_tasks_trigger refuses a schedule that attaches files", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const policyRevision = async () =>
      (await getOrganizationSessionPolicy(client.db, org.organizationId))?.revision ?? 0;
    // Saved while the host allowed attachments, then turned off.
    expect((await putHostPolicy(app, org, OPEN_ALL)).status).toBe(200);
    const created = await post(app, org, "/scheduled-tasks", {
      name: "Read notes",
      schedule: { type: "manual" },
      agentConfig: {
        prompt: "Read the notes.",
        resources: [{ kind: "file", fileId: await readyFile(org) }],
        tools: [],
      },
    });
    const task = (await created.json()) as { id: string };
    expect(created.status).toBe(201);
    expect(
      (
        await putHostPolicy(app, org, GOVERNED_ORGANIZATION_SESSION_POLICY, {
          expectedRevision: await policyRevision(),
        })
      ).status,
    ).toBe(200);
    const { routeDeps } = createAppComposition(depsFor(hostPort));
    const server = buildOpenGeniMcpServer(routeDeps, {
      accountId: org.organizationId,
      workspaceId: org.workspaceId,
      subjectId: org.ownerSubjectId,
      permissions: ["scheduled_tasks:run", "scheduled_tasks:manage"],
      principalKind: "human_session",
    });
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools.scheduled_tasks_trigger;
    if (!tool) throw new Error("scheduled_tasks_trigger is not registered");
    const refused = await tool.handler({ id: task.id }, {}).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const outcome = JSON.stringify(refused);
    expect(outcome).toContain("ATTACHMENTS_DISABLED");
  });

  test("the startup pass stores the default for governed organizations without one", async () => {
    const governed = await organization(HOST_SOURCE);
    const ungoverned = await organization("someone-else");
    expect(await getOrganizationSessionPolicy(client.db, governed.organizationId)).toBeNull();
    const deps = { db: client.db, organizationGovernance: hostPort };
    const first = await storeGovernedOrganizationSessionPolicyDefaults(deps, { pageSize: 2 });
    expect(first.stored).toBeGreaterThanOrEqual(1);
    expect(await getOrganizationSessionPolicy(client.db, governed.organizationId)).toMatchObject({
      source: "governed_default",
    });
    expect(await getOrganizationSessionPolicy(client.db, ungoverned.organizationId)).toBeNull();
    expect((await storeGovernedOrganizationSessionPolicyDefaults(deps)).stored).toBe(0);
    expect(await storeGovernedOrganizationSessionPolicyDefaults({ db: client.db })).toEqual({
      governed: 0,
      stored: 0,
      failed: 0,
    });
  });

  test("the startup pass isolates each organization: one that fails does not stop the others", async () => {
    const [first, broken, last] = [
      await organization(HOST_SOURCE),
      await organization(HOST_SOURCE),
      await organization(HOST_SOURCE),
    ];
    const port: OrganizationGovernancePort = {
      ...hostPort,
      governs: (input) => {
        if (input.organizationId === broken!.organizationId) throw new Error("port failure");
        return hostPort.governs(input);
      },
    };
    const outcomes = new Map<string, string>();
    const result = await storeGovernedOrganizationSessionPolicyDefaults(
      { db: client.db, organizationGovernance: port },
      {
        pageSize: 1,
        onOrganization: ({ organizationId, outcome }) => outcomes.set(organizationId, outcome),
      },
    );
    expect(result.failed).toBe(1);
    expect(outcomes.get(broken!.organizationId)).toBe("failed");
    for (const org of [first!, last!]) {
      expect(outcomes.get(org.organizationId)).toBe("stored");
      expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toMatchObject({
        source: "governed_default",
      });
    }
    expect(await getOrganizationSessionPolicy(client.db, broken!.organizationId)).toBeNull();
    // Run again: what is stored is reported present, and the failure again.
    outcomes.clear();
    await storeGovernedOrganizationSessionPolicyDefaults(
      { db: client.db, organizationGovernance: port },
      { onOrganization: ({ organizationId, outcome }) => outcomes.set(organizationId, outcome) },
    );
    expect(outcomes.get(first!.organizationId)).toBe("present");
    expect(outcomes.get(broken!.organizationId)).toBe("failed");
  });

  test("the API runs the pass in the background and reports every outcome", async () => {
    const broken = await organization(HOST_SOURCE);
    const fresh = await organization(HOST_SOURCE);
    const port: OrganizationGovernancePort = {
      ...hostPort,
      governs: (input) => {
        if (input.organizationId === broken.organizationId) throw new TypeError("port failure");
        return hostPort.governs(input);
      },
    };
    const counters: { outcome: string; amount: number }[] = [];
    const logs: { level: string; message: string; attributes: Record<string, unknown> }[] = [];
    const diagnostics: { code: string; stage: string; organizationId?: string }[] = [];
    const observability = {
      recordFailureDiagnostic: (input: {
        code: string;
        stage: string;
        organizationId?: string;
      }) => {
        diagnostics.push(input);
        return "00000000-0000-4000-8000-000000000001";
      },
      incrementCounter: (input: { labels?: Record<string, string>; amount?: number }) =>
        counters.push({ outcome: input.labels?.outcome ?? "", amount: input.amount ?? 1 }),
      info: (message: string, attributes: Record<string, unknown> = {}) =>
        logs.push({ level: "info", message, attributes }),
      warn: (message: string, attributes: Record<string, unknown> = {}) =>
        logs.push({ level: "warn", message, attributes }),
      error: (message: string, attributes: Record<string, unknown> = {}) =>
        logs.push({ level: "error", message, attributes }),
    };
    const pass = startGovernedSessionPolicyBackfill(
      { db: client.db, organizationGovernance: port },
      observability,
    );
    // Returned at once, before any organization is visited.
    expect(counters).toEqual([]);
    const result = await pass;
    expect(result?.failed).toBe(1);
    expect(await getOrganizationSessionPolicy(client.db, fresh.organizationId)).toMatchObject({
      source: "governed_default",
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "governed_session_policy_default_failed",
        stage: "governed_session_policy.startup_pass",
        organizationId: broken.organizationId,
      }),
    ]);
    const failure = logs.find((log) => log.level === "warn");
    expect(failure?.attributes).toEqual({
      errorClass: "OperationError",
      errorCode: "governed_session_policy_default_failed",
      origin: "api",
      correlationId: "00000000-0000-4000-8000-000000000001",
    });
    const total = (outcome: string) =>
      counters.filter((counter) => counter.outcome === outcome).reduce((n, c) => n + c.amount, 0);
    expect(total("failed")).toBe(1);
    expect(total("stored")).toBeGreaterThanOrEqual(1);
    expect(logs.at(-1)).toMatchObject({
      level: "info",
      message: "governed session policy defaults stored",
      attributes: { failed: 1 },
    });
  });
});

describe("the startup pass in production telemetry", () => {
  test("public logs keep the pass's fields; the organization id stays in the protected diagnostic", async () => {
    const broken = await organization(HOST_SOURCE);
    await organization(HOST_SOURCE);
    const port: OrganizationGovernancePort = {
      ...hostPort,
      governs: (input) => {
        if (input.organizationId === broken.organizationId) throw new TypeError("port failure");
        return hostPort.governs(input);
      },
    };
    const exported: { url: string; body: unknown }[] = [];
    const observability = createObservability(
      {
        observabilityStructuredLogs: true,
        serviceName: "opengeni",
        environment: "test",
        observabilityDiagnosticsEndpoint: "https://diagnostics.example.test",
      } as never,
      {
        component: "api",
        exporter: async (url, body) => {
          exported.push({ url, body });
        },
      },
    );
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (line: string) => lines.push(line);
    console.warn = (line: string) => lines.push(line);
    console.error = (line: string) => lines.push(line);
    try {
      await startGovernedSessionPolicyBackfill(
        { db: client.db, organizationGovernance: port },
        observability,
      );
      await observability.flush();
    } finally {
      Object.assign(console, original);
    }
    const records = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const warning = records.find(
      (record) => record.message === "governed session policy default could not be stored",
    );
    // Read before matching: an asymmetric matcher may stand in for it afterwards.
    const correlationId = warning?.correlationId;
    expect(warning).toMatchObject({
      level: "warn",
      errorCode: "governed_session_policy_default_failed",
      origin: "api",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // An organization id is an identifier: never public telemetry.
    expect(JSON.stringify(records)).not.toContain(broken.organizationId);
    const summary = records.find(
      (record) => record.message === "governed session policy defaults stored",
    );
    expect(summary).toMatchObject({
      level: "info",
      governed: expect.any(Number),
      stored: expect.any(Number),
      failed: 1,
      durationMs: expect.any(Number),
    });
    const diagnostics = exported
      .filter(({ url }) => url === "https://diagnostics.example.test/v1/logs")
      .map(({ body }) => {
        const logs = body as {
          resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[];
        };
        return JSON.parse(logs.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.body.stringValue) as {
          diagnosticId: string;
          code: string;
          stage: string;
          organizationId?: string;
        };
      });
    expect(typeof correlationId).toBe("string");
    expect(diagnostics.find((record) => record.diagnosticId === correlationId)).toMatchObject({
      code: "governed_session_policy_default_failed",
      stage: "governed_session_policy.startup_pass",
      organizationId: broken.organizationId,
    });
  });
});

describe("guard order", () => {
  test("an unauthenticated request to a guarded route writes nothing", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    for (const path of [
      `/v1/workspaces/${org.workspaceId}/browser-sessions`,
      `/v1/workspaces/${org.workspaceId}/sessions/${crypto.randomUUID()}/fs/write`,
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
    }
    expect(await getOrganizationSessionPolicy(client.db, org.organizationId)).toBeNull();
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

const RECORDINGS_ROUTINE =
  "opengeni_private.set_host_organization_session_recordings(uuid, text, uuid, text)";
const RECORDING_INPUTS = [
  "/recordings",
  `/recordings/${crypto.randomUUID()}/uploads`,
  `/recordings/${crypto.randomUUID()}/chunks/complete`,
  `/recordings/${crypto.randomUUID()}/finalize`,
  `/recordings/${crypto.randomUUID()}/transcripts`,
  `/recordings/${crypto.randomUUID()}/live-session`,
  `/recordings/${crypto.randomUUID()}/live-segments`,
  "/transcription-recordings",
  `/transcription-recordings/${crypto.randomUUID()}/finalize`,
  "/transcriptions",
];

async function recordingCodes(app: App, org: Organization): Promise<(string | undefined)[]> {
  return await Promise.all(
    RECORDING_INPUTS.map(async (path) => {
      const response = await post(app, org, path);
      const code = detailCode(await response.json().catch(() => ({})));
      return response.status === 403 ? code : undefined;
    }),
  );
}

describe("recordings follow the session policy", () => {
  test("a governed organization refuses every recording input with SESSION_RECORDINGS_DENIED; reads stay open", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    expect(await recordingCodes(app, org)).toEqual(
      RECORDING_INPUTS.map(() => "SESSION_RECORDINGS_DENIED"),
    );
    const list = await app.request(`/v1/workspaces/${org.workspaceId}/recordings`, {
      headers: { authorization: await personBearer(org) },
    });
    expect(list.status).toBe(200);
    // The governed default read back names no recordings field (the host's
    // strict parsers keep working); the default for its source applies.
    const read = (await (await getHostPolicy(app, org)).json()) as { policy: object };
    expect(read.policy).toEqual(GOVERNED_ORGANIZATION_SESSION_POLICY);
  });

  test("stock and ungoverned organizations keep their recording routes", async () => {
    for (const [app, source] of [
      [appFor(), HOST_SOURCE],
      [appFor(hostPort), "someone-else"],
    ] as const) {
      const org = await organization(source);
      expect(await recordingCodes(app, org)).toEqual(RECORDING_INPUTS.map(() => undefined));
    }
  });

  test("the host allows recordings; attachments off still refuse them, attachments on admit them", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const closed = await putHostPolicy(app, org, {
      ...GOVERNED_ORGANIZATION_SESSION_POLICY,
      recordings: "allowed",
    });
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as {
      policy: { recordings?: string };
      revision: number;
    };
    expect(closedBody.policy.recordings).toBe("allowed");
    expect(await recordingCodes(app, org)).toEqual(
      RECORDING_INPUTS.map(() => "ATTACHMENTS_DISABLED"),
    );
    // A later command that does not name recordings keeps the stored setting.
    const open = await putHostPolicy(app, org, OPEN_ALL, {
      expectedRevision: closedBody.revision,
    });
    expect(open.status).toBe(200);
    expect(((await open.json()) as { policy: { recordings?: string } }).policy.recordings).toBe(
      "allowed",
    );
    expect(await recordingCodes(app, org)).toEqual(RECORDING_INPUTS.map(() => undefined));
  });

  test("a host that denies recordings explicitly is refused with SESSION_RECORDINGS_DENIED", async () => {
    const app = appFor(hostPort);
    const org = await organization(HOST_SOURCE);
    const operationId = crypto.randomUUID();
    const policy = { ...OPEN_ALL, recordings: "denied" };
    expect((await putHostPolicy(app, org, policy, { operationId })).status).toBe(200);
    // The same operation and body replays.
    const replay = await putHostPolicy(app, org, policy, { operationId });
    expect(((await replay.json()) as { replay: boolean }).replay).toBe(true);
    expect(await recordingCodes(app, org)).toEqual(
      RECORDING_INPUTS.map(() => "SESSION_RECORDINGS_DENIED"),
    );
    // Uploads follow attachments alone.
    expect((await requestUpload(app, org)).status).toBe(201);
  });

  test("until 1020's routine is granted, a command naming recordings is unavailable; one without it is not", async () => {
    await shared.admin.unsafe(`REVOKE EXECUTE ON FUNCTION ${RECORDINGS_ROUTINE} FROM opengeni_app`);
    try {
      const app = appFor(hostPort);
      const org = await organization(HOST_SOURCE);
      const operationId = crypto.randomUUID();
      const named = await putHostPolicy(
        app,
        org,
        { ...OPEN_ALL, recordings: "allowed" },
        {
          operationId,
        },
      );
      expect(named.status).toBe(503);
      expect(detailCode(await named.json())).toBe("HOST_SESSION_POLICY_UNAVAILABLE");
      const [attributions] = await shared.admin<{ count: number }[]>`
        select count(*)::int as count from organization_host_command_attributions
        where account_id = ${org.organizationId} and operation_id = ${operationId}`;
      expect(attributions!.count).toBe(0);
      expect((await putHostPolicy(app, org, OPEN_ALL)).status).toBe(200);
      expect(await recordingCodes(app, org)).toEqual(
        RECORDING_INPUTS.map(() => "SESSION_RECORDINGS_DENIED"),
      );
    } finally {
      await shared.admin.unsafe(`GRANT EXECUTE ON FUNCTION ${RECORDINGS_ROUTINE} TO opengeni_app`);
    }
  });
});
