import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { OrganizationGovernancePort } from "@opengeni/contracts/organization-governance";
import type { AppDependencies } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  initializeSessionStartAtomically,
  type DbClient,
} from "@opengeni/db";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { assistantMessage, ScriptedModel } from "@opengeni/testing/scripted-model";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../../api/src/app";
import { createActivityTestHarness } from "../src/activities";

/*
 * `reasoningDisclosure: "withheld"` on the worker's governance port: a turn of
 * an organization the host governs asks the provider for no reasoning summary
 * (`reasoningSummary: "none"`); every other turn keeps the stock request.
 */
const HOST_SOURCE = "test-host:reasoning-tenant";
const delegationSecret = "reasoning-disclosure-turn-delegation-32";
const hostPort: OrganizationGovernancePort = {
  governs: ({ externalSource }) => externalSource === HOST_SOURCE,
  decide: ({ via }) => (via === "host" ? "allow" : "refuse"),
};
const withheldPort: OrganizationGovernancePort = { ...hostPort, reasoningDisclosure: "withheld" };

setDefaultTimeout(60_000);

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("reasoning-disclosure-turn");
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

async function createSession(grant: Awaited<ReturnType<typeof provision>>): Promise<string> {
  const api = createApp({
    settings: settings(),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      wakeSessionWorkflow: async () => undefined,
      requestSessionWorkflowWakeDispatch: async () => undefined,
    } as never,
    organizationGovernance: hostPort,
  } as AppDependencies);
  const bearer = `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control"],
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId: "test-host:sessions" },
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`;
  const response = await api.request(`/v1/workspaces/${grant.workspaceId}/sessions`, {
    method: "POST",
    headers: { authorization: bearer, "content-type": "application/json" },
    body: JSON.stringify({ initialMessage: "Is unit 4 ready?" }),
  });
  const body = (await response.json()) as { id?: string; session?: { id: string } };
  if (response.status >= 300) throw new Error(`session create: ${JSON.stringify(body)}`);
  return (body.session?.id ?? body.id)!;
}

/** Runs the session's first turn and returns the reasoning summary its agent was built with. */
async function requestedSummary(
  source: string,
  organizationGovernance: OrganizationGovernancePort | undefined,
): Promise<string | undefined> {
  const grant = await provision(source);
  const sessionId = await createSession(grant);
  const model = new ScriptedModel([{ output: [assistantMessage("Ready.")] }]);
  const production = createProductionAgentRuntime({ model });
  type ResolvedTurnModel = ReturnType<OpenGeniRuntime["resolveTurnModel"]>;
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
  const summaries: Array<string | undefined> = [];
  const runtime: OpenGeniRuntime = {
    ...production,
    configure: () => {},
    resolveTurnModel: () => resolved,
    buildAgent: (agentSettings, tools, options) => {
      summaries.push(options?.reasoningSummary);
      return production.buildAgent(agentSettings, tools, options);
    },
  };
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  await createActivityTestHarness({
    settings: settings(),
    db: client.db,
    bus: new MemoryEventBus(),
    runtime,
    ...(organizationGovernance ? { organizationGovernance } : {}),
  }).runAgentTurn({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    workflowId: started.temporalWorkflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(model.requests.length).toBeGreaterThan(0);
  expect(summaries.length).toBeGreaterThan(0);
  return summaries[0];
}

describe("reasoning summary request", () => {
  test("a withheld governed organization's turn requests no summary", async () => {
    expect(await requestedSummary(HOST_SOURCE, withheldPort)).toBe("none");
  });

  test("an ungoverned organization, a full port and no port keep the stock request", async () => {
    expect(await requestedSummary("test-host:other", withheldPort)).not.toBe("none");
    expect(
      await requestedSummary(HOST_SOURCE, { ...hostPort, reasoningDisclosure: "full" }),
    ).not.toBe("none");
    expect(await requestedSummary(HOST_SOURCE, undefined)).not.toBe("none");
  });
});
