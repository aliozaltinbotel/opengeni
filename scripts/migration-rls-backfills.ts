/**
 * Static analysis for migration-time backfills that silently no-op
 * under Opengeni's production migration principal.
 *
 * `FORCE ROW LEVEL SECURITY` binds the TABLE OWNER, not merely ordinary roles;
 * only a genuine `SUPERUSER` (or `BYPASSRLS`) escapes it. Opengeni's documented
 * deployment posture (`docs/deployment.md`) runs migrations as a NON-superuser
 * owner without `BYPASSRLS`. During a migration no `opengeni.account_id` /
 * `opengeni.workspace_id` GUC is set, so a GUC-gated `workspace_isolation`
 * policy evaluates false for every row and a top-level `UPDATE` / `DELETE` /
 * `INSERT ... SELECT` / `DO $$ ... $$` backfill loop touches ZERO rows and
 * reports success.
 *
 * One mitigation is the owner-only posture window already used by
 * `0009_goal_sessions_first_party_goals_manage.sql` and
 * `0120_durable_goal_wake.sql`:
 *
 *   ALTER TABLE "t" NO FORCE ROW LEVEL SECURITY;
 *   -- ... the backfill ...
 *   ALTER TABLE "t" FORCE ROW LEVEL SECURITY;
 *
 * `NO FORCE` relaxes only the owner; the application role stays policy-bound,
 * and the migration runner executes each file in one implicit transaction so a
 * failure rolls back the posture change with the data repair.
 *
 * Alternatives this analyzer also accepts: setting the tenant GUC around the
 * statement, disabling RLS on the table for the window, or activating a policy
 * that is pinned to the exact table owner and a transaction-local capability.
 * The latter may be set inside the statement or by the exact governed batched-
 * migration runner contract before the statement executes.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStatements, stripComments } from "../packages/db/src/migration-sql";
export { splitStatements, stripComments } from "../packages/db/src/migration-sql";
import { batchedBackfillTransactionLocalSetting } from "../packages/db/src/migration-runner-settings";
import {
  SESSION_HISTORY_CAPABILITY,
  sessionHistoryBackfillPlan,
  sessionHistoryRlsExecutableSql,
} from "../packages/db/src/migration-session-history-backfills";

export const MIGRATIONS_DIR = "packages/db/drizzle";

// Each complete statement here (including comments) only reads catalog source
// and replaces a routine definition. The writes it names run in that routine,
// not during migration. Bind this classification to reviewed bytes: changed
// statements keep conservative analysis, as do every adjacent statement and
// all migration-time backfills. The grandfather lists below remain frozen.
const REVIEWED_ROUTINE_SOURCE_PATCH_SHA256 = new Set([
  // 0697: one routine source patch.
  "68249f30d87220cb0cdc78882a237613e32e481122beb96ca5cadde0c64f46e4",
  // 0855 statements 3 and 4: patch both fork routines, then check the patch.
  "0b02e5d3e8647e158836970622896e15d0ecc8c0bbd9c1a06583594e648639a3",
  "2ec24b44e91326ab518e13ea90d1b65bbebafb24ec1361ce589032ebe9c7904b",
]);

/**
 * Migrations that shipped before this class was identified. Their bytes are
 * frozen by the release schema-contract hash ladder and cannot be rewritten, so
 * they are recorded here instead. `0296_force_rls_backfill_noop_repair.sql`
 * repairs the instances that genuinely lost data; the rest are classified in
 * `docs/force-rls-migration-backfills.md`.
 *
 * DO NOT add to this list. A new migration that needs a backfill over a
 * FORCE-RLS table must open the `NO FORCE` window instead.
 */
export const GRANDFATHERED_MIGRATIONS: readonly string[] = [
  "0014_repair_orphaned_function_call_results.sql",
  "0018_sandbox_os.sql",
  "0045_workspace_memory_v1.sql",
  "0057_durable_queue_control.sql",
  "0058_turn_admission_usage_enrollment.sql",
  "0061_session_workflow_wake_outbox.sql",
  "0063_session_control_mega_foundation.sql",
  "0064_rotation_strategy_sharded_backfill.sql",
  "0065_session_attempt_quiescence.sql",
  "0068_workspace_control_event_bounds.sql",
  "0069_session_event_history_backfill.sql",
  "0094_quarantine_credential_bearing_catalog_urls.sql",
  "0104_host_export_root_session_backfill.sql",
  "0111_nested_agent_depth_backfill.sql",
  "0117_sandbox_recovery_generations.sql",
  "0122_codex_capacity_same_turn.sql",
  "0126_document_access_constraints.sql",
  "0132_connection_subject_isolation.sql",
  "0135_durable_machine_input_batches.sql",
  "0136_unified_session_tool_policy.sql",
  "0138_sandbox_checkpoint_artifacts_and_deadlines.sql",
  "0143_session_codex_compaction_mode.sql",
  "0148_session_turn_latency_mode.sql",
  "0149_workspace_artifacts.sql",
  "0152_hierarchical_memory_foundation.sql",
  "0157_session_policy_role_snapshots.sql",
  "0170_session_control_wake_revision.sql",
  "0172_retire_model_visible_github_token.sql",
  "0175_resumable_transcription_provider_deadline.sql",
  "0180_retained_screenshot_lifecycle_fences.sql",
  "0184_sandbox_drain_teardown_fence.sql",
  "0186_sandbox_capture_provider_contract.sql",
  "0197_knowledge_source_sync_schedules.sql",
  "0201_company_profile_authority.sql",
  "0202_document_index_checkpoints.sql",
  "0212_browser_state_transfer_hardening.sql",
  "0212_slack_installation_bindings.sql",
  "0213_browser_interaction_authority.sql",
  "0215_browser_controller_host.sql",
  "0216_browser_auth_health_evidence.sql",
  "0219_organization_tenancy_managed_human_provisioning.sql",
  "0222_session_visibility_authority_epochs.sql",
  "0224_slack_post_outcome_reconciliation.sql",
  "0225_session_visibility_fork_activation.sql",
  "0226_personal_codex_authority_foundation.sql",
  "0231_integration_definition_identity_cutover.sql",
  "0232_integration_facet_authority_cutover.sql",
  "0233_skill_and_integration_authority_cutover.sql",
  "0234_xai_subscription_authority.sql",
  "0235_canonical_human_login_bindings.sql",
  "0238_goal_persistence_policy.sql",
  "0238_recover_unclaimed_session_turns.sql",
  "0240_model_context_user_messages.sql",
  "0241_atomic_personal_resource_delegation.sql",
  "0247_terraform_stacks_provenance_repair.sql",
  "0249_personal_resource_delegation_authority_correction.sql",
  "0252_scheduled_personal_resource_delegation.sql",
  "0253_common_user_resource_authority_lifecycle.sql",
  "0254_scoped_variable_set_authority.sql",
  "0256_connection_authority_delegation.sql",
  "0258_three_scope_document_knowledge_authority.sql",
  "0262_scoped_connected_machines_and_rigs.sql",
  "0263_organization_membership_lifecycle.sql",
  "0264_connection_authority_runtime_activation.sql",
  "0275_scheduled_connection_authority.sql",
  "0277_workspace_writer_authority_attribution.sql",
  "0280_connection_and_variable_set_audit_attribution.sql",
  "0289_session_composer_policy_authority.sql",
];

/**
 * Migrations whose `DO $$ ... IF EXISTS (SELECT ... FROM <FORCE-RLS table>)
 * ... RAISE EXCEPTION` preflight guard reads zero rows for the same reason, so
 * the guard passes vacuously and never fires. These predate the guard.
 * The safety of those cutovers came from `VALIDATE CONSTRAINT` / `SET NOT NULL`
 * / unique-index builds, which are internal scans and DO bypass RLS - never
 * from the `DO` block.
 *
 * DO NOT add to this list. A new preflight guard over a FORCE-RLS table must
 * open the `NO FORCE` window too, or it is decoration.
 */
export const GRANDFATHERED_VACUOUS_GUARDS: readonly string[] = [
  "0057_durable_queue_control.sql",
  "0063_session_control_mega_foundation.sql",
  "0106_session_attempt_mcp_approval_policies.sql",
  "0107_host_export_lineage_contract.sql",
  "0110_nested_agent_depth_boundary.sql",
  "0122_codex_capacity_same_turn.sql",
  "0135_durable_machine_input_batches.sql",
  "0137_preference_registry.sql",
  "0157_session_policy_role_snapshots.sql",
  "0197_knowledge_source_sync_schedules.sql",
  "0199_workspace_learning_policy.sql",
  "0225_session_visibility_fork_activation.sql",
  "0231_integration_definition_identity_cutover.sql",
  "0232_integration_facet_authority_cutover.sql",
  "0233_skill_and_integration_authority_cutover.sql",
  "0240_model_context_user_messages.sql",
  "0247_terraform_stacks_provenance_repair.sql",
  "0248_terraform_stacks_component_resolution_fence.sql",
  "0264_connection_authority_runtime_activation.sql",
  "0275_scheduled_connection_authority.sql",
];

export type BackfillFinding = {
  /** Migration file name, e.g. `0296_...sql`. */
  file: string;
  /** 1-based index of the offending top-level statement within the file. */
  statement: number;
  /**
   * `write` - a backfill that matches zero rows and reports success.
   * `vacuous-guard` - a `RAISE EXCEPTION` preflight that can never fire.
   */
  kind: "write" | "vacuous-guard";
  /** FORCE-RLS tables the statement touches. */
  tables: string[];
  /** Leading text of the statement, whitespace-collapsed. */
  snippet: string;
};

/** Literal-unaware stripping: removes every `--`/`/* *\/` run, even in
 * literals. Suppressing tokens must survive this too, so comment text can
 * never suppress a finding. */
const stripAllCommentText = (text: string) =>
  text.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

const TABLE_REF = (table: string) => `(?:"${table}"|${table})`;
const NOT_IDENT = String.raw`(?![A-Za-z0-9_"])`;

/** Does `statement` write rows of `table` at the top level? */
export function writesTable(statement: string, table: string): boolean {
  const ref = TABLE_REF(table);
  return (
    new RegExp(String.raw`\b(?:UPDATE|MERGE\s+INTO)\s+(?:ONLY\s+)?${ref}${NOT_IDENT}`, "i").test(
      statement,
    ) ||
    new RegExp(String.raw`\bINSERT\s+INTO\s+${ref}${NOT_IDENT}`, "i").test(statement) ||
    new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${ref}${NOT_IDENT}`, "i").test(statement)
  );
}

/** Does `statement` read rows of `table`? */
export function readsTable(statement: string, table: string): boolean {
  const ref = TABLE_REF(table);
  return new RegExp(String.raw`\b(?:FROM|JOIN|USING)\s+(?:ONLY\s+)?${ref}${NOT_IDENT}`, "i").test(
    statement,
  );
}

const ROUTINE_START = /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/gi;
const ROUTINE_AS_DOLLAR = /\bAS\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/i;

/**
 * Drop CREATE FUNCTION/PROCEDURE bodies so a DO block that *defines* a
 * later-running trigger/lifecycle routine is not treated as a migration-time
 * backfill. `EXECUTE format($ddl$ UPDATE ... $ddl$)` still looks like a write.
 */
export function stripRoutineBodies(statement: string): string {
  const publication = stripCatalogRoutinePatchLiterals(statement);
  if (publication.ambiguous) return statement;
  statement = publication.source;
  let out = "";
  let index = 0;
  while (index < statement.length) {
    ROUTINE_START.lastIndex = index;
    const match = ROUTINE_START.exec(statement);
    if (!match || match.index === undefined) {
      out += statement.slice(index);
      break;
    }
    out += statement.slice(index, match.index);
    const asTag = ROUTINE_AS_DOLLAR.exec(statement.slice(match.index));
    if (!asTag || asTag.index === undefined || asTag[1] === undefined) {
      out += statement.slice(match.index, match.index + match[0].length);
      index = match.index + match[0].length;
      continue;
    }
    const tag = asTag[1];
    const bodyStart = match.index + asTag.index + asTag[0].length;
    const close = statement.indexOf(tag, bodyStart);
    if (close === -1) {
      out += statement.slice(match.index);
      break;
    }
    out += `${statement.slice(match.index, bodyStart)} /* routine body omitted */ `;
    index = close + tag.length;
  }
  return out;
}

/** A quoted replacement used only to patch pg_get_functiondef is routine
 * source, not an executed migration query. Keep arbitrary EXECUTE strings and
 * every actual query outside the replacement visible to the guard. */
type CatalogRoutineRead = Readonly<{ bodyVariables: readonly string[]; statement: string }>;

function ambiguousRoutineFragment(fragment: string): boolean {
  return /\$(?:[a-z_]\w*)?\$|\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?|ALTER\s+|DROP\s+)(?:FUNCTION|PROCEDURE)\b|\b(?:RETURNS|LANGUAGE\s+[a-z_]\w*|SECURITY\s+(?:DEFINER|INVOKER)|SET\s+(?:search_path|row_security))\b/i.test(fragment);
}

function inlineRoutinePatch(expression: string, definition: string, constants: ReadonlyMap<string, string> = new Map()): Readonly<{ ambiguous: boolean; closed: boolean; replacementValue: string }> {
  const literals = /(\$[a-z_]\w*\$|\$\$)([\s\S]*?)\1|\b[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'/gi;
  if (constants.size > 0) {
    const tokens = new RegExp(`${literals.source}|\\b[a-z_]\\w*\\b`, "gi");
    expression = expression.replace(tokens, (token) => {
      const value = constants.get(token);
      return value === undefined ? token : `'${value.replace(/'/g, "''")}'`;
    });
  }
  let unknownEscape = false;
  const literalMatches = [...expression.matchAll(literals)];
  const fragments = literalMatches.map((match) => {
    if (match[2] !== undefined) return match[2];
    const value = match[0].replace(/^[Ee]?'|'$/g, "").replace(/''/g, "'");
    if (!/^[Ee]'/.test(match[0])) {
      if (value.includes("\\")) unknownEscape = true;
      return value;
    }
    // Only the existing constant newline/tab/backslash forms are admitted.
    // Hex, octal, Unicode and every unknown escape stay visible to analysis.
    return value.replace(/\\([\s\S])/g, (_whole, escape: string) => {
      if (escape === "n") return "\n";
      if (escape === "r") return "\r";
      if (escape === "t") return "\t";
      if (escape === "\\") return "\\";
      unknownEscape = true;
      return escape;
    });
  });
  const joined = fragments.reduce((result, fragment, index) => {
    const previous = literalMatches[index - 1];
    const current = literalMatches[index];
    const between = previous?.index !== undefined && current?.index !== undefined
      ? expression.slice(previous.index + previous[0].length, current.index) : "";
    return result + (/^\s*\|\|\s*$/.test(between) ? "" : "\n") + fragment;
  }, "");
  const ambiguous = unknownEscape || ambiguousRoutineFragment(joined);
  const skeleton = expression.replace(literals, "''");
  const constant = "''(?:\\s*\\|\\|\\s*'')*";
  const closed = new RegExp(`^\\s*${definition}\\s*:=\\s*(?:pg_catalog\\s*\\.\\s*)?replace\\(\\s*${definition}\\s*,\\s*${constant}\\s*,\\s*${constant}\\s*\\)\\s*;\\s*$`, "i").test(skeleton);
  return { ambiguous, closed, replacementValue: fragments.slice(1).join("") };
}

function constantRoutinePatchBindings(statement: string, definition: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const block = /^\s*DO\s+(\$[a-z_]\w*\$|\$\$)([\s\S]*)\1\s*;?\s*$/i.exec(statement);
  if (!block?.[2]) return values;
  const parts = splitStatements(block[2]);
  const candidates = new Map<string, { value: string; assignment: string }>();
  const duplicates = new Set<string>();
  for (const part of parts) {
    const assignment = /^\s*(?:DECLARE\s+|BEGIN\s+)?([a-z_]\w*)(?:\s+text)?\s*:=\s*([\s\S]+?)\s*;?\s*$/i.exec(part);
    if (!assignment?.[1] || !assignment[2] || assignment[1] === definition) continue;
    const name = assignment[1];
    if (candidates.has(name)) duplicates.add(name);
    const value = inlineRoutinePatch(`source := replace(source, '', ${assignment[2]});`, "source");
    if (value.closed && !value.ambiguous) candidates.set(name, { value: value.replacementValue, assignment: part });
  }
  for (const [name, candidate] of candidates) {
    if (duplicates.has(name)) continue;
    let flow = block[2].replace(candidate.assignment, "");
    for (const part of parts) if (new RegExp(`^\\s*${definition}\\s*:=\\s*(?:pg_catalog\\s*\\.\\s*)?replace\\(`, "i").test(part)) flow = flow.replace(part, "");
    flow = flow
      .replace(new RegExp(`\\b${name}\\s+text\\s*;`, "gi"), "")
      .replace(new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?length\\(\\s*(?:pg_catalog\\s*\\.\\s*)?replace\\(\\s*${definition}\\s*,\\s*${name}\\s*,\\s*''\\s*\\)\\s*\\)`, "gi"), "")
      .replace(new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?length\\(\\s*${name}\\s*\\)`, "gi"), "")
      .replace(/(\$[a-z_]\w*\$|\$\$)([\s\S]*?)\1|\b[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'/gi, "''");
    if (!new RegExp(`\\b${name}\\b`, "i").test(flow)) values.set(name, candidate.value);
  }
  return values;
}

function closedRoutineDefinitionUses(statement: string, definition: string, admitted: readonly string[]): boolean {
  const block = /^\s*DO\s+(\$[a-z_]\w*\$|\$\$)([\s\S]*)\1\s*;?\s*$/i.exec(statement);
  if (!block?.[2]) return false;
  let flow = block[2];
  for (const part of admitted) flow = flow.replace(part, "");
  flow = flow
    .replace(/(\$[a-z_]\w*\$|\$\$)([\s\S]*?)\1|\b[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'/gi, "''")
    .replace(new RegExp(`\\b${definition}\\s+text\\s*;`, "gi"), "")
    .replace(new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?length\\(\\s*(?:pg_catalog\\s*\\.\\s*)?replace\\(\\s*${definition}\\s*,\\s*(?:[a-z_]\\w*|'')\\s*,\\s*''\\s*\\)\\s*\\)`, "gi"), "")
    .replace(new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?(?:length|md5)\\(\\s*${definition}\\s*\\)`, "gi"), "")
    .replace(new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?strpos\\(\\s*${definition}\\s*,\\s*(?:[a-z_]\\w*|'')\\s*\\)`, "gi"), "")
    .replace(new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?position\\(\\s*(?:[a-z_]\\w*|'')\\s+IN\\s+${definition}\\s*\\)`, "gi"), "")
    .replace(new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?cardinality\\(\\s*(?:pg_catalog\\s*\\.\\s*)?string_to_array\\(\\s*${definition}\\s*,\\s*(?:[a-z_]\\w*|'')\\s*\\)\\s*\\)`, "gi"), "")
    .replace(new RegExp(`\\b${definition}\\s+IS\\s+(?:NOT\\s+)?NULL\\b`, "gi"), "");
  // Existing migrations compare a read-only copy before/after replace. A copy
  // is a witness only when it is used exclusively by that scalar IF check.
  const witnesses = new Set([...flow.matchAll(new RegExp(`\\b([a-z_]\\w*)\\s*:=\\s*${definition}\\s*;`, "gi"))].map((match) => match[1]));
  for (const witness of witnesses) {
    if (!witness || witness === definition) return false;
    const declaration = new RegExp(`\\b${witness}\\s+text\\s*;`, "gi");
    const copy = new RegExp(`\\b${witness}\\s*:=\\s*${definition}\\s*;`, "gi");
    const comparison = new RegExp(`\\bIF\\s+${definition}\\s*=\\s*${witness}\\s+THEN\\b`, "gi");
    const remaining = flow.replace(declaration, "").replace(copy, "").replace(comparison, "");
    if (new RegExp(`\\b${witness}\\b`, "i").test(remaining)) return false;
    flow = remaining;
  }
  return !new RegExp(`\\b${definition}\\b`, "i").test(flow);
}

function catalogRoutineReadBindings(statement: string): ReadonlyMap<string, CatalogRoutineRead> {
  const bindings = new Map<string, CatalogRoutineRead>();
  const block = /^\s*DO\s+(\$[a-z_]\w*\$|\$\$)([\s\S]*)\1\s*;?\s*$/i.exec(statement);
  if (!block?.[2]) return bindings;
  for (const part of splitStatements(block[2])) {
    const select = /^\s*(?:BEGIN\s+)?SELECT\s+([\s\S]+?)\s+INTO\s+([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)\s+FROM\s+(?:pg_catalog\s*\.\s*)?pg_proc\b[\s\S]*$/i.exec(part);
    if (!select?.[1] || !select[2]) continue;
    // Split only top-level SELECT columns; commas in catalog metadata builders
    // and quoted keys are not INTO positions.
    const columns: string[] = [];
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let index = 0; index <= select[1].length; index += 1) {
      const char = select[1][index];
      if (quote) {
        if (char === quote && select[1][index + 1] === quote) index += 1;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "'" || char === '"') quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      else if ((char === "," && depth === 0) || char === undefined) {
        columns.push(select[1].slice(start, index).trim());
        start = index + 1;
      }
    }
    const targets = select[2].split(/\s*,\s*/);
    const uniqueTargets = new Set(targets.map((target) => target.toLowerCase()));
    if (quote || depth !== 0 || columns.length !== targets.length || uniqueTargets.size !== targets.length) continue;
    const definitionColumns = columns.flatMap((column, index) =>
      /^(?:pg_catalog\s*\.\s*)?pg_get_functiondef\s*\(\s*(?:[a-z_]\w*\s*\.\s*)?[a-z_]\w*\s*\)$/i.test(column)
        ? [index] : [],
    );
    if (definitionColumns.length !== 1) continue;
    const definitionIndex = definitionColumns[0];
    if (definitionIndex === undefined) continue;
    const definition = targets[definitionIndex];
    if (!definition || bindings.has(definition)) continue;
    const bodyVariables = columns.flatMap((column, index) => {
      const target = targets[index];
      return target && /^(?:[a-z_]\w*\s*\.\s*)?prosrc$/i.test(column) ? [target] : [];
    });
    bindings.set(definition, { bodyVariables, statement: part });
  }
  return bindings;
}

function stripCatalogRoutinePatchLiterals(statement: string): Readonly<{ source: string; ambiguous: boolean }> {
  let ambiguous = false;
  // Chained replacements of a pg_get_functiondef result are also routine
  // source, provided the resulting definition is the block's sole dynamic
  // execution. Keep every other statement visible to the backfill analyzer.
  // The built-ins may be schema-qualified with pg_catalog; no other schema.
  const source =
    /\b([a-z_]\w*)\s*:=\s*(?:pg_catalog\s*\.\s*)?pg_get_functiondef\s*\([\s\S]*?\)\s*;/gi;
  const sources = [...statement.matchAll(source)];
  if (sources.length === 1) {
    const variable = sources[0]![1]!;
    const constants = constantRoutinePatchBindings(statement, variable);
    const execution = new RegExp(`\\bEXECUTE\\s+${variable}\\s*;`, "gi");
    const executions = [...statement.matchAll(execution)];
    const otherExecutions = [...statement.matchAll(/\bEXECUTE\b/gi)].length;
    const assignments = [...statement.matchAll(new RegExp(`\\b${variable}\\s*:=`, "gi"))];
    if (executions.length === 1 && otherExecutions === 1) {
      const replacements: Array<{ start: number; end: number }> = [];
      let cursor = sources[0]!.index! + sources[0]![0].length;
      const assignment = new RegExp(
        `\\b${variable}\\s*:=\\s*(?:pg_catalog\\s*\\.\\s*)?replace\\s*\\(\\s*${variable}\\s*,`,
        "gi",
      );
      let match: RegExpExecArray | null;
      while ((match = assignment.exec(statement))) {
        if (match.index < cursor) continue;
        let depth = 1;
        let quoted = false;
        let end = match.index + match[0].length;
        for (; end < statement.length; end += 1) {
          const char = statement[end]!;
          if (char === "'") {
            if (quoted && statement[end + 1] === "'") {
              end += 1;
              continue;
            }
            quoted = !quoted;
          } else if (!quoted && char === "(") depth += 1;
          else if (!quoted && char === ")") depth -= 1;
          else if (!quoted && char === ";" && depth === 0) break;
        }
        if (depth !== 0 || quoted || statement[end] !== ";") break;
        const publication = inlineRoutinePatch(statement.slice(match.index, end + 1), variable, constants);
        if (publication.ambiguous) {
          ambiguous = true;
          break;
        }
        if (!publication.closed) break;
        replacements.push({ start: match.index, end: end + 1 });
        cursor = end + 1;
        assignment.lastIndex = cursor;
      }
      if (replacements.length > 0 && assignments.length === replacements.length + 1) {
        const admitted = [sources[0]![0], executions[0]![0],
          ...replacements.map((range) => statement.slice(range.start, range.end))];
        if (!closedRoutineDefinitionUses(statement, variable, admitted))
          return { source: statement, ambiguous: true };
        const ranges = [
          ...replacements,
          { start: executions[0]!.index!, end: executions[0]!.index! + executions[0]![0].length },
        ].sort((left, right) => right.start - left.start);
        let stripped = statement;
        for (const range of ranges) {
          stripped = `${stripped.slice(0, range.start)}${stripped.slice(range.end)}`;
        }
        return { source: stripped, ambiguous };
      }
    }
  }

  // The literal may be assigned in the body or initialised in DECLARE
  // (`replacement text := $new$...$new$;`); both bind the same variable.
  const assignments = /\b([a-z_]\w*)(?:\s+text)?\s*:=\s*(\$[a-z_]\w*\$|\$\$)([\s\S]*?)\2\s*;/gi;
  const result = statement.replace(assignments, (whole, variable: string, _tag: string, fragment: string) => {
    const outside = statement.replace(whole, `${variable} := NULL;`);
    const replacementArguments = "([a-z_]\\w*)\\s*,\\s*([a-z_]\\w*)";
    const directUse = new RegExp(`\\bEXECUTE\\s+replace\\(\\s*([a-z_]\\w*)\\s*,\\s*${replacementArguments}\\s*\\)\\s*;`, "i");
    const assignedUse = new RegExp(`\\b([a-z_]\\w*)\\s*:=\\s*replace\\(\\s*\\1\\s*,\\s*${replacementArguments}\\s*\\)\\s*;`, "i");
    const use = [...outside.matchAll(new RegExp(directUse.source, "gi")),
      ...outside.matchAll(new RegExp(assignedUse.source, "gi"))]
      .find((match) => match[2] === variable || match[3] === variable);
    if (!use) return whole;
    const definition = use[1]!;
    if (definition === variable) return whole;
    const finalExecution = new RegExp(`\\bEXECUTE\\s+${definition}\\s*;`, "gi");
    if (!/^EXECUTE\b/i.test(use[0]) && [...outside.matchAll(finalExecution)].length !== 1)
      return whole;
    const writes = [...outside.matchAll(new RegExp(`\\b${definition}\\s*:=\\s*([^;]+);`, "gi"))];
    const directReads = writes.filter((match) => /^pg_get_functiondef\s*\(/i.test(match[1]!.trim()));
    const catalogBinding = directReads.length === 0
      ? catalogRoutineReadBindings(outside).get(definition)
      : undefined;
    const intoWrites = [...outside.matchAll(/\bINTO\s+([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)/gi)]
      .filter((match) => match[1]!.split(/\s*,\s*/).includes(definition));
    if (catalogBinding ? intoWrites.length !== 1
      : directReads.length === 0 || intoWrites.length !== 0) return whole;
    if (
      writes.some(
        (match) =>
          !new RegExp(`^(?:pg_get_functiondef\\s*\\(|replace\\(\\s*${definition}\\s*,)`, "i").test(
            match[1]!.trim(),
          ),
      )
    )
      return whole;
    if (ambiguousRoutineFragment(fragment)) {
      ambiguous = true;
      return whole;
    }
    if (catalogBinding) {
      // SELECT INTO is trusted only at the exact output position. Admit its
      // small publication dataflow, not an open-ended PL/pgSQL write grammar.
      // Anything left can overwrite or otherwise expose the definition.
      let flow = outside.replace(catalogBinding.statement, "")
        .replace(new RegExp(assignments.source, "gi"), "$1 := NULL;")
        .replace(/\b[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'/g, "''");
      flow = flow
        .replace(new RegExp(`\\b${definition}\\s+text\\s*;`, "gi"), "")
        .replace(new RegExp(`\\b${definition}\\s*:=\\s*replace\\(\\s*${definition}\\s*,\\s*[a-z_]\\w*\\s*,\\s*[a-z_]\\w*\\s*\\)\\s*;`, "gi"), "")
        .replace(new RegExp(`\\bEXECUTE\\s+replace\\(\\s*${definition}\\s*,\\s*[a-z_]\\w*\\s*,\\s*[a-z_]\\w*\\s*\\)\\s*;`, "gi"), "")
        .replace(finalExecution, "")
        .replace(new RegExp(`\\b(?:length|md5)\\(\\s*${definition}\\s*\\)`, "gi"), "")
        .replace(new RegExp(`\\blength\\(\\s*replace\\(\\s*${definition}\\s*,\\s*[a-z_]\\w*\\s*,\\s*''\\s*\\)\\s*\\)`, "gi"), "")
        .replace(new RegExp(`\\b${definition}\\s+IS\\s+(?:NOT\\s+)?NULL\\b`, "gi"), "");
      if (new RegExp(`\\b${definition}\\b`, "i").test(flow)) return whole;
    } else if (!closedRoutineDefinitionUses(outside, definition, [
      ...writes.map((match) => match[0]), use[0],
      ...[...outside.matchAll(finalExecution)].map((match) => match[0]),
    ])) {
      return whole;
    }
    // Declaration and the one assignment/use are the only permitted references
    // to the replacement variable. Additional execution or data flow is opaque.
    let remainder = outside
      .replace(use[0], "")
      .replace(finalExecution, "")
      .replace(new RegExp(`\\b${variable}\\s*:=\\s*NULL\\s*;`, "i"), "")
      .replace(new RegExp(`\\b${variable}\\s+text\\s*;`, "i"), "");
    // Anchor length/containment checks over catalog source produce only scalar
    // metadata. Any other use, reassignment or execution remains opaque.
    if (use[2] === variable) {
      const sources = [definition, ...(catalogBinding?.bodyVariables ?? [])].join("|");
      remainder = remainder
        .replace(new RegExp(`\\blength\\(\\s*replace\\(\\s*(?:${sources})\\s*,\\s*${variable}\\s*,\\s*''\\s*\\)\\s*\\)`, "gi"), "")
        .replace(new RegExp(`\\blength\\(\\s*${variable}\\s*\\)`, "gi"), "")
        .replace(new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?strpos\\(\\s*(?:${sources})\\s*,\\s*${variable}\\s*\\)`, "gi"), "")
        .replace(new RegExp(`\\b(?:pg_catalog\\s*\\.\\s*)?position\\(\\s*${variable}\\s+IN\\s+(?:${sources})\\s*\\)`, "gi"), "")
        .replace(new RegExp(`\\b(?:${sources})\\s+(?:NOT\\s+)?LIKE\\s*'%'\\s*\\|\\|\\s*${variable}\\s*\\|\\|\\s*'%'`, "gi"), "");
    }
    const variableUses = remainder.replace(/\b[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'/g, "''");
    if (new RegExp(`\\b${variable}\\b`, "i").test(variableUses)) return whole;
    return `${variable} := NULL; /* catalog routine replacement omitted */`;
  });
  return { source: result, ambiguous };
}

const DDL_ONLY =
  /^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|VIEW|MATERIALIZED|TRIGGER|INDEX|UNIQUE|POLICY|SCHEMA|TYPE|EXTENSION|SEQUENCE|ROLE|TABLE)/i;
const NON_DML =
  /^(DROP|ALTER|GRANT|REVOKE|COMMENT|SET|RESET|LOCK|ANALYZE|VACUUM|REASSIGN|SECURITY)\b/i;

type OwnerCapabilityPolicy = { guc: string; table: string };

function parenthesizedPolicyClause(statement: string, marker: RegExp): string | null {
  const match = marker.exec(statement);
  if (!match || match.index === undefined) return null;
  const open = statement.indexOf("(", match.index);
  if (open === -1) return null;

  let depth = 0;
  for (let index = open; index < statement.length; index += 1) {
    const char = statement[index]!;
    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      while (index < statement.length) {
        if (statement[index] === quote && statement[index + 1] === quote) {
          index += 2;
          continue;
        }
        if (statement[index] === quote) break;
        index += 1;
      }
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return statement.slice(open + 1, index);
    }
  }
  return null;
}

function ownerCapabilityClauseGuc(clause: string, table: string): string | null {
  const exactOwner = new RegExp(
    String.raw`current_user\s*=\s*\(\s*SELECT\s+pg_catalog\.pg_get_userbyid\s*\(\s*[a-z0-9_]+\.relowner\s*\)\s+FROM\s+pg_catalog\.pg_class\s+[a-z0-9_]+\s+WHERE\s+[a-z0-9_]+\.oid\s*=\s*'${table}'::regclass\s*\)`,
    "gi",
  );
  const capability =
    /(?:pg_catalog\.)?current_setting\s*\(\s*'opengeni\.([a-z0-9_]+)'\s*,\s*true\s*\)\s*=\s*'1'/gi;
  const ownerMatches = clause.match(exactOwner) ?? [];
  const capabilityMatches = [...clause.matchAll(capability)];
  if (ownerMatches.length !== 1 || capabilityMatches.length !== 1) return null;

  const normalized = clause
    .replace(exactOwner, "OWNER")
    .replace(capability, "CAPABILITY")
    .replace(/[()\s]/g, "")
    .toUpperCase();
  if (normalized !== "OWNERANDCAPABILITY" && normalized !== "CAPABILITYANDOWNER") return null;
  return capabilityMatches[0]![1]!;
}

function ownerCapabilityPolicy(statement: string): OwnerCapabilityPolicy | null {
  const target =
    /^CREATE\s+POLICY\s+(?:"[^"]+"|[a-z0-9_]+)\s+ON\s+(?:(?:"[^"]+"|[a-z0-9_]+)\.)?"?([a-z0-9_]+)"?/i.exec(
      statement.trim(),
    );
  if (!target || !/\bFOR\s+ALL\b/i.test(statement)) {
    return null;
  }

  const table = target[1]!;
  const usingClause = parenthesizedPolicyClause(statement, /\bUSING\s*\(/i);
  const withCheckClause = parenthesizedPolicyClause(statement, /\bWITH\s+CHECK\s*\(/i);
  if (!usingClause || !withCheckClause) return null;

  // Each RLS arm must be exactly the owner proof AND the transaction-local
  // capability proof (in either order, with arbitrary grouping parentheses).
  // Counting tokens across the whole policy would accept owner OR capability,
  // allowing any application role to activate the custom GUC itself.
  const usingGuc = ownerCapabilityClauseGuc(usingClause, table);
  const withCheckGuc = ownerCapabilityClauseGuc(withCheckClause, table);
  if (!usingGuc || usingGuc !== withCheckGuc) return null;
  return { guc: usingGuc, table };
}

function activatedOwnerCapabilityTables(
  statement: string,
  policies: ReadonlyMap<string, OwnerCapabilityPolicy>,
  runnerCapabilityGuc?: string,
): Set<string> {
  const activeGucs = new Set<string>();
  for (const match of statement.matchAll(
    /set_config\s*\(\s*'opengeni\.([a-z0-9_]+)'\s*,\s*'1'\s*,\s*true\s*\)/gi,
  )) {
    activeGucs.add(match[1]!);
  }
  if (runnerCapabilityGuc) activeGucs.add(runnerCapabilityGuc);
  return new Set(
    [...policies.values()]
      .filter((policy) => activeGucs.has(policy.guc))
      .map((policy) => policy.table),
  );
}

/** Recognize only the catalog-filtered, closed regclass window used by 0882.
 * Attribute visibility to its single backfill statement, never to subsequent
 * statements or files. Unrecognized/mutated windows retain ordinary analysis.
 */
function catalogOwnerWindows(statements: readonly string[]): Map<number, Set<string>> {
  const windows = new Map<number, Set<string>>();
  const normalized = statements.map((statement) =>
    stripComments(statement).trim().replace(/\s+/g, " "),
  );
  for (let index = 0; index + 3 < statements.length; index += 1) {
    const capture =
      /^CREATE TEMP TABLE ([a-z_][a-z0-9_]*) ON COMMIT DROP AS SELECT class\.oid::regclass AS relation FROM pg_class class WHERE class\.oid IN \(\s*((?:'[a-z_][a-z0-9_]*'::regclass\s*,\s*)*'[a-z_][a-z0-9_]*'::regclass)\s*\) AND class\.relforcerowsecurity;$/i.exec(
        normalized[index]!,
      );
    if (!capture) continue;
    const temporary = capture[1]!;
    const tables = new Set(
      [...capture[2]!.matchAll(/'([a-z_][a-z0-9_]*)'::regclass/gi)].map((match) =>
        match[1]!.toLowerCase(),
      ),
    );
    if (tables.has(temporary.toLowerCase())) continue;
    const loop = (operation: "NO FORCE" | "FORCE") =>
      new RegExp(
        String.raw`^DO (\$[a-z_][a-z0-9_]*\$) DECLARE forced regclass; BEGIN FOR forced IN SELECT relation FROM ${temporary} ORDER BY relation::text LOOP EXECUTE format\('ALTER TABLE %s ${operation} ROW LEVEL SECURITY', forced\); END LOOP; END \1;$`,
        "i",
      );
    if (
      !loop("NO FORCE").test(normalized[index + 1]!) ||
      !loop("FORCE").test(normalized[index + 3]!)
    )
      continue;
    const body = normalized[index + 2]!;
    // No intervening policy/DDL changes, temp-snapshot edits, or executable DO
    // blocks can inherit the exemption. Matching both comment views prevents
    // quoted/comment text from manufacturing a recognized posture window.
    if (
      !/^(WITH|INSERT|UPDATE|DELETE)\b/i.test(body) ||
      /\b(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL)\b/i.test(body) ||
      /\bDO\b(?!\s+(UPDATE|NOTHING)\b)/i.test(body) ||
      writesTable(body, temporary)
    )
      continue;
    if (
      statements
        .slice(index, index + 4)
        .some(
          (statement, offset) =>
            stripAllCommentText(statement).trim().replace(/\s+/g, " ") !==
            normalized[index + offset],
        )
    )
      continue;
    windows.set(index + 2, tables);
  }
  return windows;
}

/**
 * Walk the whole ordered migration ledger, tracking which tables have RLS
 * enabled + forced at each point, and report top-level writes that would match
 * zero rows for a non-superuser owner.
 */
export function analyzeMigrationRlsBackfills(migrationsDir: string): BackfillFinding[] {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const forced = new Set<string>();
  const enabled = new Set<string>();
  const ownerCapabilityPolicies = new Map<string, OwnerCapabilityPolicy>();
  const findings: BackfillFinding[] = [];

  for (const file of files) {
    const source = readFileSync(join(migrationsDir, file), "utf8");
    const raw = sessionHistoryRlsExecutableSql(file, source);
    const runnerSetting = batchedBackfillTransactionLocalSetting(file);
    const runnerCapabilityGuc = sessionHistoryBackfillPlan(file, source)
      ? SESSION_HISTORY_CAPABILITY.slice("opengeni.".length)
      : runnerSetting?.value === "1" &&
          /^-- deployment-mode: (?:rolling|maintenance)\r?\n-- opengeni:batched-backfill\b/u.test(
            raw,
          )
        ? runnerSetting.guc.slice("opengeni.".length)
        : undefined;
    // Owner-only posture window and tenant GUC state are per-file: the runner
    // executes one file as one implicit transaction.
    const unforced = new Set<string>();
    let tenantGuc = false;
    let statementNumber = 0;
    const statements = splitStatements(raw);
    const ownerWindows = catalogOwnerWindows(statements);

    for (const rawStatement of statements) {
      statementNumber += 1;
      if (
        REVIEWED_ROUTINE_SOURCE_PATCH_SHA256.has(
          createHash("sha256").update(rawStatement).digest("hex"),
        )
      )
        continue;
      const statement = stripComments(rawStatement);
      const commentFreeStatement = stripAllCommentText(rawStatement);
      const head = statement.trim().replace(/\s+/g, " ");

      const createdPolicy = ownerCapabilityPolicy(statement);
      if (createdPolicy) {
        const policyName =
          /^CREATE\s+POLICY\s+(?:"([^"]+)"|([a-z0-9_]+))/i.exec(head)?.slice(1).find(Boolean) ?? "";
        ownerCapabilityPolicies.set(policyName.toLowerCase(), createdPolicy);
      }
      const droppedPolicy =
        /^DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([a-z0-9_]+))\s+ON\b/i.exec(head);
      if (droppedPolicy) {
        ownerCapabilityPolicies.delete((droppedPolicy[1] ?? droppedPolicy[2]!).toLowerCase());
      }

      // A DDL statement that merely *defines* a routine whose body mentions
      // set_config must not latch this: the GUC is set when that routine is
      // called, not when it is created. Latching here silently suppressed
      // every later candidate in the file - and "CREATE FUNCTION ... then
      // backfill" is exactly the shape this repo's authority migrations take.
      if (
        !DDL_ONLY.test(head) &&
        /set_config\s*\(\s*'opengeni\.(account_id|workspace_id)'/i.test(statement) &&
        /set_config\s*\(\s*'opengeni\.(account_id|workspace_id)'/i.test(commentFreeStatement)
      ) {
        tenantGuc = true;
      }

      // ---- posture tracking -------------------------------------------------
      const dynamicPosture =
        /^DO\b/i.test(head) &&
        /EXECUTE\s+format\(\s*'ALTER TABLE %I (ENABLE|FORCE) ROW LEVEL SECURITY/i.test(statement);
      if (dynamicPosture) {
        const array = /FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]/i.exec(statement);
        for (const quoted of array?.[1]?.matchAll(/'([a-z0-9_]+)'/gi) ?? []) {
          if (/ENABLE ROW LEVEL SECURITY/i.test(statement)) enabled.add(quoted[1]!);
          if (/FORCE ROW LEVEL SECURITY/i.test(statement)) forced.add(quoted[1]!);
        }
        continue;
      }
      const posture =
        /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:[a-z0-9_]+\.)?"?([a-z0-9_]+)"?\s+(NO\s+FORCE|FORCE|ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/i.exec(
          head,
        );
      if (posture) {
        const table = posture[1]!;
        const operation = posture[2]!.toUpperCase().replace(/\s+/g, " ");
        if (operation === "FORCE") {
          forced.add(table);
          unforced.delete(table);
        } else if (operation === "NO FORCE") {
          forced.delete(table);
          unforced.add(table);
        } else if (operation === "ENABLE") {
          enabled.add(table);
        } else if (operation === "DISABLE") {
          enabled.delete(table);
          unforced.add(table);
        }
        continue;
      }
      const rename =
        /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?([a-z0-9_]+)"?\s+RENAME\s+TO\s+"?([a-z0-9_]+)"?/i.exec(
          head,
        );
      if (rename) {
        if (forced.delete(rename[1]!)) forced.add(rename[2]!);
        if (enabled.delete(rename[1]!)) enabled.add(rename[2]!);
        continue;
      }
      const dropped = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/i.exec(head);
      if (dropped) {
        forced.delete(dropped[1]!);
        enabled.delete(dropped[1]!);
        continue;
      }

      // ---- candidate statements --------------------------------------------
      if (DDL_ONLY.test(head) || NON_DML.test(head)) continue;
      const isBlock = /^DO\b/i.test(head);
      if (!isBlock && !/^(INSERT|UPDATE|DELETE|MERGE|WITH|SELECT|COPY|CALL)\b/i.test(head))
        continue;
      if (tenantGuc) continue;

      const executable = isBlock ? stripRoutineBodies(statement) : statement;
      const commentFreeExecutable = isBlock
        ? stripRoutineBodies(commentFreeStatement)
        : commentFreeStatement;
      const commentFreeOwnerVisible = activatedOwnerCapabilityTables(
        commentFreeExecutable,
        ownerCapabilityPolicies,
        runnerCapabilityGuc,
      );
      const ownerVisible = new Set(
        [
          ...activatedOwnerCapabilityTables(
            executable,
            ownerCapabilityPolicies,
            runnerCapabilityGuc,
          ),
        ].filter((table) => commentFreeOwnerVisible.has(table)),
      );
      const relaxesPosture = (table: string, text: string) =>
        new RegExp(
          String.raw`ALTER TABLE\s+${TABLE_REF(table)}\s+(NO FORCE|DISABLE) ROW LEVEL SECURITY`,
          "i",
        ).test(text);
      const opaque = [...forced].filter(
        (table) =>
          enabled.has(table) &&
          !unforced.has(table) &&
          !ownerWindows.get(statementNumber - 1)?.has(table) &&
          !ownerVisible.has(table) &&
          // A DO block that relaxes the posture itself is protected.
          !(relaxesPosture(table, executable) && relaxesPosture(table, commentFreeExecutable)),
      );

      const written = opaque.filter((table) => writesTable(executable, table)).sort();
      if (written.length > 0) {
        findings.push({
          file,
          statement: statementNumber,
          kind: "write",
          tables: written,
          snippet: head.slice(0, 160),
        });
        continue;
      }

      // A `DO $$ ... IF EXISTS (SELECT ... FROM <forced table>) ... RAISE
      // EXCEPTION` preflight sees zero rows for the same reason a backfill
      // writes zero rows, so it certifies success instead of guarding.
      if (!isBlock || !/RAISE\s+EXCEPTION/i.test(executable)) continue;
      const read = opaque.filter((table) => readsTable(executable, table)).sort();
      if (read.length === 0) continue;
      findings.push({
        file,
        statement: statementNumber,
        kind: "vacuous-guard",
        tables: read,
        snippet: head.slice(0, 160),
      });
    }
  }
  return findings;
}

/** Findings in migrations that are not grandfathered - i.e. real violations. */
export function unreviewedFindings(findings: readonly BackfillFinding[]): BackfillFinding[] {
  const allowedWrites = new Set(GRANDFATHERED_MIGRATIONS);
  const allowedGuards = new Set(GRANDFATHERED_VACUOUS_GUARDS);
  return findings.filter((finding) =>
    finding.kind === "write" ? !allowedWrites.has(finding.file) : !allowedGuards.has(finding.file),
  );
}

/** Grandfathered entries that no longer match any file (a stale allowlist). */
export function staleAllowlistEntries(migrationsDir: string): string[] {
  const files = new Set(readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")));
  return [...GRANDFATHERED_MIGRATIONS, ...GRANDFATHERED_VACUOUS_GUARDS].filter(
    (entry) => !files.has(entry),
  );
}
