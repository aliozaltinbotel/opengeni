import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  signDelegatedAccessToken,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import type { OrganizationGovernancePort } from "@opengeni/contracts/organization-governance";
import { sessionToolFamilyOf } from "@opengeni/contracts/organization-session-policy";
import { createValidatedScheduledTask, type AppDependencies } from "@opengeni/core";
import {
  bootstrapWorkspace,
  completeFileUpload,
  createDb,
  createFileUpload,
  getOrganizationSessionPolicy,
  initializeSessionStartAtomically,
  listSessionEvents,
  type DbClient,
} from "@opengeni/db";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { assistantMessage, functionCall, ScriptedModel } from "@opengeni/testing/scripted-model";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../../api/src/app";
import { createActivityTestHarness } from "../src/activities";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

/*
 * The host's real path: it provisions a tenant organization with
 * bootstrapWorkspace (nothing else), then starts a service session without
 * files through the API. The API stores the governed session policy at that
 * entry point, so the worker's first turn of that session already has no
 * shell, Codemode, browser or computer-use tools, and a forged call to one is
 * never executed. A schedule created before any session is covered the same
 * way. The stock control turn shows the same catalog does carry those tools.
 */

const HOST_SOURCE = "test-host:tenant";
const delegationSecret = "governed-tenant-first-turn-delegation-32";
const hostPort: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: ({ via }) => (via === "host" ? "allow" : "refuse"),
};

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("governed-tenant-first-turn");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function settings() {
  return testSettings({
    databaseUrl: shared.appUrl,
    productAccessMode: "configured",
    delegationSecret,
    openaiModel: "scripted-model",
    sandboxBackend: "none",
  });
}

function apiFor(organizationGovernance?: OrganizationGovernancePort) {
  return createApp({
    settings: settings(),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
      // A manual schedule has no Temporal schedule to keep in sync here.
      syncScheduledTask: async () => undefined,
      deleteScheduledTask: async () => undefined,
    } as never,
    ...(organizationGovernance ? { organizationGovernance } : {}),
  } as AppDependencies);
}

/** What the host does to provision a tenant: bootstrapWorkspace and nothing else. */
async function provision(source: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: source,
    accountExternalId: `tenant-${suffix}`,
    accountName: "Tenant",
    workspaceExternalSource: "test-host:workspace",
    workspaceExternalId: `tenant-${suffix}`,
    workspaceName: "Tenant workspace",
    subjectId: `test-host:provisioner:${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

const SERVICE_PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "scheduled_tasks:manage",
];

async function serviceBearer(grant: { accountId: string; workspaceId: string; subjectId: string }) {
  return `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: SERVICE_PERMISSIONS,
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: "test-host:sessions" },
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`;
}

function harness(model: ScriptedModel) {
  const production = createProductionAgentRuntime({ model });
  type ResolvedTurnModel = ReturnType<OpenGeniRuntime["resolveTurnModel"]>;
  // An offline model needs only the fields the turn reads.
  const resolved = {
    provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
    client: {},
    model,
    configured: {
      id: "scripted-model",
      label: "Offline",
      providerId: "test-chat",
      providerLabel: "Offline",
      api: "chat",
      contextWindowTokens: 250_000,
      effectiveContextWindowTokens: 250_000,
      autoCompactTokenLimit: 225_000,
      reasoningEffort: false,
      hostedWebSearch: false,
      capabilities: {
        latencyModes: ["standard"],
        inputModalities: ["text"],
        inputFileMediaTypes: [],
      },
    },
  } as unknown as ResolvedTurnModel;
  const runtime: OpenGeniRuntime = {
    ...production,
    configure: () => {},
    resolveTurnModel: () => resolved,
  };
  return createActivityTestHarness({
    settings: settings(),
    db: client.db,
    bus: new MemoryEventBus(),
    runtime,
  });
}

async function firstTurn(
  grant: { accountId: string; workspaceId: string },
  sessionId: string,
  model: ScriptedModel,
) {
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  await harness(model).runAgentTurn({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    workflowId: started.temporalWorkflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  const request = model.requests[0];
  if (!request) {
    const events = await listSessionEvents(client.db, grant.workspaceId, sessionId, {
      after: 0,
      limit: 200,
    });
    throw new Error(
      `the turn never reached the model: ${JSON.stringify(events.map((e) => [e.type, e.payload])).slice(0, 3000)}`,
    );
  }
  return request.tools.map((tool) => (tool as { name?: string }).name ?? "");
}

async function createServiceSession(
  api: ReturnType<typeof createApp>,
  grant: Awaited<ReturnType<typeof provision>>,
): Promise<string> {
  const response = await api.request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
    method: "POST",
    headers: { authorization: await serviceBearer(grant), "content-type": "application/json" },
    body: JSON.stringify({ initialMessage: "What is on today?" }),
  });
  const body = (await response.json()) as { id?: string; session?: { id: string } };
  if (response.status >= 300)
    throw new Error(`session create: ${response.status} ${JSON.stringify(body)}`);
  const id = body.session?.id ?? body.id;
  if (!id) throw new Error(`session create returned no id: ${JSON.stringify(body)}`);
  return id;
}

function generic(tools: readonly string[]): string[] {
  return tools.filter((name) => sessionToolFamilyOf(name) !== null);
}

describe("a governed tenant's first turn", () => {
  test("stock control: the same path's first turn carries generic tools", async () => {
    const grant = await provision(HOST_SOURCE);
    const sessionId = await createServiceSession(apiFor(), grant);
    expect(await getOrganizationSessionPolicy(client.db, grant.accountId)).toBeNull();
    const model = new ScriptedModel([{ output: [assistantMessage("Nothing today.")] }]);
    const tools = await firstTurn(grant, sessionId, model);
    // Without a sandbox, the desktop (computer-use) tools are what the stock
    // catalog offers of the generic families.
    expect(generic(tools)).toContain("interaction__cua_click");
  });

  test("bootstrap, then a service session without files: the first turn has no generic tools", async () => {
    const grant = await provision(HOST_SOURCE);
    // bootstrapWorkspace stored nothing; the API's session entry stores the default.
    expect(await getOrganizationSessionPolicy(client.db, grant.accountId)).toBeNull();
    const sessionId = await createServiceSession(apiFor(hostPort), grant);
    expect(await getOrganizationSessionPolicy(client.db, grant.accountId)).toMatchObject({
      source: "governed_default",
      policy: { attachments: "disabled" },
    });
    // The model forges a call to a tool its catalog never had.
    const model = new ScriptedModel([
      { output: [functionCall("browser_open", { url: "https://example.test" })] },
      { output: [assistantMessage("Done.")] },
      { output: [assistantMessage("Done.")] },
    ]);
    const tools = await firstTurn(grant, sessionId, model);
    expect(tools.length).toBeGreaterThan(0);
    expect(generic(tools)).toEqual([]);
    // The forged call was never executed: no browser session exists.
    const [browsers] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from browser_sessions where workspace_id = ${grant.workspaceId}`;
    expect(browsers!.count).toBe(0);
    const events = await listSessionEvents(client.db, grant.workspaceId, sessionId, {
      after: 0,
      limit: 200,
    });
    const succeeded = events.filter(
      (event) =>
        event.type === "agent.toolCall.output" &&
        JSON.stringify(event.payload).includes("browser_open") &&
        !JSON.stringify(event.payload).toLowerCase().includes("not found"),
    );
    expect(succeeded.filter((event) => JSON.stringify(event.payload).includes("tabId"))).toEqual(
      [],
    );
  });

  test("a schedule created before any session fires a first turn with no generic tools", async () => {
    const grant = await provision(HOST_SOURCE);
    const api = apiFor(hostPort);
    const created = await api.request(`/v1/workspaces/${grant.workspaceId}/scheduled-tasks`, {
      method: "POST",
      headers: { authorization: await serviceBearer(grant), "content-type": "application/json" },
      body: JSON.stringify(
        CreateScheduledTaskRequest.parse({
          name: "Morning brief",
          schedule: { type: "manual" },
          agentConfig: { prompt: "Brief me.", resources: [], tools: [] },
        }),
      ),
    });
    const createdBody = (await created.json()) as { id: string };
    if (created.status !== 201) throw new Error(`schedule create: ${JSON.stringify(createdBody)}`);
    // The schedule's entry stored the default before any session existed.
    expect(await getOrganizationSessionPolicy(client.db, grant.accountId)).toMatchObject({
      source: "governed_default",
    });
    const activities = createScheduledTaskActivities(
      async () =>
        ({
          settings: settings(),
          db: client.db,
          bus: new MemoryEventBus(),
          wakeSessionWorkflow: async () => undefined,
        }) as unknown as ActivityServices,
    );
    const run = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: createdBody.id,
      triggerType: "scheduled",
      producerKey: `governed-first-turn-${crypto.randomUUID()}`,
    });
    if (run.action !== "start" && run.action !== "signal")
      throw new Error(`schedule did not fire: ${JSON.stringify(run)}`);
    const model = new ScriptedModel([{ output: [assistantMessage("Brief.")] }]);
    const tools = await firstTurn(grant, run.sessionId, model);
    expect(tools.length).toBeGreaterThan(0);
    expect(generic(tools)).toEqual([]);
  });

  test("a file attached to a schedule is refused when it fires after attachments were turned off", async () => {
    const grant = await provision(HOST_SOURCE);
    const fileId = crypto.randomUUID();
    const upload = await createFileUpload(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      fileId,
      filename: "notes.txt",
      safeFilename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      bucket: "test",
      objectKey: `workspaces/${grant.workspaceId}/files/${fileId}/original/notes.txt`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await completeFileUpload(client.db, grant.workspaceId, upload.uploadId);
    // Saved while the organization was stock (no policy stored yet).
    const serviceGrant: AccessGrant = {
      ...(grant as unknown as AccessGrant),
      principalKind: "service",
    };
    const task = await createValidatedScheduledTask({
      settings: settings(),
      db: client.db,
      grant: serviceGrant,
      payload: CreateScheduledTaskRequest.parse({
        name: "Read notes",
        schedule: { type: "manual" },
        agentConfig: {
          prompt: "Read the notes.",
          resources: [{ kind: "file", fileId }],
          tools: [],
        },
      }),
      toolsProvided: true,
      objectStorage: {} as NonNullable<
        Parameters<typeof createValidatedScheduledTask>[0]["objectStorage"]
      >,
    });
    await shared.admin`insert into organization_session_policies
        (account_id, attachments, tool_family_mode, tool_families, source)
      values (${grant.accountId}, 'disabled', 'deny',
        ARRAY['shell','codemode','browser','computerUse']::text[], 'governed_default')`;
    const activities = createScheduledTaskActivities(
      async () =>
        ({
          settings: settings(),
          db: client.db,
          bus: new MemoryEventBus(),
          wakeSessionWorkflow: async () => undefined,
        }) as unknown as ActivityServices,
    );
    const run = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `governed-files-${crypto.randomUUID()}`,
    });
    expect(run).toEqual({ action: "blocked", reason: "attachments_disabled" });
  });
});
