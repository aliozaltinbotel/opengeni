import {
  ATTACHMENTS_DISABLED,
  GOVERNED_ORGANIZATION_SESSION_POLICY,
  SESSION_TOOL_FAMILY_DENIED,
  STOCK_ORGANIZATION_SESSION_POLICY,
  sessionToolFamilyGate,
  type OrganizationSessionPolicyView,
  type SessionToolFamily,
  type SessionToolFamilyGate,
} from "@opengeni/contracts/organization-session-policy";
import {
  ensureGovernedOrganizationSessionPolicy,
  getOrganizationSessionPolicy,
  type Database,
  type StoredOrganizationSessionPolicy,
} from "@opengeni/db";
import {
  organizationGovernedByHost,
  type OrganizationGovernanceDeps,
} from "./organization-governance";

/*
 * One session policy per organization (attachments and generic tool families).
 *
 * The policy is durable state because both processes enforce it: the API at
 * upload, message admission and call admission, the worker when it assembles
 * every turn's tool catalog. The worker has no governance port, so the
 * governed default is stored the first time the API sees an organization
 * governed; from then on both read the same row.
 *
 * - API (`resolveOrganizationSessionPolicy`): without a bound port nothing is
 *   read and the policy is stock. With one, a stored policy wins; a governed
 *   organization without one gets the governed default stored.
 * - Worker (`storedOrganizationSessionPolicyOrStock`): a stored policy, else
 *   stock.
 */

function view(
  organizationId: string,
  stored: StoredOrganizationSessionPolicy | null,
): OrganizationSessionPolicyView {
  return stored
    ? {
        organizationId,
        policy: stored.policy,
        source: stored.source,
        revision: stored.revision,
        updatedAt: stored.updatedAt.toISOString(),
      }
    : {
        organizationId,
        policy: STOCK_ORGANIZATION_SESSION_POLICY,
        source: "stock",
        revision: 0,
        updatedAt: null,
      };
}

/** Stores the governed default for a governed organization that has no policy yet. */
export async function ensureGovernedOrganizationSessionPolicyStored(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<StoredOrganizationSessionPolicy | null> {
  if (!(await organizationGovernedByHost(deps, organizationId))) return null;
  return await ensureGovernedOrganizationSessionPolicy(
    deps.db,
    organizationId,
    GOVERNED_ORGANIZATION_SESSION_POLICY,
  );
}

/** The API's answer for one organization. A failed read or port fails the caller (closed). */
export async function resolveOrganizationSessionPolicy(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<OrganizationSessionPolicyView> {
  if (!deps.organizationGovernance) return view(organizationId, null);
  const stored = await getOrganizationSessionPolicy(deps.db, organizationId);
  if (stored) return view(organizationId, stored);
  return view(
    organizationId,
    await ensureGovernedOrganizationSessionPolicyStored(deps, organizationId),
  );
}

/** The worker's answer: what is stored, else stock. */
export async function storedOrganizationSessionPolicyOrStock(
  db: Database,
  organizationId: string,
): Promise<OrganizationSessionPolicyView> {
  return view(organizationId, await getOrganizationSessionPolicy(db, organizationId));
}

export async function organizationSessionToolFamilyGate(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<SessionToolFamilyGate> {
  return sessionToolFamilyGate(
    (await resolveOrganizationSessionPolicy(deps, organizationId)).policy,
  );
}

/** Raised where an organization's session policy refuses file attachments. */
export class AttachmentsDisabledError extends Error {
  readonly name = "AttachmentsDisabledError";
  readonly code = ATTACHMENTS_DISABLED;
  constructor() {
    super("File attachments are turned off for this organization's sessions.");
  }
}

/** Raised where an organization's session policy removes a tool family. */
export class SessionToolFamilyDeniedError extends Error {
  readonly name = "SessionToolFamilyDeniedError";
  readonly code = SESSION_TOOL_FAMILY_DENIED;
  constructor(readonly family: SessionToolFamily) {
    super("This tool is not available in this organization's sessions.");
  }
}

/** Refuses people's uploads and file attachments when the organization's policy turns them off. */
export async function requireOrganizationAttachmentsAllowed(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  const { policy } = await resolveOrganizationSessionPolicy(deps, organizationId);
  if (policy.attachments !== "enabled") throw new AttachmentsDisabledError();
}

/** Refuses a tool family the organization's policy removes. */
export async function requireOrganizationSessionToolFamily(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
  family: SessionToolFamily,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  if ((await organizationSessionToolFamilyGate(deps, organizationId)).denies(family))
    throw new SessionToolFamilyDeniedError(family);
}
