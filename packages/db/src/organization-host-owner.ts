import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database";
import { rawRows, setSubjectRlsContext, withRlsContext } from "./database";

/**
 * Migration 1017's host owner ensure. Its runtime EXECUTE is withheld for one
 * release (runtime-posture DEFERRED_RUNTIME_PRIVATE_ROUTINES); until it is
 * granted, nothing can make a host's subject an organization owner.
 */
export const HOST_ORGANIZATION_OWNER_ROUTINE =
  "opengeni_private.ensure_organization_host_owner(uuid, text, uuid)";

/**
 * Account sources whose organizations already have their own membership
 * story: the single local and configured accounts, and a managed human's own
 * organization. bootstrapWorkspace never adds a host owner to them.
 */
const OWN_MEMBERSHIP_SOURCES: ReadonlySet<string> = new Set([
  "opengeni:local",
  "opengeni:configured",
  "better-auth:user",
]);

const HostOrganizationOwnerRow = z
  .object({
    membershipId: z.string().uuid(),
    subjectId: z.string().min(1).max(1024),
    created: z.boolean(),
  })
  .strict();
export type HostOrganizationOwnerResult = z.infer<typeof HostOrganizationOwnerRow>;

type HostOwnerInput = { organizationId: string; subjectId: string };

/** Whether 1017's routine exists and the runtime may call it. */
export async function hostOrganizationOwnerGranted(
  db: Pick<Database, "execute">,
): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select has_function_privilege(
      to_regprocedure(${HOST_ORGANIZATION_OWNER_ROUTINE})::oid, 'EXECUTE'
    ) as granted`,
  );
  return row?.granted === true;
}

/**
 * The host command's half: makes the subject the active owner of the
 * organization, as that subject in that organization, for a host command
 * already recorded under `operationId` (recordOrganizationHostCommandAttribution,
 * mutation `host_owner.ensure`, this subject). The routine refuses any other
 * subject or organization, a subject that owns none of the organization's
 * workspaces, and a missing attribution (all 42501), and a membership of the
 * subject that is not already an active owner (55000). Idempotent: `created`
 * is false when the owner membership already existed. Null while the routine
 * is not granted ("not yet").
 */
export async function ensureOrganizationHostOwner(
  db: Database,
  input: HostOwnerInput & { operationId: string },
): Promise<HostOrganizationOwnerResult | null> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.subjectId);
      return await ensureOwnerInScope(scopedDb, input, input.operationId);
    },
  );
}

/**
 * bootstrapWorkspace's half: inside its transaction, once it has created the
 * organization and the subject's workspace grant. Without an operation id the
 * routine writes an owner only into an organization with no membership yet.
 * The caller has set the organization's account context; this sets the
 * subject's.
 */
export async function ensureBootstrappedOrganizationOwner(
  tx: Database,
  input: HostOwnerInput & { accountExternalSource: string },
): Promise<void> {
  if (OWN_MEMBERSHIP_SOURCES.has(input.accountExternalSource)) return;
  await setSubjectRlsContext(tx, input.subjectId);
  await ensureOwnerInScope(tx, input, null);
}

async function ensureOwnerInScope(
  db: Database,
  input: HostOwnerInput,
  operationId: string | null,
): Promise<HostOrganizationOwnerResult | null> {
  // Checked first: a permission error would abort the caller's transaction.
  if (!(await hostOrganizationOwnerGranted(db))) return null;
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select opengeni_private.ensure_organization_host_owner(
      ${input.organizationId}::uuid, ${input.subjectId}, ${operationId}::uuid
    ) as result`,
  );
  return HostOrganizationOwnerRow.parse(row?.result);
}
