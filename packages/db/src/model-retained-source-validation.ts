import { and, eq, sql } from "drizzle-orm";
import {
  canonicalModelSourceJson,
  ModelCallSourceReceipt,
  type ModelSourceRef,
} from "@opengeni/contracts";
import { rawRows, withRlsContext, type Database } from "./database";
import {
  validatedStoredModelCallSourceReceipt,
  type ModelCallSourceIdentity,
} from "./model-call-source-receipts";
import { subjectHasLiveWorkspaceAuthorityInScope } from "./workspace-authority";
import * as schema from "./schema";

export type RetainedModelSourceStatus =
  | "AVAILABLE"
  | "UNKNOWN"
  | "REFUSED"
  | "HOST_AUTHORITY_REQUIRED";
export type RetainedModelSourceValidation = Readonly<{
  complete: boolean;
  incompleteReasons: readonly string[];
  sources: readonly Readonly<{
    sourceRef: ModelSourceRef;
    status: RetainedModelSourceStatus;
    reason: string | null;
  }>[];
}>;
export type RetainedModelSourceValidationInput = Readonly<{
  identity: ModelCallSourceIdentity;
  receipt: ModelCallSourceReceipt;
}>;

const selectionOwner = "company_brain_context_selection_receipts";
const key = (ref: ModelSourceRef): string => canonicalModelSourceJson(ref);
const refused = (reason: string): RetainedModelSourceValidation => ({
  complete: false,
  incompleteReasons: [reason],
  sources: [],
});

function allRefs(receipt: ModelCallSourceReceipt): ModelSourceRef[] {
  return [...receipt.inputs, ...receipt.closure].flatMap((node) => [
    ...(node.sourceRef ? [node.sourceRef] : []),
    ...node.parents,
    ...node.retainedSources,
  ]);
}

type Selection = {
  receipt_id: string;
  session_id: string;
  turn_id: string;
  selection_hash: string;
  turn_context_snapshot_id: string;
  turn_context_snapshot_hash: string;
  instruction_policy_entry_hash: string;
  company_profile_snapshot_hash: string;
  preference_descriptor_hash: string | null;
  company_profile_included: boolean;
};
type SnapshotIdentity = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  hash: string;
  revisionsAvailable: boolean;
};

/** Native availability/identity facts only. The host still authenticates the person and owns current business authority.
 * The public facade supplies the existing exact-attempt fence; this reader never creates snapshots or edits receipts.
 */
export async function validateRetainedModelSourcesWithFence(
  db: Database,
  input: RetainedModelSourceValidationInput,
  currentFence: (tx: Database, identity: ModelCallSourceIdentity) => Promise<boolean>,
): Promise<RetainedModelSourceValidation> {
  const parsed = ModelCallSourceReceipt.safeParse(input.receipt);
  if (!parsed.success) return refused("RECEIPT_INVALID");
  const receipt = parsed.data;
  if (
    receipt.accountId !== input.identity.accountId ||
    receipt.workspaceId !== input.identity.workspaceId ||
    receipt.sessionId !== input.identity.sessionId ||
    receipt.sourceKey !== input.identity.sourceKey
  )
    return refused("RECEIPT_INEXACT");
  return withRlsContext(db, input.identity, async (tx) => {
    if (!(await currentFence(tx, input.identity))) return refused("ATTEMPT_NOT_CURRENT");
    const [stored] = await tx
      .select()
      .from(schema.modelCallSourceReceipts)
      .where(
        and(
          eq(schema.modelCallSourceReceipts.accountId, input.identity.accountId),
          eq(schema.modelCallSourceReceipts.workspaceId, input.identity.workspaceId),
          eq(schema.modelCallSourceReceipts.sessionId, input.identity.sessionId),
          eq(schema.modelCallSourceReceipts.sourceKey, input.identity.sourceKey),
        ),
      )
      .limit(1);
    if (!stored) return refused("RECEIPT_UNAVAILABLE");
    let persisted: ModelCallSourceReceipt;
    try {
      persisted = validatedStoredModelCallSourceReceipt(stored);
    } catch {
      return refused("RECEIPT_INEXACT");
    }
    if (
      !storedTupleMatches(stored, persisted) ||
      canonicalModelSourceJson(persisted) !== canonicalModelSourceJson(receipt) ||
      receipt.turnId !== input.identity.turnId ||
      receipt.attemptId !== input.identity.attemptId ||
      receipt.executionGeneration !== input.identity.executionGeneration ||
      receipt.requestIndex !== input.identity.requestIndex
    ) {
      return refused("RECEIPT_INEXACT");
    }
    if (!receipt.complete || receipt.incompleteReasons.length) return refused("RECEIPT_INCOMPLETE");
    const [turn] = await tx
      .select({
        human: schema.sessionTurns.initiatingHumanSubjectId,
        kind: schema.sessionTurns.initiatorKind,
        subject: schema.sessionTurns.initiatorSubjectId,
      })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.accountId, receipt.accountId),
          eq(schema.sessionTurns.workspaceId, receipt.workspaceId),
          eq(schema.sessionTurns.id, receipt.turnId),
        ),
      )
      .limit(1);
    const human = turn?.human ?? (turn?.kind === "subject" ? turn.subject : null);
    if (!human) return refused("INITIATING_HUMAN_UNAVAILABLE");
    const [prior] = await rawRows<{ subject: string | null }>(
      tx,
      sql`select current_setting('opengeni.subject_id', true) as subject`,
    );
    try {
      const [applied] = await rawRows<{ subject: string }>(
        tx,
        sql`select set_config('opengeni.subject_id', ${human}, true) as subject`,
      );
      if (applied?.subject !== human) return refused("INITIATING_HUMAN_UNAVAILABLE");
      if (
        !(await subjectHasLiveWorkspaceAuthorityInScope(tx, {
          accountId: receipt.accountId,
          workspaceId: receipt.workspaceId,
          subjectId: human,
        }))
      ) {
        return refused("INITIATING_HUMAN_NOT_CURRENT");
      }

      const reasons = new Set<string>();
      const origins = new Map<string, ModelCallSourceReceipt>([[receipt.id, receipt]]);
      // Resolve exact persisted call parents, including copies from another session in this workspace.
      for (const origin of origins.values()) {
        for (const ref of allRefs(origin).filter(
          (candidate) => candidate.owner === "model_call_source_receipts",
        )) {
          if (origins.size >= 16384) {
            reasons.add("SOURCE_CAP_EXCEEDED");
            break;
          }
          if (origins.has(ref.id)) {
            if (origins.get(ref.id)!.digest !== ref.sha256 || ref.version !== undefined)
              reasons.add("ORIGIN_INEXACT");
            continue;
          }
          if (!/^[a-f0-9-]{36}$/.test(ref.id) || ref.version !== undefined) {
            reasons.add("ORIGIN_INEXACT");
            continue;
          }
          const [row] = await tx
            .select()
            .from(schema.modelCallSourceReceipts)
            .where(
              and(
                eq(schema.modelCallSourceReceipts.accountId, receipt.accountId),
                eq(schema.modelCallSourceReceipts.workspaceId, receipt.workspaceId),
                eq(schema.modelCallSourceReceipts.id, ref.id),
              ),
            )
            .limit(1);
          if (!row) {
            reasons.add("ORIGIN_UNAVAILABLE");
            continue;
          }
          try {
            const parent = validatedStoredModelCallSourceReceipt(row);
            if (
              !storedTupleMatches(row, parent) ||
              parent.digest !== ref.sha256 ||
              !parent.complete ||
              parent.incompleteReasons.length ||
              parent.purpose !== "COMPACTION"
            )
              reasons.add("ORIGIN_INEXACT");
            else origins.set(parent.id, parent);
          } catch {
            reasons.add("ORIGIN_INEXACT");
          }
        }
      }

      const references = new Map<string, ModelSourceRef>();
      for (const node of [...receipt.inputs, ...receipt.closure]) {
        for (const ref of node.retainedSources) references.set(key(ref), ref);
        for (const ref of [...(node.sourceRef ? [node.sourceRef] : []), ...node.parents]) {
          if (ref.owner === selectionOwner) references.set(key(ref), ref);
        }
      }
      const selections: {
        origin: ModelCallSourceReceipt;
        ref: ModelSourceRef;
        retained: ModelSourceRef[];
        selection: Selection;
      }[] = [];
      for (const origin of origins.values()) {
        const nodes = origin.closure.filter((node) => node.sourceRef.owner === selectionOwner);
        if (!nodes.length) continue;
        // 0266 already provides exact historical inspection, including human/session visibility and lifecycle.
        const rows = await rawRows<Selection>(
          tx,
          sql`select * from company_brain_inspect_context_receipts(
        ${receipt.accountId}::uuid, ${receipt.workspaceId}::uuid, ${human}::text,
        ${origin.attemptId}::uuid, null::timestamptz, null::uuid, 1::integer)`,
        );
        for (const node of nodes) {
          const selection = rows.find(
            (row) =>
              row.receipt_id === node.sourceRef.id &&
              row.selection_hash === node.sourceRef.sha256 &&
              row.session_id === origin.sessionId &&
              row.turn_id === origin.turnId &&
              node.sourceRef.version === undefined,
          );
          if (selection) {
            // Producer inclusion is derived from the accepted selection, never from an empty supplied closure.
            const requiredOwners = [
              "company_brain_turn_context_snapshots",
              "workspace_instruction_policy_snapshots",
              ...(selection.company_profile_included ? ["company_profile_snapshots"] : []),
              ...(selection.preference_descriptor_hash !== null
                ? ["preference_registry_snapshots"]
                : []),
            ];
            if (
              requiredOwners.some(
                (owner) => node.retainedSources.filter((ref) => ref.owner === owner).length !== 1,
              )
            ) {
              reasons.add("SELECTION_SOURCES_INCOMPLETE");
            }
            selections.push({
              origin,
              ref: node.sourceRef,
              retained: node.retainedSources,
              selection,
            });
          }
        }
      }
      const sources: RetainedModelSourceValidation["sources"][number][] = [];
      for (const ref of references.values()) {
        if (ref.owner === "cendra.knowledge.retrieval_use" || ref.owner === "cendra.skill.reviewed_release") {
          sources.push({
            sourceRef: ref,
            status: "HOST_AUTHORITY_REQUIRED",
            reason: "HOST_AUTHORITY_REQUIRED",
          });
          continue;
        }
        if (ref.owner === selectionOwner) {
          const available = selections.some((entry) => key(entry.ref) === key(ref));
          sources.push({
            sourceRef: ref,
            status: available ? "AVAILABLE" : "REFUSED",
            reason: available ? null : "SELECTION_UNAVAILABLE_OR_INEXACT",
          });
          continue;
        }
        if (
          ![
            "company_brain_turn_context_snapshots",
            "workspace_instruction_policy_snapshots",
            "company_profile_snapshots",
            "preference_registry_snapshots",
          ].includes(ref.owner)
        ) {
          sources.push({ sourceRef: ref, status: "UNKNOWN", reason: "UNKNOWN_SOURCE_OWNER" });
          continue;
        }
        const candidates = selections.filter((entry) =>
          entry.retained.some((candidate) => key(candidate) === key(ref)),
        );
        if (ref.owner === "company_brain_turn_context_snapshots") {
          // The immutable 0259 receipt binds this exact accepted-turn snapshot. Its FK is ON DELETE CASCADE;
          // absence/erasure cannot leave a surviving inspected selection attesting it. No direct content grant is needed.
          const available =
            ref.version === undefined &&
            candidates.some(
              ({ selection }) =>
                selection.turn_context_snapshot_id === ref.id &&
                selection.turn_context_snapshot_hash === ref.sha256,
            );
          sources.push({
            sourceRef: ref,
            status: available ? "AVAILABLE" : "REFUSED",
            reason: available ? null : "SNAPSHOT_UNAVAILABLE_OR_INEXACT",
          });
          continue;
        }
        if (ref.version !== ref.sha256 || !/^[a-f0-9-]{36}$/.test(ref.id)) {
          sources.push({ sourceRef: ref, status: "REFUSED", reason: "SNAPSHOT_INEXACT" });
          continue;
        }
        const snapshot = await readSnapshotIdentity(tx, receipt, ref);
        const available =
          snapshot?.hash === ref.sha256 &&
          snapshot.revisionsAvailable &&
          candidates.some(
            ({ origin, selection }) =>
              snapshot.sessionId === origin.sessionId &&
              snapshot.turnId === origin.turnId &&
              snapshot.attemptId === origin.attemptId &&
              snapshot.executionGeneration === origin.executionGeneration &&
              (ref.owner === "workspace_instruction_policy_snapshots"
                ? selection.instruction_policy_entry_hash === ref.sha256
                : ref.owner === "company_profile_snapshots"
                  ? selection.company_profile_included &&
                    selection.company_profile_snapshot_hash === ref.sha256
                  : selection.preference_descriptor_hash === ref.sha256),
          );
        sources.push({
          sourceRef: ref,
          status: available ? "AVAILABLE" : "REFUSED",
          reason: available ? null : "SNAPSHOT_UNAVAILABLE_OR_INEXACT",
        });
      }
      for (const source of sources) if (source.reason) reasons.add(source.reason);
      return { complete: reasons.size === 0, incompleteReasons: [...reasons].sort(), sources };
    } finally {
      // Savepoint release preserves SET LOCAL. Leave a host-owned outer transaction's subject intact.
      await tx.execute(
        sql`select set_config('opengeni.subject_id', ${prior?.subject ?? ""}, true)`,
      );
    }
  });
}

function storedTupleMatches(
  row: typeof schema.modelCallSourceReceipts.$inferSelect,
  receipt: ModelCallSourceReceipt,
): boolean {
  return (
    row.id === receipt.id &&
    row.accountId === receipt.accountId &&
    row.workspaceId === receipt.workspaceId &&
    row.sessionId === receipt.sessionId &&
    row.turnId === receipt.turnId &&
    row.attemptId === receipt.attemptId &&
    row.executionGeneration === receipt.executionGeneration &&
    row.sourceKey === receipt.sourceKey &&
    row.requestIndex === receipt.requestIndex
  );
}

async function readSnapshotIdentity(
  tx: Database,
  receipt: ModelCallSourceReceipt,
  ref: ModelSourceRef,
): Promise<SnapshotIdentity | undefined> {
  let query;
  if (ref.owner === "workspace_instruction_policy_snapshots")
    query = sql`select s.session_id as "sessionId", s.turn_id as "turnId", s.attempt_id as "attemptId", s.execution_generation as "executionGeneration", s.entry_hash as hash,
    not exists (select 1 from jsonb_array_elements(s.entries) e where not exists (select 1 from workspace_instruction_policy_revisions r where r.account_id=s.account_id and r.workspace_id=s.workspace_id and r.id=(e->>'revisionId')::uuid and r.revision=(e->>'revision')::integer and r.content_hash=e->>'contentHash')) as "revisionsAvailable"
    from workspace_instruction_policy_snapshots s where s.account_id=${receipt.accountId}::uuid and s.workspace_id=${receipt.workspaceId}::uuid and s.id=${ref.id}::uuid`;
  else if (ref.owner === "company_profile_snapshots")
    query = sql`select s.session_id as "sessionId", s.turn_id as "turnId", s.attempt_id as "attemptId", s.execution_generation as "executionGeneration", s.snapshot_hash as hash,
    (s.profile is null or exists (select 1 from company_profile_revisions r where r.account_id=s.account_id and r.id=(s.profile->>'id')::uuid and r.revision=(s.profile->>'revision')::integer and r.content_hash=s.profile->>'contentHash')) as "revisionsAvailable"
    from company_profile_snapshots s where s.account_id=${receipt.accountId}::uuid and s.workspace_id=${receipt.workspaceId}::uuid and s.id=${ref.id}::uuid`;
  else
    query = sql`select s.session_id as "sessionId", s.turn_id as "turnId", s.attempt_id as "attemptId", s.execution_generation as "executionGeneration", s.descriptor_hash as hash,
    not exists (select 1 from jsonb_array_elements(s.descriptors) e where not exists (select 1 from preference_registry_revisions r where r.account_id=s.account_id and r.preference_id=(e->>'id')::uuid and r.id=(e->>'revisionId')::uuid and r.content_hash=e->>'contentHash')) as "revisionsAvailable"
    from preference_registry_snapshots s where s.account_id=${receipt.accountId}::uuid and s.workspace_id=${receipt.workspaceId}::uuid and s.id=${ref.id}::uuid`;
  const [snapshot] = await rawRows<SnapshotIdentity>(tx, query);
  return snapshot;
}
