import {
  ORGANIZATION_GOVERNED_BY_HOST,
  type GovernedMutation,
  type GovernedMutationChannel,
  type OrganizationGovernancePort,
} from "@opengeni/contracts/organization-governance";
import {
  getManagedAccount,
  getOrganizationPrivacyPreferences,
  updateOrganizationPrivacyPreferences,
  withAccountRls,
  type Database,
} from "@opengeni/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type OrganizationGovernanceDeps = {
  db: Database;
  organizationGovernance?: OrganizationGovernancePort | null;
};

export type OrganizationGovernanceDecision = "ungoverned" | "allow" | "refuse";

/**
 * The host's decision for one mutation in one organization. Without a bound
 * port every organization is ungoverned and nothing is read. A port that
 * throws, and a failed organization lookup, fail the caller (closed).
 */
export async function organizationGovernanceDecision(
  deps: OrganizationGovernanceDeps,
  input: { organizationId: string; mutation: GovernedMutation; via: GovernedMutationChannel },
): Promise<OrganizationGovernanceDecision> {
  const port = deps.organizationGovernance;
  if (!port || !(await organizationGovernedByHost(deps, input.organizationId))) return "ungoverned";
  return port.decide(input) === "allow" ? "allow" : "refuse";
}

/**
 * Whether a bound port governs this organization. Without a port nothing is
 * read; a port that throws, and a failed lookup, fail the caller (closed).
 */
export async function organizationGovernedByHost(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<boolean> {
  const port = deps.organizationGovernance;
  if (!port) return false;
  const externalSource = await organizationExternalSource(deps.db, organizationId);
  return port.governs({ organizationId, externalSource }) === true;
}

/**
 * A governed organization's people have no Personal workspace to see or start
 * work in: the host decides where they work. This turns the organization's
 * Personal workspaces setting (0918) off the first time the fork sees the
 * organization governed: at native creation and before each host command,
 * because a host usually provisions its organizations out of band. Idempotent;
 * an ungoverned organization, or no bound port, is never touched.
 *
 * `actorSubjectId` must be an active owner or admin (the database refuses
 * anyone else): the creator, or the host command's service-token subject.
 */
export async function applyGovernedOrganizationPolicy(
  deps: OrganizationGovernanceDeps,
  input: { organizationId: string; actorSubjectId: string },
): Promise<void> {
  if (!(await organizationGovernedByHost(deps, input.organizationId))) return;
  const preferences = await getOrganizationPrivacyPreferences(deps.db, input.organizationId);
  if (!preferences.personalWorkspacesEnabled) return;
  await updateOrganizationPrivacyPreferences(deps.db, {
    organizationId: input.organizationId,
    actorSubjectId: input.actorSubjectId,
    personalWorkspacesEnabled: false,
  });
}

/** Raised when a governed organization's owner tries to turn Personal workspaces back on. */
export class PersonalWorkspacesGovernedByHostError extends Error {
  readonly name = "PersonalWorkspacesGovernedByHostError";
  readonly code = ORGANIZATION_GOVERNED_BY_HOST;
  constructor() {
    super("Personal workspaces stay off in an organization its host application manages.");
  }
}

/** Refuses turning Personal workspaces on in a governed organization. Off is always accepted. */
export async function requirePersonalWorkspacesSettingAllowed(
  deps: OrganizationGovernanceDeps,
  input: { organizationId: string; personalWorkspaces: boolean | undefined },
): Promise<void> {
  if (input.personalWorkspaces !== true) return;
  if (await organizationGovernedByHost(deps, input.organizationId))
    throw new PersonalWorkspacesGovernedByHostError();
}

/** Raised where a governed organization's host refuses a mutation. */
export class OrganizationGovernedByHostError extends Error {
  readonly name = "OrganizationGovernedByHostError";
  readonly code = ORGANIZATION_GOVERNED_BY_HOST;
  constructor(readonly mutation: GovernedMutation) {
    super("This organization's members and credentials are managed by its host application.");
  }
}

/** Refuses `mutation` through `via: "native"` when a governing host refuses it. */
export async function requireNativeOrganizationMutationAllowed(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
  mutation: GovernedMutation,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  const decision = await organizationGovernanceDecision(deps, {
    organizationId,
    mutation,
    via: "native",
  });
  if (decision === "refuse") throw new OrganizationGovernedByHostError(mutation);
}

async function organizationExternalSource(
  db: Database,
  organizationId: string,
): Promise<string | null> {
  if (!UUID.test(organizationId)) return null;
  const account = await withAccountRls(db, organizationId, (scopedDb) =>
    getManagedAccount(scopedDb, organizationId),
  );
  return account?.externalSource ?? null;
}
