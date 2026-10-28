import {
  ATTACHMENTS_DISABLED,
  GOVERNED_ORGANIZATION_SESSION_POLICY,
  SESSION_RECORDINGS_DENIED,
  SESSION_TOOL_FAMILY_DENIED,
  STOCK_ORGANIZATION_SESSION_POLICY,
  sessionRecordingsAllowed,
  sessionToolFamilyGate,
  type OrganizationSessionPolicyView,
  type SessionToolFamily,
  type SessionToolFamilyGate,
} from "@opengeni/contracts/organization-session-policy";
import {
  ensureGovernedOrganizationSessionPolicy,
  getOrganizationSessionPolicy,
  listManagedAccountExternalSources,
  storeGovernedOrganizationSessionPolicyIfMissing,
  type Database,
  type StoredOrganizationSessionPolicy,
} from "@opengeni/db";
import {
  OrganizationGovernancePortContractError,
  organizationGovernedByHost,
  type OrganizationGovernanceDeps,
} from "./organization-governance";

/*
 * One session policy per organization (attachments and generic tool families).
 *
 * The policy is durable state because both processes enforce it: the API at
 * upload, message admission and call admission, the worker when it assembles
 * every turn's tool catalog. The worker has no governance port, so the API
 * stores the governed default at every governed entry point that can start
 * work (and bootstrapWorkspace can store it at creation); from then on both
 * read the same row.
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
  return await ensureGovernedOrganizationSessionPolicy(deps.db, organizationId);
}

/**
 * Called at every governed entry point that can start work (session create,
 * message admission, schedule and automation create or update), before that
 * work is stored: a governed organization never reaches the worker without its
 * policy row, whose absence the worker reads as stock. Without a port nothing
 * is read.
 */
export async function ensureOrganizationSessionPolicyAtEntry(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  await resolveOrganizationSessionPolicy(deps, organizationId);
}

/** What the startup pass did for one organization the port was asked about. */
export type GovernedSessionPolicyDefaultOutcome = {
  organizationId: string;
  /** stored: the default was written now; present: a policy was already stored. */
  outcome: "stored" | "present" | "failed";
  error?: unknown;
};

export type GovernedSessionPolicyDefaultsResult = {
  governed: number;
  stored: number;
  failed: number;
};

/** Governed organizations of one page handled at a time. */
const DEFAULTS_CONCURRENCY = 4;

/**
 * Stores the governed default for every organization the bound port governs
 * that has no policy yet: organizations governed before migration 1018, whose
 * stored schedules and triggers the worker (which has no port) would
 * otherwise run as stock. Run when the API starts. Idempotent; pages through
 * the organizations that carry an external source (one read per page) and
 * stores each governed one's default with one statement. Each organization
 * is isolated: a port answer or database write that fails for one is
 * reported (`onOrganization`, outcome `failed`) and counted, and the pass
 * continues. Ungoverned organizations are not reported. Without a port,
 * nothing.
 */
export async function storeGovernedOrganizationSessionPolicyDefaults(
  deps: OrganizationGovernanceDeps,
  options: {
    pageSize?: number;
    onOrganization?: (outcome: GovernedSessionPolicyDefaultOutcome) => void;
  } = {},
): Promise<GovernedSessionPolicyDefaultsResult> {
  const result: GovernedSessionPolicyDefaultsResult = { governed: 0, stored: 0, failed: 0 };
  const port = deps.organizationGovernance;
  if (!port) return result;
  const pageSize = options.pageSize ?? 500;
  const report = (outcome: GovernedSessionPolicyDefaultOutcome): void => {
    if (outcome.outcome === "failed") result.failed += 1;
    else result.governed += 1;
    if (outcome.outcome === "stored") result.stored += 1;
    try {
      options.onOrganization?.(outcome);
    } catch {
      // A reporting failure never stops the pass.
    }
  };
  const storeOne = async (account: { id: string; externalSource: string }): Promise<void> => {
    try {
      const answer: unknown = port.governs({
        organizationId: account.id,
        externalSource: account.externalSource,
      });
      if (typeof answer !== "boolean")
        throw new OrganizationGovernancePortContractError(
          "OrganizationGovernancePort.governs must return a boolean",
        );
      if (!answer) return;
      const stored = await storeGovernedOrganizationSessionPolicyIfMissing(deps.db, account.id);
      report({ organizationId: account.id, outcome: stored ? "stored" : "present" });
    } catch (error) {
      report({ organizationId: account.id, outcome: "failed", error });
    }
  };
  let after: string | null = null;
  for (;;) {
    const page = await listManagedAccountExternalSources(deps.db, { after, limit: pageSize });
    for (let index = 0; index < page.length; index += DEFAULTS_CONCURRENCY)
      await Promise.all(page.slice(index, index + DEFAULTS_CONCURRENCY).map(storeOne));
    if (page.length < pageSize) return result;
    after = page.at(-1)!.id;
  }
}

/**
 * A read with no side effect (the host's GET): what is stored, else the
 * governed default a governed organization would get (unstored, revision 0),
 * else stock.
 */
export async function readOrganizationSessionPolicy(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<OrganizationSessionPolicyView> {
  if (!deps.organizationGovernance) return view(organizationId, null);
  const stored = await getOrganizationSessionPolicy(deps.db, organizationId);
  if (stored) return view(organizationId, stored);
  if (!(await organizationGovernedByHost(deps, organizationId))) return view(organizationId, null);
  return {
    organizationId,
    policy: GOVERNED_ORGANIZATION_SESSION_POLICY,
    source: "governed_default",
    revision: 0,
    updatedAt: null,
  };
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

/** Raised where an organization's session policy turns recordings and transcription off. */
export class SessionRecordingsDeniedError extends Error {
  readonly name = "SessionRecordingsDeniedError";
  readonly code = SESSION_RECORDINGS_DENIED;
  constructor() {
    super("Recording and transcription are turned off for this organization's sessions.");
  }
}

/**
 * Refuses a recording, its audio uploads and transcription when the
 * organization's policy denies recordings (the default for a governed
 * organization), then when it turns attachments off: recorded audio reaches
 * the model as text, like an attachment. Without a port nothing is read.
 */
export async function requireOrganizationRecordingsAllowed(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  const resolved = await resolveOrganizationSessionPolicy(deps, organizationId);
  if (!sessionRecordingsAllowed(resolved)) throw new SessionRecordingsDeniedError();
  if (resolved.policy.attachments !== "enabled") throw new AttachmentsDisabledError();
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
