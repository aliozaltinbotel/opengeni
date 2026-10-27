import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  OrganizationSessionPolicy,
  organizationSessionPolicyDigestInput,
  type OrganizationSessionPolicySource,
} from "@opengeni/contracts/organization-session-policy";
import type { Database } from "./database";
import { rawRows, setSubjectRlsContext, withAccountRls, withRlsContext } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

/** An organization's stored session policy (migration 1018). */
export type StoredOrganizationSessionPolicy = {
  organizationId: string;
  policy: OrganizationSessionPolicy;
  source: Exclude<OrganizationSessionPolicySource, "stock">;
  revision: number;
  lastOperationId: string | null;
  updatedAt: Date;
};

/**
 * Migration 1018's host write. Its runtime EXECUTE is withheld for one release
 * (runtime-posture DEFERRED_RUNTIME_PRIVATE_ROUTINES); until it is granted, a
 * host cannot replace the governed default.
 */
export const HOST_SESSION_POLICY_ROUTINE =
  "opengeni_private.put_host_organization_session_policy(uuid, text, uuid, text, text, text[], text, bigint)";

type PolicyRow = {
  account_id: string;
  attachments: string;
  tool_family_mode: string;
  tool_families: string[];
  source: string;
  revision: string | number;
  last_operation_id: string | null;
  updated_at: Date | string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function storedPolicy(row: PolicyRow): StoredOrganizationSessionPolicy {
  return {
    organizationId: row.account_id,
    // The table's checks admit only valid values; parsing keeps a corrupt row
    // from silently widening anything.
    policy: OrganizationSessionPolicy.parse({
      attachments: row.attachments,
      toolFamilies: { mode: row.tool_family_mode, families: row.tool_families },
    }),
    source: row.source === "host" ? "host" : "governed_default",
    revision: Number(row.revision),
    lastOperationId: row.last_operation_id,
    updatedAt: new Date(row.updated_at),
  };
}

const SELECT_COLUMNS = sql`account_id, attachments, tool_family_mode, tool_families, source,
  revision, last_operation_id, updated_at`;

async function readPolicyInScope(
  scopedDb: Database,
  organizationId: string,
): Promise<StoredOrganizationSessionPolicy | null> {
  const [row] = await rawRows<PolicyRow>(
    scopedDb,
    sql`select ${SELECT_COLUMNS} from organization_session_policies
      where account_id = ${organizationId}::uuid`,
  );
  return row ? storedPolicy(row) : null;
}

/** The organization's stored policy, or null (no restriction is stored). */
export async function getOrganizationSessionPolicy(
  db: Database,
  organizationId: string,
): Promise<StoredOrganizationSessionPolicy | null> {
  if (!UUID.test(organizationId)) return null;
  return await withAccountRls(db, organizationId, (scopedDb) =>
    readPolicyInScope(scopedDb, organizationId),
  );
}

/**
 * Inside a caller's transaction whose account context is the organization:
 * stores the governed default unless a policy is stored. The table's INSERT
 * policy admits nothing but the governed default, so this can only narrow.
 */
export async function ensureGovernedOrganizationSessionPolicyInScope(
  scopedDb: Database,
  organizationId: string,
): Promise<void> {
  await rawRows(
    scopedDb,
    sql`insert into organization_session_policies (
        account_id, attachments, tool_family_mode, tool_families, source
      ) values (
        ${organizationId}::uuid, 'disabled', 'deny',
        ARRAY['shell', 'codemode', 'browser', 'computerUse']::text[], 'governed_default'
      )
      on conflict (account_id) do nothing`,
  );
}

/**
 * Stores the governed default (no attachments, every generic family denied)
 * unless a policy is already stored, and returns the stored one. Idempotent.
 */
export async function ensureGovernedOrganizationSessionPolicy(
  db: Database,
  organizationId: string,
): Promise<StoredOrganizationSessionPolicy> {
  return await withAccountRls(db, organizationId, async (scopedDb) => {
    await ensureGovernedOrganizationSessionPolicyInScope(scopedDb, organizationId);
    const stored = await readPolicyInScope(scopedDb, organizationId);
    if (!stored) throw new Error("organization session policy was not stored");
    return stored;
  });
}

/**
 * Stores the governed default unless a policy is stored, in one statement:
 * true when this call stored it, false when a policy was already there.
 */
export async function storeGovernedOrganizationSessionPolicyIfMissing(
  db: Database,
  organizationId: string,
): Promise<boolean> {
  return await withAccountRls(db, organizationId, async (scopedDb) => {
    const inserted = await rawRows<{ account_id: string }>(
      scopedDb,
      sql`insert into organization_session_policies (
          account_id, attachments, tool_family_mode, tool_families, source
        ) values (
          ${organizationId}::uuid, 'disabled', 'deny',
          ARRAY['shell', 'codemode', 'browser', 'computerUse']::text[], 'governed_default'
        )
        on conflict (account_id) do nothing
        returning account_id`,
    );
    return inserted.length > 0;
  });
}

/**
 * One page of organizations that carry an external identity source, in id
 * order (managed_accounts is a deployment-wide runtime table). For a pass
 * that asks a host port which of them it governs.
 */
export async function listManagedAccountExternalSources(
  db: Database,
  input: { after: string | null; limit: number },
): Promise<{ id: string; externalSource: string }[]> {
  const rows = await rawRows<{ id: string; external_source: string }>(
    db,
    sql`select id, external_source from managed_accounts
      where external_source is not null
        and (${input.after}::uuid is null or id > ${input.after}::uuid)
      order by id
      limit ${input.limit}`,
  );
  return rows.map((row) => ({ id: row.id, externalSource: row.external_source }));
}

/** Whether 1018's routine exists and the runtime may call it. */
export async function hostSessionPolicyWriteGranted(
  db: Pick<Database, "execute">,
): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select has_function_privilege(
      to_regprocedure(${HOST_SESSION_POLICY_ROUTINE})::oid, 'EXECUTE'
    ) as granted`,
  );
  return row?.granted === true;
}

/** This operation id already wrote a policy with another body. */
export class SessionPolicyOperationConflictError extends Error {
  readonly name = "SessionPolicyOperationConflictError";
}

/** The command's expected revision is not the stored one. */
export class SessionPolicyRevisionConflictError extends Error {
  readonly name = "SessionPolicyRevisionConflictError";
}

/** The digest the routine keeps per operation id. */
export function organizationSessionPolicyDigest(policy: OrganizationSessionPolicy): string {
  return createHash("sha256")
    .update(organizationSessionPolicyDigestInput(OrganizationSessionPolicy.parse(policy)))
    .digest("hex");
}

/**
 * The host's policy, as the host command's service subject in its
 * organization, for a command already recorded under `operationId`
 * (recordOrganizationHostCommandAttribution, mutation `session_policy.update`,
 * this subject). A replay of the same operation and body changes nothing; the
 * same operation with another body, and a stale `expectedRevision`, are
 * refused. Null while 1018's routine is not granted ("not yet").
 */
export async function putHostOrganizationSessionPolicy(
  db: Database,
  input: {
    organizationId: string;
    subjectId: string;
    operationId: string;
    policy: OrganizationSessionPolicy;
    expectedRevision: number;
  },
): Promise<{ stored: StoredOrganizationSessionPolicy; replay: boolean } | null> {
  const policy = OrganizationSessionPolicy.parse(input.policy);
  const digest = organizationSessionPolicyDigest(policy);
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      if (!(await hostSessionPolicyWriteGranted(scopedDb))) return null;
      await setSubjectRlsContext(scopedDb, input.subjectId);
      let replay: boolean;
      try {
        const [row] = await rawRows<{ result: { replay: boolean; revision: number } }>(
          scopedDb,
          sql`select opengeni_private.put_host_organization_session_policy(
              ${input.organizationId}::uuid, ${input.subjectId}, ${input.operationId}::uuid,
              ${policy.attachments}, ${policy.toolFamilies.mode},
              ${sql.raw(familiesArray(policy))}, ${digest}, ${input.expectedRevision}::bigint
            ) as result`,
        );
        replay = row?.result.replay === true;
      } catch (error) {
        const state = nestedPostgresSqlState(error);
        if (state === "OGSP1")
          throw new SessionPolicyOperationConflictError(
            "This operation id already set a different session policy.",
            { cause: error },
          );
        if (state === "OGSP2")
          throw new SessionPolicyRevisionConflictError(
            "The session policy changed since the expected revision.",
            { cause: error },
          );
        throw error;
      }
      const stored = await readPolicyInScope(scopedDb, input.organizationId);
      if (!stored) throw new Error("organization session policy was not stored");
      return { stored, replay };
    },
  );
}

/** A text[] literal from validated family names (closed enum, no quoting needed). */
function familiesArray(policy: OrganizationSessionPolicy): string {
  const families = OrganizationSessionPolicy.parse(policy).toolFamilies.families;
  return `ARRAY[${families.map((family) => `'${family}'`).join(", ")}]::text[]`;
}
