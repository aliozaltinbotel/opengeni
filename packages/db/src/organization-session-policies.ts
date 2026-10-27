import { sql } from "drizzle-orm";
import {
  OrganizationSessionPolicy,
  type OrganizationSessionPolicySource,
} from "@opengeni/contracts/organization-session-policy";
import type { Database } from "./database";
import { rawRows, withAccountRls } from "./database";

/** An organization's stored session policy (migration 1017). */
export type StoredOrganizationSessionPolicy = {
  organizationId: string;
  policy: OrganizationSessionPolicy;
  source: Exclude<OrganizationSessionPolicySource, "stock">;
  revision: number;
  lastOperationId: string | null;
  updatedAt: Date;
};

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

/** The organization's stored policy, or null (no restriction is stored). */
export async function getOrganizationSessionPolicy(
  db: Database,
  organizationId: string,
): Promise<StoredOrganizationSessionPolicy | null> {
  if (!UUID.test(organizationId)) return null;
  return await withAccountRls(db, organizationId, async (scopedDb) => {
    const [row] = await rawRows<PolicyRow>(
      scopedDb,
      sql`select ${SELECT_COLUMNS} from organization_session_policies
        where account_id = ${organizationId}::uuid`,
    );
    return row ? storedPolicy(row) : null;
  });
}

/**
 * Stores `policy` as the organization's governed default unless a policy is
 * already stored, and returns the stored one. Idempotent.
 */
export async function ensureGovernedOrganizationSessionPolicy(
  db: Database,
  organizationId: string,
  policy: OrganizationSessionPolicy,
): Promise<StoredOrganizationSessionPolicy> {
  return await withAccountRls(db, organizationId, async (scopedDb) => {
    await rawRows(
      scopedDb,
      sql`insert into organization_session_policies (
          account_id, attachments, tool_family_mode, tool_families, source
        ) values (
          ${organizationId}::uuid, ${policy.attachments}, ${policy.toolFamilies.mode},
          ${sql.raw(familiesArray(policy))}, 'governed_default'
        )
        on conflict (account_id) do nothing`,
    );
    const [row] = await rawRows<PolicyRow>(
      scopedDb,
      sql`select ${SELECT_COLUMNS} from organization_session_policies
        where account_id = ${organizationId}::uuid`,
    );
    if (!row) throw new Error("organization session policy was not stored");
    return storedPolicy(row);
  });
}

/**
 * The host's policy for the organization. A replay of the stored policy's
 * own operation id changes nothing and returns it as stored.
 */
export async function putHostOrganizationSessionPolicy(
  db: Database,
  input: {
    organizationId: string;
    policy: OrganizationSessionPolicy;
    operationId: string;
    actorSubjectId: string;
  },
): Promise<{ stored: StoredOrganizationSessionPolicy; replay: boolean }> {
  const policy = OrganizationSessionPolicy.parse(input.policy);
  return await withAccountRls(db, input.organizationId, async (scopedDb) => {
    const [written] = await rawRows<PolicyRow>(
      scopedDb,
      sql`insert into organization_session_policies (
          account_id, attachments, tool_family_mode, tool_families, source,
          last_operation_id, updated_by_subject_id
        ) values (
          ${input.organizationId}::uuid, ${policy.attachments}, ${policy.toolFamilies.mode},
          ${sql.raw(familiesArray(policy))}, 'host', ${input.operationId}::uuid,
          ${input.actorSubjectId}
        )
        on conflict (account_id) do update set
          attachments = excluded.attachments,
          tool_family_mode = excluded.tool_family_mode,
          tool_families = excluded.tool_families,
          source = 'host',
          last_operation_id = excluded.last_operation_id,
          updated_by_subject_id = excluded.updated_by_subject_id,
          revision = organization_session_policies.revision + 1,
          updated_at = clock_timestamp()
        where organization_session_policies.last_operation_id is distinct from
          excluded.last_operation_id
        returning ${SELECT_COLUMNS}`,
    );
    if (written) return { stored: storedPolicy(written), replay: false };
    const [current] = await rawRows<PolicyRow>(
      scopedDb,
      sql`select ${SELECT_COLUMNS} from organization_session_policies
        where account_id = ${input.organizationId}::uuid`,
    );
    if (!current) throw new Error("organization session policy was not stored");
    return { stored: storedPolicy(current), replay: true };
  });
}

/** A text[] literal from validated family names (closed enum, no quoting needed). */
function familiesArray(policy: OrganizationSessionPolicy): string {
  const families = OrganizationSessionPolicy.parse(policy).toolFamilies.families;
  return `ARRAY[${families.map((family) => `'${family}'`).join(", ")}]::text[]`;
}
