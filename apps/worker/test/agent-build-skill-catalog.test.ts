import { expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  buildOpenGeniAgent,
  formatSkillCatalog,
  prepareAgentTools,
  type BuildAgentOptions,
  type SkillCatalogDescriptor,
} from "@opengeni/runtime";
import { ScriptedModel, testSettings } from "@opengeni/testing";
import { buildTurnAgent, type BuildTurnAgentDeps } from "../src/activities/agent-turn/agent-build";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";

const ambient = [{ id: "ambient", name: "Ambient", description: "Another scope." }];
const scoped = [{ id: "scoped", name: "Scoped", description: "The accepted scope." }];

// Drive the production worker builder and real runtime preparation/construction.
// Persistence is spied here; the DB catalog suite owns its attempt/replay fence.
async function build(input: { override?: readonly SkillCatalogDescriptor[]; frozen?: string }) {
  const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
  const prepared = await prepareAgentTools(settings, []);
  if (input.override !== undefined) prepared.skillCatalog = input.override;
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  context.eventing.preparedTools = prepared;
  let persisted: string | undefined;
  let built: BuildAgentOptions | undefined;
  const spies = [
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "getWorkspaceVideoGenerationPolicy").mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      fundingSource: "workspace_gateway",
      enabledModelIds: [],
      defaultModelId: null,
    }),
    spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, value) => {
      persisted = value.catalog;
      return input.frozen ?? value.catalog;
    }),
    spyOn(db, "getExternalLinkTurnAuthorization").mockResolvedValue(null),
  ];
  try {
    const deps: Partial<BuildTurnAgentDeps> = {
      ...context,
      input: {
        accountId: "account",
        workspaceId: "workspace",
        sessionId: "session",
        attemptId: "attempt",
        workflowId: "workflow",
        workflowRunId: "run",
        trigger: { kind: "next" },
      },
      db: {} as BuildTurnAgentDeps["db"],
      runtime: {
        buildAgent: (configuration, resources, options) => {
          built = options;
          return buildOpenGeniAgent(configuration, resources, {
            ...options,
            model: new ScriptedModel([]),
          });
        },
      } as BuildTurnAgentDeps["runtime"],
      observability: createObservability(settings, { component: "worker" }),
      objectStorage: null,
      media: {} as BuildTurnAgentDeps["media"],
      turn: {
        id: "turn",
        executionGeneration: 1,
        reasoningEffort: "low",
      } as BuildTurnAgentDeps["turn"],
      session: { id: "session" } as BuildTurnAgentDeps["session"],
      runSettings: settings,
      mcpServers: [],
      skillCatalog: ambient,
      turnExecutionPolicy: {
        providerId: "openai",
        latencyMode: "standard",
      } as BuildTurnAgentDeps["turnExecutionPolicy"],
      runtimeResources: [],
      sandboxEnvironment: {},
      sandboxArtifactRuntime: { available: false, environment: {} },
      fileResourceDownloads: [],
      attemptConnectorActionBindings: [],
      modelInputPolicy: { inputFileMediaTypes: [], supportsImageInput: true },
      preparationIndependentToolNames: [],
      groupBoxBackend: "none",
      postToolPreparationStartedAt: performance.now(),
      trigger: { type: "user.message", payload: {} } as BuildTurnAgentDeps["trigger"],
    };
    let error: unknown;
    try {
      await buildTurnAgent(deps as BuildTurnAgentDeps);
    } catch (caught) {
      error = caught;
    }
    return { persisted, built, error, ids: context.eventing.modelVisibleSkillIds };
  } finally {
    for (const spy of spies) spy.mockRestore();
    await prepared.close();
  }
}

test.each([{ override: scoped }, { override: [] }])(
  "host index replaces ambient Skills before durable history",
  async ({ override }) => {
    const result = await build({ override });
    expect(result.error).toBeUndefined();
    expect(result.persisted).toBe(formatSkillCatalog(override));
    expect(result.built?.skillCatalog).toEqual(override);
    expect(result.built?.skillCatalogInHistory).toBe(true);
    expect([...result.ids!]).toEqual(override.map((entry) => entry.id));
    expect(result.persisted).not.toContain('"id":"ambient"');
  },
);

test("an omitted host index preserves standalone catalog behavior", async () => {
  const result = await build({});
  expect(result.error).toBeUndefined();
  expect(result.persisted).toBe(formatSkillCatalog(ambient));
  expect(result.built?.skillCatalog).toEqual(ambient);
});

test("a host index cannot replay a different durable catalog into the model", async () => {
  const result = await build({ override: scoped, frozen: formatSkillCatalog(ambient) });
  expect(String(result.error)).toContain(
    "Prepared Skill catalog differs from the durable turn snapshot",
  );
  expect(result.built).toBeUndefined();
  expect(result.ids).toBeNull();
});

test("an identical durable host index can replay", async () => {
  const result = await build({ override: scoped, frozen: formatSkillCatalog(scoped) });
  expect(result.error).toBeUndefined();
  expect([...result.ids!]).toEqual(["scoped"]);
});

test("standalone retries keep the durable catalog's model-visible identities", async () => {
  const result = await build({ frozen: formatSkillCatalog(scoped) });
  expect(result.error).toBeUndefined();
  expect([...result.ids!]).toEqual(["scoped"]);
});
