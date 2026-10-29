import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database";
import { rawRows, setSubjectRlsContext, withRlsContext } from "./database";

/**
 * Migration 1017's host owner ensure (runtime EXECUTE granted by 1019;
 * readiness requires it).
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

/**
 * Identity-backed subjects, whose memberships come from invitations and
 * external identities. 1017's routine refuses them (42501), which would abort
 * bootstrapWorkspace's transaction, so they are skipped before it is called.
 */
const IDENTITY_SUBJECT_PREFIXES = ["user:", "external_user:"] as const;

const HostOrganizationOwnerRow = z
  .object({
    membershipId: z.string().uuid(),
    subjectId: z.string().min(1).max(1024),
    created: z.boolean(),
  })
  .strict();
export type HostOrganizationOwnerResult = z.infer<typeof HostOrganizationOwnerRow>;

type HostOwnerInput = { organizationId: string; subjectId: string };

/**
 * The host command's half: makes the subject the active owner of the
 * organization, as that subject in that organization, for a host command
 * already recorded under `operationId` (recordOrganizationHostCommandAttribution,
 * mutation `host_owner.ensure`, this subject). The routine refuses any other
 * subject or organization, a subject that owns none of the organization's
 * workspaces, and a missing attribution (all 42501), and a membership of the
 * subject that is not already an active owner (55000). Idempotent: `created`
 * is false when the owner membership already existed.
 */
export async function ensureOrganizationHostOwner(
  db: Database,
  input: HostOwnerInput & { operationId: string },
): Promise<HostOrganizationOwnerResult> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.subjectId);
      return await callOwnerRoutine(scopedDb, input, input.operationId);
    },
  );
}

/**
 * bootstrapWorkspace's half (with `governedOrganizationOwner`): inside its
 * transaction, once it has created the organization and the subject's
 * workspace grant. Without an operation id the routine writes an owner only
 * into an organization with no membership yet. The caller has set the
 * organization's account context; this sets the subject's only when it calls
 * the routine, so a skipped owner leaves the caller's transaction as it was.
 */
export async function ensureBootstrappedOrganizationOwner(
  tx: Database,
  input: HostOwnerInput & { accountExternalSource: string },
): Promise<void> {
  if (OWN_MEMBERSHIP_SOURCES.has(input.accountExternalSource)) return;
  if (IDENTITY_SUBJECT_PREFIXES.some((prefix) => input.subjectId.startsWith(prefix))) return;
  await setSubjectRlsContext(tx, input.subjectId);
  await callOwnerRoutine(tx, input, null);
}

async function callOwnerRoutine(
  db: Database,
  input: HostOwnerInput,
  operationId: string | null,
): Promise<HostOrganizationOwnerResult> {
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select opengeni_private.ensure_organization_host_owner(
      ${input.organizationId}::uuid, ${input.subjectId}, ${operationId}::uuid
    ) as result`,
  );
  return HostOrganizationOwnerRow.parse(row?.result);
}
