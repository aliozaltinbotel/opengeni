// The personal-workspace pointer, in its own leaf module.
//
// Both the Slack routing resolvers and the Slack access-request path need it,
// and this keeps that from becoming an import cycle between them.
import { SessionScopeSubjectId } from "@opengeni/contracts";
import { sql } from "drizzle-orm";

import { type Database, withRlsContext } from "./database";
import { listSelfOrganizationMemberships } from "./organization-membership-lifecycle";
import { rlsSubjectIdOrEmpty } from "./workspace-authority";

/**
 * The subject's own personal workspace in one organization, or null.
 *
 * Only an `active` membership counts, and only that membership's own
 * `personalWorkspaceId` pointer is read - never a default workspace, a
 * `created_by`, or current access.
 *
 * Only canonical human subjects (`user:` and `external_user:`) can own an
 * organization membership. API keys, service and configured principals
 * short-circuit rather than tripping `list_self_organization_memberships`'
 * `42501` guard.
 *
 * ORACLE, NOT AN AUTHORIZATION. This answers "which workspace is this named
 * subject's own" for whatever subject it is handed; it does not establish that
 * the caller IS that subject. Pass only a subject authenticated out of band -
 * for Slack, one named by a durable `slack_bot_user_links` row. Never pass a
 * subject taken from a request payload.
 */
export async function namedSubjectPersonalWorkspaceId(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<string | null> {
  if (!SessionScopeSubjectId.safeParse(input.subjectId).success) return null;
  return await activeMembershipPersonalWorkspaceId(db, input);
}

/**
 * The same pointer for an external user of the organization (an
 * `external_user:` subject, such as a person in an embedded chat): their own
 * workspace, named by their active organization membership. Null for every
 * other subject. The same oracle caveat applies: it does not establish that
 * the caller is that person.
 */
export async function externalPersonPersonalWorkspaceId(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<string | null> {
  if (!input.subjectId.startsWith("external_user:")) return null;
  return await activeMembershipPersonalWorkspaceId(db, input);
}

async function activeMembershipPersonalWorkspaceId(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<string | null> {
  // `listSelfOrganizationMemberships` opens its own scope and sets
  // `opengeni.subject_id` to the probed subject. Under drizzle a nested
  // transaction is a SAVEPOINT, and releasing a savepoint does NOT undo a
  // transaction-local `set_config`, so without this the probed subject would
  // leak out and silently re-scope the rest of a caller-owned transaction.
  // `namedSubjectHasLiveWorkspaceAuthority` guards the same hazard the same
  // way; empty string is the canonical "unset" because `current_subject_id()`
  // is `nullif(current_setting(...), '')`.
  // External owning subjects are account-bound by the native SQL guard. Do not
  // rely on a caller having left an account scope on a pooled database handle.
  return withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (scopedDb) => {
    const priorSubjectId = await rlsSubjectIdOrEmpty(scopedDb);
    let completed = false;
    try {
      const memberships = await listSelfOrganizationMemberships(scopedDb, input.subjectId);
      const membership = memberships.find(
        (candidate) =>
          candidate.status === "active" &&
          candidate.organizationId === input.accountId &&
          candidate.personalWorkspaceId !== null,
      );
      completed = true;
      return membership?.personalWorkspaceId ?? null;
    } finally {
      const restore = scopedDb.execute(
        sql`select set_config('opengeni.subject_id', ${priorSubjectId}, true)`,
      );
      if (completed) {
        await restore;
      } else {
        // A failed statement can leave a caller-owned transaction aborted.
        // Preserve the original diagnostic rather than replacing it with the
        // restore's `25P02`.
        await restore.catch(() => undefined);
      }
    }
  });
}
