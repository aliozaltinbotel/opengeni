import {
  GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE,
  ORGANIZATION_CREATE_GOVERNED,
  ORGANIZATION_GOVERNED_BY_HOST,
  REALTIME_MODEL_NOT_ALLOWED,
  type GovernedMutation,
  type GovernedMutationChannel,
  type OrganizationGovernancePort,
  type ReasoningDisclosure,
} from "@opengeni/contracts/organization-governance";
import {
  ensureGovernedOrganizationSessionPolicy,
  getManagedAccount,
  getOrganizationPrivacyPreferences,
  listSelfOrganizationMemberships,
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
 * Raised when a bound port breaks its contract, for example a `governs` that
 * returns a Promise: treating that as "not governed" would open the gate.
 */
export class OrganizationGovernancePortContractError extends Error {
  readonly name = "OrganizationGovernancePortContractError";
}

/**
 * Whether a bound port governs this organization. Without a port nothing is
 * read; a port that throws or answers anything but a boolean, and a failed
 * lookup, fail the caller (closed).
 */
export async function organizationGovernedByHost(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<boolean> {
  const port = deps.organizationGovernance;
  if (!port) return false;
  const externalSource = await organizationExternalSource(deps.db, organizationId);
  const governed: unknown = port.governs({ organizationId, externalSource });
  if (typeof governed !== "boolean")
    throw new OrganizationGovernancePortContractError(
      `OrganizationGovernancePort.governs must return a boolean, not ${describeValue(governed)}`,
    );
  return governed;
}

/**
 * Whether this organization's sessions show the provider's reasoning text.
 * `"withheld"` only when the bound port sets `reasoningDisclosure: "withheld"`
 * and governs the organization; without that field nothing is read. A port
 * that throws, and a failed lookup, fail the caller (closed).
 */
export async function organizationReasoningDisclosure(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<ReasoningDisclosure> {
  if (deps.organizationGovernance?.reasoningDisclosure !== "withheld") return "full";
  return (await organizationGovernedByHost(deps, organizationId)) ? "withheld" : "full";
}

/**
 * The event as a reader of a `"withheld"` organization receives it: an
 * `agent.reasoning.delta` keeps its envelope (id, sequence, turn, coverage)
 * and only the numeric `coalescedUntil` of its payload (the last sequence a
 * coalesced or folded run covers), so cursors and gap detection are unchanged
 * and no reasoning text is delivered. Every other event is returned as it is.
 */
export function withholdSessionEventReasoning<Event extends { type: string; payload: unknown }>(
  event: Event,
): Event {
  if (event.type !== "agent.reasoning.delta") return event;
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const until = payload.coalescedUntil;
  return {
    ...event,
    payload:
      typeof until === "number" && Number.isSafeInteger(until) ? { coalescedUntil: until } : {},
  };
}

/**
 * The realtime voice models this organization's sessions may use, or null for
 * no restriction (no `allowedRealtimeModels` on the port, or an organization
 * the host does not govern). A list that is not strings fails the caller
 * closed, as a port that throws does.
 */
export async function organizationAllowedRealtimeModels(
  deps: OrganizationGovernanceDeps,
  organizationId: string,
): Promise<ReadonlySet<string> | null> {
  const allowed: unknown = deps.organizationGovernance?.allowedRealtimeModels;
  if (allowed === undefined) return null;
  if (!Array.isArray(allowed) || allowed.some((model) => typeof model !== "string"))
    throw new OrganizationGovernancePortContractError(
      "OrganizationGovernancePort.allowedRealtimeModels must be a list of model ids",
    );
  if (!(await organizationGovernedByHost(deps, organizationId))) return null;
  return new Set(allowed as string[]);
}

/** Raised where a governed organization's host does not allow a realtime voice model. */
export class RealtimeModelNotAllowedError extends Error {
  readonly name = "RealtimeModelNotAllowedError";
  readonly code = REALTIME_MODEL_NOT_ALLOWED;
  constructor(readonly model: string) {
    super("This voice model is not available in this organization.");
  }
}

/** Refuses a realtime voice model outside the governing host's allowlist. */
export async function requireOrganizationRealtimeModelAllowed(
  deps: OrganizationGovernanceDeps,
  input: { organizationId: string; model: string },
): Promise<void> {
  const allowed = await organizationAllowedRealtimeModels(deps, input.organizationId);
  if (allowed && !allowed.has(input.model)) throw new RealtimeModelNotAllowedError(input.model);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Promise) return "a Promise";
  return typeof value;
}

/**
 * A governed organization's people have no Personal workspace to see or start
 * work in: the host decides where they work. This turns the organization's
 * Personal workspaces setting (0918) off, and stores the governed session
 * policy (no attachments, no generic tool families) unless one is stored, the
 * first time the fork sees the organization governed: at native creation and
 * before each host command, because a host usually provisions its
 * organizations out of band. Idempotent; an ungoverned organization, or no
 * bound port, is never touched.
 *
 * `actorSubjectId` must be an active owner or admin (the database refuses
 * anyone else): the creator, or the host command's service-token subject.
 */
export async function applyGovernedOrganizationPolicy(
  deps: OrganizationGovernanceDeps,
  input: { organizationId: string; actorSubjectId: string },
): Promise<void> {
  if (!(await organizationGovernedByHost(deps, input.organizationId))) return;
  // Its sessions get no attachments and no generic tool families until the
  // host sets a policy; stored, so the worker reads the same answer.
  await ensureGovernedOrganizationSessionPolicy(deps.db, input.organizationId);
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

/** Raised where a person of a governed organization may not create another organization. */
export class OrganizationCreateGovernedError extends Error {
  readonly name = "OrganizationCreateGovernedError";
  readonly code = ORGANIZATION_CREATE_GOVERNED;
  constructor() {
    super("Organizations for your account are created by the application that manages it.");
  }
}

/**
 * A person who belongs to a governed organization creates no organization of
 * their own unless that organization's host allows `organization.create`
 * (`via: "native"`): a new organization would be outside the host's
 * governance, with the person as its owner. Every membership but a revoked one
 * counts, and each governing host is asked; any refusal refuses. With
 * `organizationCreation: "host"` on the port, a person also needs at least one
 * governing host that allows it: someone who belongs to no governed
 * organization (a fresh sign-up included) is refused. Without a bound port
 * nothing is read.
 */
export async function requireOrganizationCreateAllowed(
  deps: OrganizationGovernanceDeps,
  subjectId: string,
): Promise<void> {
  const port = deps.organizationGovernance;
  if (!port) return;
  const memberships = await listSelfOrganizationMemberships(deps.db, subjectId);
  let allowedByHost = false;
  for (const membership of memberships) {
    if (membership.status === "revoked") continue;
    const decision = await organizationGovernanceDecision(deps, {
      organizationId: membership.organizationId,
      mutation: "organization.create",
      via: "native",
    });
    if (decision === "refuse") throw new OrganizationCreateGovernedError();
    if (decision === "allow") allowedByHost = true;
  }
  if (port.organizationCreation === "host" && !allowedByHost)
    throw new OrganizationCreateGovernedError();
}

export type GovernedSharedWorkspaceOperation = "invitation" | "removal" | "reactivation";

const GOVERNED_SHARED_WORKSPACE_MESSAGES: Record<GovernedSharedWorkspaceOperation, string> = {
  invitation: "Invite people to this organization with at least one shared workspace.",
  removal:
    "This is the member's last shared workspace. Offboard the member, or suspend them and reactivate with the shared workspaces to restore.",
  reactivation:
    "Reactivate members of this organization through the host command with the shared workspaces to grant (workspaceIds).",
};

/**
 * Raised when a governed organization would get a human member with no shared
 * workspace: their default would be the Personal workspace, which is off there.
 */
export class GovernedMemberRequiresSharedWorkspaceError extends Error {
  readonly name = "GovernedMemberRequiresSharedWorkspaceError";
  readonly code = GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE;
  constructor(readonly operation: GovernedSharedWorkspaceOperation) {
    super(GOVERNED_SHARED_WORKSPACE_MESSAGES[operation]);
  }
}

/** A governed organization's invitation names at least one shared workspace. */
export async function requireGovernedInvitationSharedWorkspace(
  deps: OrganizationGovernanceDeps,
  input: { organizationId: string; initialWorkspaceIds: readonly string[] },
): Promise<void> {
  if (input.initialWorkspaceIds.length > 0) return;
  if (await organizationGovernedByHost(deps, input.organizationId))
    throw new GovernedMemberRequiresSharedWorkspaceError("invitation");
}

/**
 * Reactivating a governed organization's member re-grants at least one shared
 * workspace: suspension removed every grant. A native reactivation, which
 * cannot carry grants, passes `undefined` and is refused there.
 */
export async function requireGovernedReactivationSharedWorkspace(
  deps: OrganizationGovernanceDeps,
  input: { organizationId: string; workspaceIds: readonly string[] | undefined },
): Promise<void> {
  if (input.workspaceIds !== undefined && input.workspaceIds.length > 0) return;
  if (await organizationGovernedByHost(deps, input.organizationId))
    throw new GovernedMemberRequiresSharedWorkspaceError("reactivation");
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
