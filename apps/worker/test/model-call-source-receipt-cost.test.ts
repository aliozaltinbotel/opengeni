// F-08 (Cendra audit 2026-10-08): the exact-call source receipt producer re-walked every
// earlier receipt once per route that reached it. Each receipt's stored closure names the
// previous receipt both directly and through the assistant row that receipt produced, so the
// walk doubled with every model request of a session (staging: 0.9 s .. 153.8 s before the
// tenth request). This drives the real SDK, history sink and turn claims over several turns
// and holds the producer's database work per request to a constant increment.
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Runner, type ModelRequest } from "@openai/agents";
import type { AttemptToolDefinition } from "@opengeni/codemode";
import { acquireSharedTestDatabase, ScriptedModel, functionCall, testSettings, type SharedTestDatabase } from "@opengeni/testing";
import {
  applySessionTurnSettlement, bootstrapWorkspace, claimSessionWorkForAttempt, createDb, createSession, ensureSessionSkillCatalog,
  getActiveSessionHistoryItemsPaged, getOrCreateCompanyProfileSnapshot, getOrCreatePreferenceRegistrySnapshot,
  getOrCreateWorkspaceInstructionPolicySnapshot, initializeSessionStartAtomically, persistModelCallSourceReceipt, registerDbBinding,
  submitHumanPromptInTransaction, withSessionRlsActorContext, withWorkspaceSubjectSessionActivityRls, type ModelCallSourceIdentity,
} from "@opengeni/db";
import * as schema from "../../../packages/db/src/schema";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../../../packages/db/src/lossless-json";
import { createTurnHistorySink } from "../src/activities/agent-turn/history-sink";
import { ModelRequestCaptureModel, withModelRequestCapture, bindModelSourceInput, modelSourceBindings, type ModelRequestCapture } from "../../../packages/runtime/src/model-request-capture";

let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
let counted: { db: Parameters<typeof persistModelCallSourceReceipt>[0]; close: () => Promise<void> };
const statements = { counting: false, all: 0, receipts: 0, history: 0 };

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("model-call-source-receipt-cost");
  if (!acquired) throw Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { max: 4 });
  // The same connection posture as createDb, plus a statement observer, so the producer's
  // database work is measured on the real restricted role under FORCE RLS.
  const client = postgres(shared.appUrl, {
    max: 2, prepare: false, idle_timeout: 30,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    debug: (_connection, query) => {
      if (!statements.counting) return;
      statements.all++;
      if (/from "model_call_source_receipts"/i.test(query)) statements.receipts++;
      if (/from "session_history_items"/i.test(query)) statements.history++;
    },
  });
  const db = drizzle(client, { schema }) as unknown as Parameters<typeof persistModelCallSourceReceipt>[0];
  registerDbBinding(db, {});
  counted = { db, close: async () => { await client.end(); } };
}, 180_000);
afterAll(async () => { await counted?.close(); await app?.close(); await shared?.release(); }, 60_000);

type Measurement = { turn: number; request: number; inputs: number; closure: number; receiptOwners: number; receiptScopeRows: number; rawToolRows: number; transientProducers: number; statements: number; receiptReads: number; historyReads: number; ms: number };

async function snapshots(identity: ModelCallSourceIdentity, subjectId: string) {
  return withSessionRlsActorContext({ subjectId: "worker:source-receipt-cost", initiatingHumanSubjectId: subjectId }, async () => {
    const profile = await getOrCreateCompanyProfileSnapshot(app.db, identity);
    const policy = await getOrCreateWorkspaceInstructionPolicySnapshot(app.db, identity);
    const preferences = await getOrCreatePreferenceRegistrySnapshot(app.db, identity);
    return { instructionPolicySnapshotId: policy.id, preferenceSnapshotId: preferences.id, companyProfileSnapshotId: profile.id };
  });
}

/** One attempt tool with a host-recorded source, as Cendra's carrier tools are. */
function lookupTool(): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "synthetic_lookup" },
    modelName: "synthetic_lookup",
    codemodePath: ["opengeni", "synthetic_lookup"],
    title: "Synthetic lookup",
    description: "Return one synthetic fact.",
    inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false },
    annotations: { title: "Synthetic lookup", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    source: "opengeni",
    approval: "none",
    execute: async args => ({ content: [{ type: "text", text: `Synthetic fact ${String(args.n)}` }] }),
  };
}

/** Drive `turns` real turns of `callsPerTurn` tool calls plus a final answer each. */
async function driveSession(turns: number, callsPerTurn: number): Promise<Measurement[]> {
  const { buildOpenGeniAgent, prepareAgentTools } = await import("@opengeni/runtime");
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(app.db, { accountExternalSource: "source-receipt-cost", accountExternalId: suffix, accountName: "Test", workspaceExternalSource: "source-receipt-cost", workspaceExternalId: suffix, workspaceName: "Test", subjectId: suffix });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  if (!workspaceId) throw Error("workspace");
  const subjectId = suffix;
  const session = await createSession(app.db, { accountId, workspaceId, initialMessage: "Synthetic request", createdBy: { kind: "subject", subjectId }, resources: [], metadata: {}, model: "scripted", reasoningEffort: "low", latencyMode: "standard", sandboxBackend: "none" });
  await initializeSessionStartAtomically(app.db, { accountId, workspaceId, sessionId: session.id, reasoningEffortFallback: "low", createdEventPayload: {} });
  const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
  const skill = { owner: "cendra.skill.reviewed_release", id: crypto.randomUUID(), version: "1", sha256: createHash("sha256").update("Synthetic reviewed Skill").digest("hex") };
  const measurements: Measurement[] = [];
  for (let turn = 0; turn < turns; turn++) {
    if (turn > 0) {
      await withWorkspaceSubjectSessionActivityRls(app.db, workspaceId, subjectId, db => submitHumanPromptInTransaction(db, { accountId, workspaceId, sessionId: session.id, subjectId, actor: { type: "human", subjectId }, operationKey: crypto.randomUUID(), delivery: "send", text: `Synthetic question ${turn}`, modelContext: null, resources: [], reasoningEffort: "low", reasoningEffortFallback: "low", source: "user" }));
    }
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(app.db, workspaceId, { sessionId: session.id, workflowId: `session-${session.id}`, workflowRunId: crypto.randomUUID(), dispatchId: crypto.randomUUID(), attemptId, trigger: { kind: "next" } });
    if (claim.action !== "claimed") throw Error(`claim ${turn}`);
    const identity: ModelCallSourceIdentity = { accountId, workspaceId, sessionId: session.id, turnId: claim.turn.id, attemptId, executionGeneration: claim.turn.executionGeneration, sourceKey: crypto.randomUUID(), requestIndex: 1 };
    const write = { accountId, workspaceId, sessionId: session.id, turnId: claim.turn.id, expectedAttemptId: attemptId, expectedExecutionGeneration: claim.turn.executionGeneration };
    // A host-reviewed Skill catalog is frozen into model history before each turn, as Cendra's carrier does.
    await ensureSessionSkillCatalog(app.db, { ...write, catalog: '## Skills\n- {"id":"synthetic","name":"Synthetic","description":"Reviewed instructions"}', retainedSources: [skill] });
    const instructionSelections = await snapshots(identity, subjectId);
    const rows = await getActiveSessionHistoryItemsPaged(app.db, workspaceId, session.id);
    for (const row of rows) bindModelSourceInput(row.item, { kind: "HISTORY_ROW", sourceRef: { owner: "session_history_items", id: row.id, sha256: row.sourceSha256! }, parents: [], retainedSources: [] });
    const input = rows.map(row => row.item) as ModelRequest["input"];
    const prepared = await prepareAgentTools(settings, [], { ...identity, attemptToolDefinitions: [lookupTool()] });
    let requestIndex = 0, calls = 0;
    const capture: ModelRequestCapture = () => {};
    capture.beforeCall = async sent => {
      requestIndex++;
      statements.all = 0; statements.receipts = 0; statements.history = 0; statements.counting = true;
      const started = performance.now();
      let receipt: Awaited<ReturnType<typeof persistModelCallSourceReceipt>>;
      try {
        receipt = await persistModelCallSourceReceipt(counted.db, { ...identity, sourceKey: crypto.randomUUID(), requestIndex }, { instructions: sent.systemInstructions, tools: sent.tools, input: sent.input, sourceBindings: modelSourceBindings(sent.input), instructionSelections });
      } finally { statements.counting = false; }
      const ms = performance.now() - started;
      expect(receipt.incompleteReasons).toEqual([]);
      expect(receipt.complete).toBe(true);
      measurements.push({ turn, request: measurements.length + 1, inputs: receipt.inputs.length, closure: receipt.closure.length, receiptOwners: new Set(receipt.closure.filter(node => node.sourceRef.owner === "model_call_source_receipts").map(node => node.sourceRef.id)).size, receiptScopeRows: receipt.closure.filter(node => node.sourceRef.owner === "session_history_items" && node.parents.some(parent => parent.owner === "model_call_source_receipts")).length, rawToolRows: receipt.closure.filter(node => node.sourceRef.owner === "session_history_items" && node.parents.some(parent => parent.owner === "native.tool.result")).length, transientProducers: (modelSourceBindings(sent.input) ?? []).filter(binding => binding.nativeProducerSourceKey !== undefined).length, statements: statements.all, receiptReads: statements.receipts, historyReads: statements.history, ms: Math.round(ms * 10) / 10 });
      return receipt.sourceKey;
    };
    const step = () => ++calls <= callsPerTurn ? { output: [functionCall("synthetic_lookup", { n: calls }, `synthetic-call-${turn}-${calls}`)] } : { outputText: `Synthetic answer ${turn}` };
    const model = new ModelRequestCaptureModel({ async getResponse(sent) { return new ScriptedModel([step()]).getResponse(sent); }, async *getStreamedResponse(sent) { yield* new ScriptedModel([step()]).getStreamedResponse(sent); } });
    try {
      let stream: Awaited<ReturnType<Runner["run"]>> | undefined;
      const sink = createTurnHistorySink({ db: app.db, accountId, workspaceId, sessionId: session.id, attemptId, getTurnId: () => identity.turnId, getExecutionGeneration: () => identity.executionGeneration, getStream: () => stream, getModelRunSettings: () => settings,
        media: { retainNativeGeneratedImagesFromHistory: async () => {}, retainedScreenshotReceiptsByCallId: new Map(), generatedImageReceiptsByProviderItemId: new Map() },
      } as unknown as Parameters<typeof createTurnHistorySink>[0]);
      sink.seedHistory(input, rows.length); sink.nextHistoryPosition = Math.max(...rows.map(row => row.position)) + 1;
      capture.callCompleted = (_key, _id, _response, restore) => sink.recordModelSourceRestorer(restore);
      capture.onModelToolSource = async source => { sink.recordModelToolSource(source); };
      const agent = buildOpenGeniAgent(settings, [], { model, skillCatalog: [], mcpServers: prepared.mcpServers });
      await withModelRequestCapture(capture, async () => {
        const running = await new Runner({ tracingDisabled: true }).run(agent, input, { stream: true, historyOwnership: "external", maxTurns: callsPerTurn + 2 }); stream = running;
        for await (const event of running) {
          if ((event.type === "raw_model_stream_event" && event.data.type === "response_done") || (event.type === "run_item_stream_event" && event.item.type === "tool_call_output_item")) await sink.reconcileConversationTruth({ requireDurable: true });
        }
        await running.completed; await sink.reconcileConversationTruth({ requireDurable: true });
      });
    } finally { await prepared.close(); }
    expect(calls).toBe(callsPerTurn + 1);
    // The chain this test exists for: every model output row names the receipt that produced it.
    const produced = await shared.admin`select source_basis from session_history_items where session_id=${session.id} and turn_id=${identity.turnId} and (item->>'role'='assistant' or item->>'type'='function_call')`;
    expect(produced.length).toBeGreaterThan(0);
    for (const row of produced) {
      expect(row.source_basis.kind).toBe("HISTORY_ROW");
      expect(row.source_basis.parents.map((parent: { owner: string }) => parent.owner)).toEqual(["model_call_source_receipts"]);
    }
    expect((await applySessionTurnSettlement(app.db, workspaceId, { sessionId: session.id, turnId: identity.turnId, triggerEventId: claim.turn.triggerEventId, attemptId, turnStatus: "completed", sessionStatus: "idle", activeTurnId: null, events: [{ type: "turn.completed", payload: {} }] })).action).toBe("settled");
  }
  return measurements;
}

const TURNS = Number(process.env.OPENGENI_RECEIPT_COST_TURNS ?? 6);
const CALLS_PER_TURN = Number(process.env.OPENGENI_RECEIPT_COST_CALLS_PER_TURN ?? 2);

test(`receipt production work per model request grows by a constant across ${TURNS} turns`, async () => {
  const measurements = await driveSession(TURNS, CALLS_PER_TURN);
  if (process.env.OPENGENI_RECEIPT_COST_OUT) await writeFile(process.env.OPENGENI_RECEIPT_COST_OUT, `${JSON.stringify(measurements, null, 1)}\n`);
  console.log(measurements.map(m => `turn ${m.turn} request ${m.request}: inputs ${m.inputs} closure ${m.closure} statements ${m.statements} (receipts ${m.receiptReads}, history ${m.historyReads}) ${m.ms} ms`).join("\n"));
  expect(measurements).toHaveLength(TURNS * (CALLS_PER_TURN + 1));
  // Each durable owner and its scope/raw-tool edge can be read in the two
  // purpose contexts (AGENT and COMPACTION). SDK bindings read their exact
  // producer separately. Derive this linear budget from the produced graph,
  // including separate outputs of one receipt, rather than session length.
  for (const current of measurements) {
    expect(current.receiptReads).toBeLessThanOrEqual(2 * (current.receiptOwners + current.receiptScopeRows + current.rawToolRows) + current.transientProducers);
  }
}, 600_000);
