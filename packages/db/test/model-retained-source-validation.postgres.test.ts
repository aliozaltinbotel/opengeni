import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { buildSummaryItem } from "@opengeni/runtime";
import { readSkillCatalogContext, type ModelSourceRef } from "@opengeni/contracts";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { rawRows, withRlsContext } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  activateWorkspaceInstructionPolicyRevision,
  applyContextCompaction,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createWorkspaceInstructionPolicyDraft,
  ensureSessionSkillCatalog,
  appendSessionHistoryItems,
  deleteSessionTreeIfQuiescent,
  ensureManagedAccessForUser,
  forkSessionContent,
  getActiveSessionHistoryItemsPaged,
  getOrCreateCompanyProfileSnapshot,
  getOrCreatePreferenceRegistrySnapshot,
  getOrCreateWorkspaceInstructionPolicySnapshot,
  initializeSessionStartAtomically,
  modelSourceContentDigest,
  mutateSessionControlInTransaction,
  persistModelCallSourceReceipt,
  validateRetainedModelSources,
  withSessionRlsActorContext,
  withWorkspaceSessionActivityRls,
  type ModelCallSourceIdentity,
} from "../src";

const adminUrl = process.env.OPENGENI_RETAINED_SOURCE_TEST_DATABASE_URL;
let shared: SharedTestDatabase | null = null;
let admin: ReturnType<typeof postgres>;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  // Dedicated qualification explicitly requires PG17. Ordinary fork unit shards scrub ambient
  // OPENGENI_* URLs, so use their existing isolated, migrated fixture when no dedicated URL is supplied.
  if (!adminUrl) {
    shared = await acquireSharedTestDatabase("retained-model-source-validation");
    if (!shared) throw Error("real PostgreSQL is required for retained source validation");
    admin = shared.admin;
    app = createDb(shared.appUrl, { max: 4 });
    return;
  }
  admin = postgres(adminUrl, { max: 4, onnotice: () => undefined });
  const [version] = await admin`select current_setting('server_version_num')::integer as version`;
  expect(version!.version).toBeGreaterThanOrEqual(170000);
  expect(version!.version).toBeLessThan(180000);
  await migrate(adminUrl);
  await provisionRoles(adminUrl, { appPassword: "synthetic-test-only", rlsStrategy: "force" });
  const url = new URL(adminUrl);
  url.username = "opengeni_app";
  url.password = "synthetic-test-only";
  app = createDb(url.toString(), { max: 4 });
}, 180_000);
afterAll(async () => {
  await app?.close();
  if (shared) await shared.release();
  else await admin?.end({ timeout: 5 });
}, 60_000);

async function fixture(managed = false) {
  const unique = crypto.randomUUID();
  const suffix = managed ? `user:retained-${unique}` : unique;
  const access = managed
    ? await ensureManagedAccessForUser(app.db, {
        userId: `retained-${unique}`,
        email: `retained-${unique}@example.test`,
        name: "Synthetic owner",
      })
    : await bootstrapWorkspace(app.db, {
        accountExternalSource: "retained-test",
        accountExternalId: suffix,
        accountName: "Synthetic",
        workspaceExternalSource: "retained-test",
        workspaceExternalId: suffix,
        workspaceName: "Synthetic",
        subjectId: suffix,
      });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(app.db, {
    accountId,
    workspaceId,
    initialMessage: "Synthetic task",
    createdBy: { kind: "subject", subjectId: suffix },
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(app.db, {
    accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(app.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: suffix,
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw Error("fixture claim refused");
  const identity: ModelCallSourceIdentity = {
    accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
    sourceKey: crypto.randomUUID(),
    requestIndex: 1,
  };
  const instructionSelections = await withSessionRlsActorContext(
    { subjectId: "worker:retained-test", initiatingHumanSubjectId: suffix },
    async () => {
      const profile = await getOrCreateCompanyProfileSnapshot(app.db, identity);
      const policy = await getOrCreateWorkspaceInstructionPolicySnapshot(app.db, identity);
      const preference = await getOrCreatePreferenceRegistrySnapshot(app.db, identity);
      return {
        instructionPolicySnapshotId: policy.id,
        companyProfileSnapshotId: profile.id,
        preferenceSnapshotId: preference.id,
      };
    },
  );
  const rows = await getActiveSessionHistoryItemsPaged(app.db, workspaceId, session.id);
  const receipt = await persistModelCallSourceReceipt(app.db, identity, {
    instructions: "Synthetic instruction",
    input: rows.map((row) => row.item),
    instructionSelections,
  });
  return {
    identity,
    instructionSelections,
    rows,
    receipt,
    suffix,
    triggerEventId: claim.turn.triggerEventId,
  };
}

test("exact producer selections and snapshots are available, with no authority claim", async () => {
  const { identity, receipt } = await fixture();
  const result = await validateRetainedModelSources(app.db, { identity, receipt });
  expect(result.complete).toBe(true);
  expect(result.sources.length).toBeGreaterThan(0);
  expect(result.sources.every((source) => source.status === "AVAILABLE")).toBe(true);
  await withSessionRlsActorContext({ subjectId: "worker:outer-scope" }, () =>
    withRlsContext(app.db, identity, async (tx) => {
      const before = await rawRows<{ subject: string }>(tx, sql`select current_setting('opengeni.subject_id', true) as subject`);
      expect((await validateRetainedModelSources(tx, { identity, receipt })).complete).toBe(true);
      const after = await rawRows<{ subject: string }>(tx, sql`select current_setting('opengeni.subject_id', true) as subject`);
      expect(after).toEqual(before);
    }),
  );
});

async function settle(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await applySessionTurnSettlement(app.db, f.identity.workspaceId, {
    sessionId: f.identity.sessionId,
    turnId: f.identity.turnId,
    triggerEventId: f.triggerEventId,
    attemptId: f.identity.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { output: "Synthetic response" } }],
  });
  expect(result.action).toBe("settled");
}

test.each([false,true])("lawful historical selections survive COMPACTION, SUMMARY and installed COPIED history; host Skills %s", async (includeSkills) => {
  const f = await fixture(true);
  const skillRef = {owner:"cendra.skill.reviewed_release",id:crypto.randomUUID(),sha256:modelSourceContentDigest("Synthetic reviewed Skill body"),version:"1"};
  if(includeSkills) {
    await ensureSessionSkillCatalog(app.db,{...f.identity,expectedAttemptId:f.identity.attemptId,expectedExecutionGeneration:f.identity.executionGeneration,
      catalog:'## Skills\n- {"id":"synthetic-skill","name":"Synthetic","description":"Scoped instructions"}',retainedSources:[skillRef]});
    f.rows=await getActiveSessionHistoryItemsPaged(app.db,f.identity.workspaceId,f.identity.sessionId);
  }
  const compaction = await persistModelCallSourceReceipt(
    app.db,
    { ...f.identity, sourceKey: crypto.randomUUID() },
    {
      purpose: "COMPACTION",
      instructions: "Historical compaction instruction",
      input: f.rows.map((row) => row.item),
      instructionSelections: f.instructionSelections,
    },
  );
  const write = {
    ...f.identity,
    expectedAttemptId: f.identity.attemptId,
    expectedExecutionGeneration: f.identity.executionGeneration,
  };
  await applyContextCompaction(app.db, {
    ...write,
    replacementItems: includeSkills ? f.rows.filter(row=>readSkillCatalogContext(row.item)!==null).map(row=>row.item) : [],
    replacementSourceIds: includeSkills ? f.rows.filter(row=>readSkillCatalogContext(row.item)!==null).map(row=>row.id) : [],
    summaryItem: buildSummaryItem("Synthetic historical summary"),
    summarySourceIds: f.rows.map((row) => row.id),
    summaryModelSourceKey: compaction.sourceKey,
  });
  const rows = await getActiveSessionHistoryItemsPaged(
    app.db,
    f.identity.workspaceId,
    f.identity.sessionId,
  );
  const summarizedIdentity = { ...f.identity, sourceKey: crypto.randomUUID(), requestIndex: 2 };
  const summarized = await persistModelCallSourceReceipt(app.db, summarizedIdentity, {
    input: rows.map((row) => row.item),
  });
  expect(summarized.complete).toBe(true);
  expect(
    (
      await validateRetainedModelSources(app.db, {
        identity: summarizedIdentity,
        receipt: summarized,
      })
    ).complete,
  ).toBe(!includeSkills);
  const policy = await createWorkspaceInstructionPolicyDraft(app.db, {
    ...f.identity,
    kind: "charter",
    scope: "global",
    roleKey: null,
    content: "New accepted-turn policy head",
    provenanceSource: "human",
    provenanceSourceId: null,
    supersedesRevisionId: null,
    createdBySubjectId: f.suffix,
  });
  await activateWorkspaceInstructionPolicyRevision(app.db, {
    ...f.identity,
    revisionId: policy.id,
    expectedCurrentRevisionId: null,
    actorSubjectId: f.suffix,
    reason: "Synthetic head change",
  });
  await settle(f);
  const source = await readFile(new URL("../src/session-tenancy.ts", import.meta.url), "utf8");
  const version = Number(source.match(/const SESSION_TENANCY_ACTIVATION_VERSION = (\d+)/)?.[1]);
  if (!Number.isInteger(version)) throw Error("activation producer drift");
  await admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${f.identity.accountId},${version},${createHash("sha256").update("historical-copy").digest("hex")},${createHash("sha256").update("historical-copy-parity").digest("hex")},'database-test') on conflict(account_id) do nothing`;
  const fork = await forkSessionContent(app.db, {
    sourceWorkspaceId: f.identity.workspaceId,
    sourceSessionId: f.identity.sessionId,
    actorSubjectId: f.suffix,
    destinationWorkspaceId: f.identity.workspaceId,
    destinationVisibility: "workspace_shared",
    workspaceSharedAcknowledged: true,
    operationKey: crypto.randomUUID(),
  });
  await initializeSessionStartAtomically(app.db, {
    ...f.identity,
    sessionId: fork.sessionId,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(app.db, f.identity.workspaceId, {
    sessionId: fork.sessionId,
    workflowId: `session-${fork.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw Error("copy claim refused");
  const identity = {
    ...f.identity,
    sessionId: fork.sessionId,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
    sourceKey: crypto.randomUUID(),
  };
  const copiedRows = await getActiveSessionHistoryItemsPaged(
    app.db,
    identity.workspaceId,
    identity.sessionId,
  );
  const copied = await persistModelCallSourceReceipt(app.db, identity, {
    input: copiedRows.map((row) => row.item),
  });
  expect(copied.complete).toBe(true);
  const result = await validateRetainedModelSources(app.db, { identity, receipt: copied });
  expect(result.complete).toBe(!includeSkills);
  if(includeSkills)expect(result.sources).toContainEqual({sourceRef:skillRef,status:"HOST_AUTHORITY_REQUIRED",reason:"HOST_AUTHORITY_REQUIRED"});
  for (const ref of compaction.inputs.flatMap((item) => item.retainedSources))
    expect(result.sources).toContainEqual({ sourceRef: ref, status: ref.owner === "cendra.skill.reviewed_release" ? "HOST_AUTHORITY_REQUIRED" : "AVAILABLE", reason: ref.owner === "cendra.skill.reviewed_release" ? "HOST_AUTHORITY_REQUIRED" : null });
  expect(identity.attemptId).not.toBe(compaction.attemptId);
  // Historical identity is not today's head: this new turn has different native policy entries.
  const currentPolicy = await getOrCreateWorkspaceInstructionPolicySnapshot(app.db, identity);
  const historicalPolicy = compaction.inputs
    .flatMap((item) => item.retainedSources)
    .find((ref) => ref.owner === "workspace_instruction_policy_snapshots")!;
  expect(currentPolicy.entryHash).not.toBe(historicalPolicy.sha256);
  const currentSelections = await withSessionRlsActorContext(
    { subjectId: "worker:retained-test", initiatingHumanSubjectId: f.suffix },
    async () => ({
      instructionPolicySnapshotId: currentPolicy.id,
      companyProfileSnapshotId: (await getOrCreateCompanyProfileSnapshot(app.db, identity)).id,
      preferenceSnapshotId: (await getOrCreatePreferenceRegistrySnapshot(app.db, identity)).id,
    }),
  );
  const currentIdentity = { ...identity, sourceKey: crypto.randomUUID(), requestIndex: 2 };
  const currentReceipt = await persistModelCallSourceReceipt(app.db, currentIdentity, {
    instructions: "New instruction head with historical summary",
    input: copiedRows.map((row) => row.item),
    instructionSelections: currentSelections,
  });
  expect(
    (
      await validateRetainedModelSources(app.db, {
        identity: currentIdentity,
        receipt: currentReceipt,
      })
    ).complete,
  ).toBe(!includeSkills);
  // Missing-origin fault injection on this disposable database. The current copied receipt remains
  // byte-exact; no guard/constraint is disabled and no receipt is rewritten or rehashed.
  await admin`delete from model_call_source_receipts where id=${compaction.id}`;
  const [origin] =
    await admin`select count(*)::integer as count from model_call_source_receipts where id=${compaction.id}`;
  expect(origin!.count).toBe(0);
  const erased = await validateRetainedModelSources(app.db, { identity, receipt: copied });
  expect(erased.complete).toBe(false);
  expect(erased.incompleteReasons).toContain("ORIGIN_UNAVAILABLE");
});

test("exact receipt mismatch, foreign scope and changed current attempt refuse", async () => {
  const f = await fixture();
  const foreign = await fixture();
  for (const identity of [
    { ...f.identity, executionGeneration: f.identity.executionGeneration + 1 },
    { ...f.identity, accountId: foreign.identity.accountId },
    { ...f.identity, workspaceId: foreign.identity.workspaceId },
  ]) {
    expect(
      (await validateRetainedModelSources(app.db, { identity, receipt: f.receipt })).complete,
    ).toBe(false);
  }
  const mismatch = await validateRetainedModelSources(app.db, {
    identity: f.identity,
    receipt: { ...f.receipt, digest: "0".repeat(64) },
  });
  expect(mismatch.incompleteReasons).toContain("RECEIPT_INEXACT");
  const body = structuredClone(f.receipt);
  body.inputs[0]!.retainedSources[0]!.sha256 = "0".repeat(64);
  expect(
    (await validateRetainedModelSources(app.db, { identity: f.identity, receipt: body }))
      .incompleteReasons,
  ).toContain("RECEIPT_INEXACT");
});

test("persisted missing and foreign snapshot ids are refused despite complete receipt graph", async () => {
  const f = await fixture();
  const foreign = await fixture();
  for (const instructionPolicySnapshotId of [
    crypto.randomUUID(),
    foreign.instructionSelections.instructionPolicySnapshotId,
  ]) {
    const identity = { ...f.identity, sourceKey: crypto.randomUUID() };
    const receipt = await persistModelCallSourceReceipt(app.db, identity, {
      instructions: "Synthetic instruction",
      input: f.rows.map((row) => row.item),
      instructionSelections: { ...f.instructionSelections, instructionPolicySnapshotId },
    });
    expect(receipt.complete).toBe(true);
    const result = await validateRetainedModelSources(app.db, { identity, receipt });
    expect(result.complete).toBe(false);
    expect(
      result.sources.find((source) => source.sourceRef.id === instructionPolicySnapshotId)?.status,
    ).toBe("REFUSED");
  }
  const preferenceRef = f.receipt.inputs
    .flatMap((item) => item.retainedSources)
    .find((ref) => ref.owner === "preference_registry_snapshots");
  expect(preferenceRef).toBeDefined();
  const identity = { ...f.identity, sourceKey: crypto.randomUUID() };
  const missing = await persistModelCallSourceReceipt(app.db, identity, {
    instructions: "Synthetic instruction",
    input: f.rows.map((row) => row.item),
    instructionSelections: { ...f.instructionSelections, preferenceSnapshotId: null },
  });
  expect(missing.complete).toBe(true);
  expect(
    (await validateRetainedModelSources(app.db, { identity, receipt: missing })).incompleteReasons,
  ).toContain("SELECTION_SOURCES_INCOMPLETE");
});

async function retainedReceipt(f: Awaited<ReturnType<typeof fixture>>, refs: ModelSourceRef[]) {
  const identity = { ...f.identity, sourceKey: crypto.randomUUID() };
  const value = { type: "message", role: "user", content: "Synthetic transformed artifact" };
  const hash = modelSourceContentDigest(value);
  const receipt = await persistModelCallSourceReceipt(app.db, identity, {
    input: [value],
    sourceBindings: [
      {
        ordinal: 0,
        sourceRef: { owner: "native.runtime.artifact", id: `test:${hash}`, sha256: hash },
        kind: "INSTRUCTION",
        parents: [],
        retainedSources: refs,
      },
    ],
  });
  expect(receipt.complete).toBe(true);
  return { identity, receipt };
}

test("unknown retained owners and exact Cendra host-owned refs have explicit unresolved states", async () => {
  const f = await fixture();
  const hash = modelSourceContentDigest("Synthetic source");
  const refs = ["native.unknown.source", "cendra.knowledge.retrieval_use", "cendra.skill.reviewed_release"].map((owner) => ({
    owner,
    id: crypto.randomUUID(),
    sha256: hash,
  }));
  const exact = await retainedReceipt(f, refs);
  const result = await validateRetainedModelSources(app.db, exact);
  expect(result.complete).toBe(false);
  expect(result.sources.map((source) => source.status)).toEqual([
    "UNKNOWN",
    "HOST_AUTHORITY_REQUIRED",
    "HOST_AUTHORITY_REQUIRED",
  ]);
  const inexact = await retainedReceipt(f, [
    {
      ...f.receipt.inputs[0]!.retainedSources.find(
        (ref) => ref.owner === "workspace_instruction_policy_snapshots",
      )!,
      sha256: hash,
    },
  ]);
  expect((await validateRetainedModelSources(app.db, inexact)).sources[0]?.status).toBe("REFUSED");
});

test("current pause, revocation and lifecycle erasure refuse, without changing immutable receipts", async () => {
  const f = await fixture();
  await withWorkspaceSessionActivityRls(app.db, f.identity.workspaceId, (tx) =>
    mutateSessionControlInTransaction(tx, {
      ...f.identity,
      actor: { type: "human", subjectId: f.suffix },
      action: "pause",
      operationKey: crypto.randomUUID(),
    }),
  );
  expect(
    (await validateRetainedModelSources(app.db, { identity: f.identity, receipt: f.receipt }))
      .incompleteReasons,
  ).toContain("ATTEMPT_NOT_CURRENT");
  const revoked = await fixture();
  await admin`delete from workspace_memberships where workspace_id=${revoked.identity.workspaceId} and subject_id=${revoked.suffix}`;
  expect(
    (
      await validateRetainedModelSources(app.db, {
        identity: revoked.identity,
        receipt: revoked.receipt,
      })
    ).complete,
  ).toBe(false);
  const erased = await fixture();
  await settle(erased);
  const deletion = await deleteSessionTreeIfQuiescent(app.db, {
    workspaceId: erased.identity.workspaceId,
    sessionId: erased.identity.sessionId,
    subjectId: erased.suffix,
  });
  expect(deletion.status).toBe("deleted");
  const [counts] =
    await admin`select (select count(*) from company_brain_context_selection_receipts where session_id=${erased.identity.sessionId})::integer as selections, (select count(*) from workspace_instruction_policy_snapshots where session_id=${erased.identity.sessionId})::integer as snapshots`;
  expect(counts).toEqual({ selections: 0, snapshots: 0 });
  expect(
    (
      await validateRetainedModelSources(app.db, {
        identity: erased.identity,
        receipt: erased.receipt,
      })
    ).incompleteReasons,
  ).toContain("ATTEMPT_NOT_CURRENT");
});


test("legacy native Skill catalog and tool result origins are refused without rewriting history", async () => {
 for(const kind of ["catalog","tool"] as const){
  const f=await fixture();
  const write={...f.identity,expectedAttemptId:f.identity.attemptId,expectedExecutionGeneration:f.identity.executionGeneration};
  const position=Math.max(...f.rows.map(row=>row.position));
  if(kind==="catalog")await ensureSessionSkillCatalog(app.db,{...write,catalog:'## Skills\n- {"id":"legacy-skill","name":"Legacy","description":"Withdrawable guidance"}'});
  else {
   const callId=crypto.randomUUID(),raw={content:[{type:"text",text:"Synthetic reviewed Skill body"}]};
   const rawSourceRef={owner:"native.tool.result",id:callId,sha256:modelSourceContentDigest(raw)};
   await appendSessionHistoryItems(app.db,{...write,items:[
    {position:position+1,item:{type:"function_call",callId,name:"skill_read",arguments:'{"skill":"legacy-skill"}'}},
    {position:position+2,item:{type:"function_call_result",callId,output:JSON.stringify(raw)},sourceBasis:{kind:"TOOL_RESULT",parents:[rawSourceRef],retainedSources:[],rawToolSource:{sourceCallId:callId,nativeModelSourceKey:f.identity.sourceKey,rawSourceRef,retainedSources:[]}}},
   ]});
  }
  const before=await getActiveSessionHistoryItemsPaged(app.db,f.identity.workspaceId,f.identity.sessionId);
  const receipt=await persistModelCallSourceReceipt(app.db,{...f.identity,sourceKey:crypto.randomUUID(),requestIndex:2},{input:before.map(row=>row.item)});
  expect(receipt.complete).toBe(false);expect(receipt.incompleteReasons).toContain("UNRESOLVED_PARENT");
  expect(await getActiveSessionHistoryItemsPaged(app.db,f.identity.workspaceId,f.identity.sessionId)).toEqual(before);
 }
});
