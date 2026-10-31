import { z } from "zod";
import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { Permission } from "./permissions";
import { ToolGatewayIdentity } from "./tool-catalog";
import { CanonicalHumanIdentityStatus } from "./canonical-human-identities";
import {
  OrganizationAccessPolicy,
  OrganizationAccessPreset,
  OrganizationWorkspaceScope,
} from "./organization-access";
import {
  CreateOrganizationInvitationRequest,
  OrganizationInvitationStatus,
  OrganizationMember,
  OrganizationMembershipRole,
  PutOrganizationWorkspaceMemberRequest,
  WorkspaceMemberRole,
  RevokeOrganizationInvitationRequest,
  RevokeOrganizationWorkspaceMemberRequest,
} from "./organization-membership-lifecycle";

/**
 * Every native route that changes who belongs to an organization, what they may
 * do there, or which credentials act in it (including connected MCP agents),
 * the organization recovery operations that hand ownership to a member, and
 * workspace deletion, which removes every grant in that workspace, and the
 * organization's session policy (attachments and generic tool families), which
 * only a host command changes. An embedding host that governs an organization
 * decides each one (`OrganizationGovernancePort.decide`). The list may grow in
 * later releases.
 */
export const GOVERNED_MUTATIONS = [
  "invitation.create",
  "invitation.revoke",
  "invitation.delivery.retry",
  "membership.role.change",
  "membership.suspend",
  "membership.reactivate",
  "membership.offboard",
  "workspace_member.add",
  "workspace_member.update",
  "workspace_member.remove",
  "external_member.add",
  "external_member.update",
  "api_key.create",
  "api_key.update",
  "api_key.revoke",
  "personal_api_key.create",
  "personal_api_key.revoke",
  "service_account.create",
  "service_account.update",
  "service_account.delete",
  "mcp_connection.create",
  "mcp_connection.update",
  "mcp_connection.revoke",
  "organization_recovery.start",
  "organization_recovery.approve",
  "organization_recovery.cancel",
  "organization_recovery.execute",
  "workspace.delete",
  // Host command only: no native route writes an organization's session policy.
  "session_policy.update",
  // A person creating another organization (`POST /v1/organizations` and
  // `/v1/organizations/additional`) while they belong to this governed one.
  "organization.create",
] as const;
export type GovernedMutation = (typeof GOVERNED_MUTATIONS)[number];

/** `native`: an Opengeni route (browser, agent, API key). `host`: a host command. */
export type GovernedMutationChannel = "native" | "host";

/**
 * Host-owned membership governance. Unset, every organization behaves as
 * standalone Opengeni. Bound, an organization the host governs accepts each
 * listed mutation only when the host allows it for that channel; a host
 * typically refuses every native mutation and allows its own commands.
 *
 * A governed organization has no Personal workspaces, so every human member
 * must keep at least one shared workspace: the host invites each person with
 * at least one `initialWorkspaceIds` entry, never removes a member's last
 * shared workspace (offboard the member instead), and reactivates a suspended
 * member with `workspaceIds` to re-grant, because suspension removes every
 * grant. Each is refused with `GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE`.
 *
 * `decide` MUST answer "refuse" for any mutation it does not recognize:
 * `GOVERNED_MUTATIONS` may grow, and a new mutation must stay closed until the
 * host has decided to allow it.
 */
export type OrganizationGovernancePort = {
  /**
   * Organizations this host governs, keyed by the org's external identity
   * source. Synchronous: any answer but a boolean (a Promise included) fails
   * the request closed with `OrganizationGovernancePortContractError`.
   */
  governs(input: { organizationId: string; externalSource: string | null }): boolean;
  decide(input: {
    organizationId: string;
    mutation: GovernedMutation;
    via: GovernedMutationChannel;
  }): "allow" | "refuse";
  /**
   * `"allowlist"`: a person of an organization this host governs reaches its
   * workspace and organization routes (`/v1/workspaces/:workspaceId/*`,
   * `/v1/organizations/:organizationId/*`) only when the route is on the
   * governed allowlist the API exports (`governedRouteTable`); every other
   * route answers 403 `WORKSPACE_ROUTE_NOT_ALLOWED`, ahead of `decide`. Tokens
   * signed with the deployment's delegation secret (the host's own and the
   * runtime's) are not affected. Unset, every route keeps its own checks.
   */
  memberRouteAccess?: "allowlist";
  /**
   * `"host"`: organizations in this deployment are the host's to create. The
   * native creation routes (`POST /v1/organizations`,
   * `/v1/organizations/additional`, `/v1/auth/organization-onboarding`) then
   * refuse every managed human with 403 `ORGANIZATION_CREATE_GOVERNED`
   * unless the person belongs to a governed organization whose host allows
   * `organization.create`. Unset, only a person of a governed organization is
   * asked (any governing host's refusal refuses).
   */
  organizationCreation?: "host";
  /**
   * `"withheld"`: the provider's reasoning text (OpenAI reasoning summaries,
   * Anthropic thinking, chat-completions reasoning) never leaves the server
   * for a session of an organization this host governs. Each
   * `agent.reasoning.delta` event keeps its id, sequence, turn and coverage,
   * so cursors and gap detection are unchanged, and is delivered without
   * text (its payload keeps only a numeric `coalescedUntil`) on the session
   * stream, the event list (every mode, forensic included) and the MCP
   * session views; the stock transcript draws nothing for it. A worker given the same port asks the provider for no
   * reasoning summary for those sessions. Stored events and model history are
   * not changed. Unset or `"full"`: stock behaviour.
   */
  reasoningDisclosure?: ReasoningDisclosure;
  /**
   * The realtime voice models (catalog ids, for example
   * `opengeni-gateway/openai/gpt-realtime-2.1`) a session of an organization
   * this host governs may use. The workspace realtime model catalog lists
   * only these, and a voice start (`POST .../sessions/:id/realtime`) or a
   * connection of a voice mode with any other model is refused with 403
   * `REALTIME_MODEL_NOT_ALLOWED`. An empty list allows none. Unset: the full
   * stock catalog.
   */
  allowedRealtimeModels?: readonly string[];
};

/** Whether a governed organization's sessions show the provider's reasoning text. */
export const REASONING_DISCLOSURES = ["full", "withheld"] as const;
export type ReasoningDisclosure = (typeof REASONING_DISCLOSURES)[number];

/** Refusal detail codes (`error.details.code`). */
/** 403: a governed organization's host does not allow this realtime voice model. */
export const REALTIME_MODEL_NOT_ALLOWED = "REALTIME_MODEL_NOT_ALLOWED";
export const ORGANIZATION_GOVERNED_BY_HOST = "ORGANIZATION_GOVERNED_BY_HOST";
export const ORGANIZATION_NOT_HOST_GOVERNED = "ORGANIZATION_NOT_HOST_GOVERNED";
/**
 * 403: a person of a governed organization called a workspace or organization
 * route outside the governed allowlist (the API's default-deny).
 */
export const WORKSPACE_ROUTE_NOT_ALLOWED = "WORKSPACE_ROUTE_NOT_ALLOWED";
/**
 * 403: a person who belongs to a governed organization tried to create an
 * organization, and that organization's host does not allow
 * `organization.create` natively.
 */
export const ORGANIZATION_CREATE_GOVERNED = "ORGANIZATION_CREATE_GOVERNED";
export const HOST_COMMAND_SERVICE_TOKEN_REQUIRED = "HOST_COMMAND_SERVICE_TOKEN_REQUIRED";
export const HOST_COMMAND_PERMISSION_REQUIRED = "HOST_COMMAND_PERMISSION_REQUIRED";
export const HOST_COMMAND_OPERATION_CONFLICT = "HOST_COMMAND_OPERATION_CONFLICT";
export const GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE =
  "GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE";
export const HOST_IDENTITY_NOT_IN_ORGANIZATION = "HOST_IDENTITY_NOT_IN_ORGANIZATION";
/**
 * Any database authorization refusal for the acting subject (the service
 * token's subject): for example not an active owner or admin, or a role rule.
 */
export const HOST_COMMAND_ACTOR_NOT_AUTHORIZED = "HOST_COMMAND_ACTOR_NOT_AUTHORIZED";
/** The host member read: the membership is unknown or another organization's. */
export const HOST_MEMBER_NOT_IN_ORGANIZATION = "HOST_MEMBER_NOT_IN_ORGANIZATION";
/** The host MCP connection read: the connection is unknown or another organization's. */
export const HOST_MCP_CONNECTION_NOT_IN_ORGANIZATION = "HOST_MCP_CONNECTION_NOT_IN_ORGANIZATION";
/** The host invitation read: the invitation is unknown or another organization's. */
export const HOST_INVITATION_NOT_IN_ORGANIZATION = "HOST_INVITATION_NOT_IN_ORGANIZATION";
/**
 * A host invitation revoke refused because the invitation is still pending at
 * another revision (`details.status` is `"pending"`): read it back and retry at
 * its current revision.
 */
export const HOST_INVITATION_REVISION_CONFLICT = "HOST_INVITATION_REVISION_CONFLICT";
/**
 * A host invitation revoke refused because the invitation is no longer
 * pending at the expected revision: `details.status` is `"accepted"`,
 * `"revoked"` or `"expired"`. `accepted` and `revoked` are final: no revoke can
 * succeed. `expired` can no longer be accepted, so the host may treat it as
 * settled; a revoke at its current revision still records it as `revoked`.
 */
export const HOST_INVITATION_NOT_PENDING = "HOST_INVITATION_NOT_PENDING";
/**
 * The host owner ensure refused (409) because the token's subject already has
 * a membership in the organization that is not an active owner. The ensure
 * never promotes or reactivates a membership; nothing was changed.
 */
export const HOST_ORGANIZATION_OWNER_CONFLICT = "HOST_ORGANIZATION_OWNER_CONFLICT";
/**
 * The attribution name a host owner ensure is recorded under. It is not a
 * `GovernedMutation`: no native route can do it, so there is nothing for
 * `decide` to refuse.
 */
export const HOST_ORGANIZATION_OWNER_ENSURE = "host_owner.ensure";

const encoder = new TextEncoder();
function boundedOpaqueText(maxBytes: number) {
  return primitives.nonEmptyString
    .max(maxBytes)
    .refine(
      (value) =>
        !value.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(value) &&
        encoder.encode(value).byteLength <= maxBytes,
      { message: `must be PostgreSQL Unicode text of at most ${maxBytes} UTF-8 bytes` },
    );
}

/**
 * The host's own user who asked for a host command. Audit only: the service
 * token authorizes the command and the database checks the token's subject.
 */
export const ActingExternalUser = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      source: boundedOpaqueText(200),
      externalId: boundedOpaqueText(1024),
    })
    .strict(),
);
export type ActingExternalUser = z.infer<typeof ActingExternalUser>;

function hostCommand<Command extends z.ZodTypeAny>(command: Command) {
  return z.object({ actingExternalUser: ActingExternalUser, command }).strict();
}

const MemberTransitionFields = {
  expectedAuthorizationRevision: primitives.positiveInteger,
  operationId: primitives.uuid,
  reason: primitives.string.trim().min(1).max(512).optional(),
} as const;

export const HostInviteOrganizationMemberRequest = /* @__PURE__ */ defineSchema(() =>
  hostCommand(CreateOrganizationInvitationRequest),
);
export type HostInviteOrganizationMemberRequest = z.infer<
  typeof HostInviteOrganizationMemberRequest
>;

export const HostRevokeOrganizationInvitationRequest = /* @__PURE__ */ defineSchema(() =>
  hostCommand(RevokeOrganizationInvitationRequest),
);
export type HostRevokeOrganizationInvitationRequest = z.infer<
  typeof HostRevokeOrganizationInvitationRequest
>;

export const HostChangeOrganizationMemberRoleRequest = /* @__PURE__ */ defineSchema(() =>
  hostCommand(z.object({ role: OrganizationMembershipRole, ...MemberTransitionFields }).strict()),
);
export type HostChangeOrganizationMemberRoleRequest = z.infer<
  typeof HostChangeOrganizationMemberRoleRequest
>;

/**
 * Reactivation re-grants shared workspaces in the same transaction: suspension
 * removed every grant, and a governed member must keep one. `workspaceIds` is
 * required (else `GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE`); each is granted
 * with the workspace role `member`.
 */
export const HostReactivateOrganizationMemberRequest = /* @__PURE__ */ defineSchema(() =>
  hostCommand(
    z
      .object({
        ...MemberTransitionFields,
        workspaceIds: z.array(primitives.uuid).max(100).optional(),
      })
      .strict(),
  ),
);
export type HostReactivateOrganizationMemberRequest = z.infer<
  typeof HostReactivateOrganizationMemberRequest
>;

/** Suspend and offboard take the same command. */
export const HostOrganizationMemberLifecycleRequest = /* @__PURE__ */ defineSchema(() =>
  hostCommand(z.object(MemberTransitionFields).strict()),
);
export type HostOrganizationMemberLifecycleRequest = z.infer<
  typeof HostOrganizationMemberLifecycleRequest
>;

export const HostSetOrganizationWorkspaceMemberRequest = /* @__PURE__ */ defineSchema(() =>
  hostCommand(PutOrganizationWorkspaceMemberRequest),
);
export type HostSetOrganizationWorkspaceMemberRequest = z.infer<
  typeof HostSetOrganizationWorkspaceMemberRequest
>;

/**
 * Removes one member's access to one shared workspace. A governed member's
 * last shared workspace is never removed (`GOVERNED_MEMBER_REQUIRES_SHARED_WORKSPACE`):
 * offboard the member instead.
 */
export const HostRevokeOrganizationWorkspaceMemberRequest = /* @__PURE__ */ defineSchema(() =>
  hostCommand(RevokeOrganizationWorkspaceMemberRequest),
);
export type HostRevokeOrganizationWorkspaceMemberRequest = z.infer<
  typeof HostRevokeOrganizationWorkspaceMemberRequest
>;

/**
 * Host owner ensure (`POST /v1/host/organizations/:id/host-owner/ensure`):
 * makes the service token's own subject the active owner of the token's own
 * organization, for an organization bootstrapped without that owner
 * (`bootstrapWorkspace` without `governedOrganizationOwner`, or before its
 * routine was granted). The command names no subject: the token's is the only
 * one.
 */
export const HostEnsureOrganizationOwnerRequest = /* @__PURE__ */ defineSchema(() =>
  hostCommand(z.object({ operationId: primitives.uuid }).strict()),
);
export type HostEnsureOrganizationOwnerRequest = z.infer<typeof HostEnsureOrganizationOwnerRequest>;

/**
 * The host's owner membership. `created` is true only for the call that wrote
 * it; every later ensure, a replayed operation id included, answers false.
 */
export const HostOrganizationOwner = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      membershipId: primitives.uuid,
      subjectId: z.string().min(1).max(1024),
      created: z.boolean(),
    })
    .strict(),
);
export type HostOrganizationOwner = z.infer<typeof HostOrganizationOwner>;

/**
 * Host identity lookup (`POST /v1/host/organizations/:id/identities/lookup`):
 * `identityId` is a native identity id, the `sub` of a host session token.
 * A read, so it takes no `actingExternalUser` and writes no attribution.
 */
export const HostLookupOrganizationIdentityRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ identityId: primitives.uuid }).strict(),
);
export type HostLookupOrganizationIdentityRequest = z.infer<
  typeof HostLookupOrganizationIdentityRequest
>;

/** A membership's grants in the organization's shared workspaces (see the identity lookup). */
function hostSharedWorkspaceAccess() {
  return z.array(
    z
      .object({
        workspaceId: primitives.uuid,
        membershipId: primitives.uuid,
        role: WorkspaceMemberRole,
        permissions: z.array(z.string().min(1).max(128)),
        updatedAt: primitives.string.datetime({ offset: true }),
      })
      .strict(),
  );
}

/**
 * What the organization knows about one native identity that is, or was, its
 * member (any membership status). An identity with no membership here answers
 * 404 `HOST_IDENTITY_NOT_IN_ORGANIZATION`, the same as an unknown one.
 *
 * - `memberships`: the identity's memberships in this organization, oldest
 *   first (a list: an identity can have more than one account). Every status
 *   answers 200; a host MUST refuse to link a membership that is not `active`.
 *   - `authorizationRevision`: the value a member command's
 *     `expectedAuthorizationRevision` (change-role, suspend, reactivate,
 *     offboard) must equal.
 *   - `sharedWorkspaceAccess`: the membership's grants in the organization's
 *     shared workspaces (never its Personal workspace), ordered by workspace
 *     name. `updatedAt` is what a workspace-access command's
 *     `expectedUpdatedAt` must equal, compared to the microsecond: send it
 *     back exactly as received. `role` is `custom` when `permissions` is not
 *     a preset role's set. Empty for a suspended or offboarded membership.
 * - `verifiedEmail`: the email of this organization's member account that the
 *   active login binding signs in to or, without an active binding, of the
 *   oldest active membership's account; null when that email is unverified or
 *   there is no such account (the binding signs in to an account that is not a
 *   member here).
 * - `activeLoginBinding`: the identity's active login binding, or null when it
 *   has none in the `active` state (see `identityStatus`). `id` changes when
 *   another sign-in method becomes the active binding; `revision` increases
 *   whenever that binding's own state changes (stale, recovery, revoked).
 * - `acceptedInvitations`: this organization's invitations the identity
 *   accepted, newest first. `acceptedAt` is the acceptance time: an accepted
 *   invitation never changes again.
 */
export const HostOrganizationIdentity = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      identityStatus: CanonicalHumanIdentityStatus,
      verifiedEmail: z.string().min(1).max(320).nullable(),
      activeLoginBinding: z
        .object({ id: primitives.uuid, revision: primitives.positiveInteger })
        .strict()
        .nullable(),
      memberships: z
        .array(
          z
            .object({
              id: primitives.uuid,
              status: OrganizationMember.shape.status,
              role: OrganizationMembershipRole,
              authorizationRevision: primitives.positiveInteger,
              sharedWorkspaceAccess: hostSharedWorkspaceAccess(),
            })
            .strict(),
        )
        .min(1),
      acceptedInvitations: z.array(
        z
          .object({
            id: primitives.uuid,
            acceptedMembershipId: primitives.uuid,
            acceptedAt: primitives.dateTime,
          })
          .strict(),
      ),
    })
    .strict(),
);
export type HostOrganizationIdentity = z.infer<typeof HostOrganizationIdentity>;

/**
 * Host member read (`GET /v1/host/organizations/:id/members/:membershipId`):
 * where one of the organization's memberships stands, in any status, so a host
 * can check a membership it linked before acting on it. A read: no
 * `actingExternalUser`, no attribution. A membership that is unknown or
 * another organization's answers 404 `HOST_MEMBER_NOT_IN_ORGANIZATION`, the
 * same for both.
 *
 * - `status`, `role`, `authorizationRevision` and `sharedWorkspaceAccess`
 *   mean exactly what they mean in the identity lookup's `memberships`: a
 *   `revoked` (offboarded) or `suspended` membership answers 200 with that
 *   status and no shared-workspace access.
 * - `userId`: the native account the membership belongs to (the subject
 *   `user:<userId>`), and `identityId` that account's native identity (the
 *   `sub` of its host session tokens). Both are null for a membership whose
 *   subject is not a native account; `identityId` is also null when the
 *   account has no identity.
 * - `updatedAt`: the membership's last change.
 */
export const HostOrganizationMember = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      membershipId: primitives.uuid,
      organizationId: primitives.uuid,
      userId: z.string().min(1).max(1024).nullable(),
      identityId: primitives.nullableUuid,
      status: OrganizationMember.shape.status,
      role: OrganizationMembershipRole,
      authorizationRevision: primitives.positiveInteger,
      sharedWorkspaceAccess: hostSharedWorkspaceAccess(),
      updatedAt: primitives.string.datetime({ offset: true }),
    })
    .strict(),
);
export type HostOrganizationMember = z.infer<typeof HostOrganizationMember>;

/**
 * Why a host MCP connection read answers `status: "revoked"`: the connection's
 * next request would be refused. Checked in this order, and the first that
 * holds is the answer:
 *
 * - `revoked`: the connection was disconnected (by its person, an
 *   administrator, or a refresh-token reuse that revoked its whole family).
 * - `expired`: its refresh token's lifetime ended.
 * - `membership_not_live`: its person's membership in the organization is no
 *   longer active (suspended, offboarded, or gone).
 * - `permissions_lost`: the person no longer holds any permission the
 *   connection was consented in its workspace scope (an organization
 *   connection), or no longer has the workspace authority the connection's
 *   live grant needs (a workspace connection). An organization connection
 *   that consented `account:read` (every preset does) practically never
 *   reaches it: every active membership holds `account:read`.
 *
 * The list may grow; a host must treat an unknown reason as not live.
 */
export const HOST_MCP_CONNECTION_NOT_LIVE_REASONS = [
  "revoked",
  "expired",
  "membership_not_live",
  "permissions_lost",
] as const;
export type HostMcpConnectionNotLiveReason = (typeof HOST_MCP_CONNECTION_NOT_LIVE_REASONS)[number];

/**
 * What an MCP connection was consented to do. An organization connection
 * (`workspaceId` null) has its access setting's `preset`; a workspace
 * connection has `preset: null` and a `selected` scope of its one workspace.
 */
export const HostMcpConnectionConsentScope = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      preset: OrganizationAccessPreset.nullable(),
      permissions: z.array(z.string().min(1).max(128)),
      workspaceScope: OrganizationWorkspaceScope,
    })
    .strict(),
);
export type HostMcpConnectionConsentScope = z.infer<typeof HostMcpConnectionConsentScope>;

/**
 * Host read of one MCP connection
 * (`GET /v1/host/organizations/:id/mcp-connections/:connectionId`): whether
 * an outside MCP client a member signed in with can still act, so a host can
 * settle what it projected from the connection. `connectionId` is the
 * connection's id in the native connected-agents list (its refresh-token
 * family). A read: no `actingExternalUser`, no attribution. A connection that
 * is unknown or another organization's answers 404
 * `HOST_MCP_CONNECTION_NOT_IN_ORGANIZATION`, the same for both.
 *
 * - `status`: `active` when the connection's live grant still resolves now,
 *   otherwise `revoked` with `reason` (see `HOST_MCP_CONNECTION_NOT_LIVE_REASONS`);
 *   `reason` is null while active. A `revoked` answer can become `active`
 *   again only for `membership_not_live` and `permissions_lost` (the member is
 *   reactivated or regains access); `revoked` and `expired` are final.
 * - `workspaceId`: the one workspace of a workspace connection, null for an
 *   organization connection.
 * - `revokedAt`: when it was disconnected (`revoked`) or expired (`expired`);
 *   null otherwise.
 * - `updatedAt`: the connection's last recorded change: its latest token
 *   rotation or its revocation. A change of its access setting is not dated.
 */
export const HostOrganizationMcpConnection = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      connectionId: primitives.uuid,
      organizationId: primitives.uuid,
      workspaceId: primitives.nullableUuid,
      clientId: z.string().min(1).max(1024),
      status: z.enum(["active", "revoked"]),
      reason: z.enum(HOST_MCP_CONNECTION_NOT_LIVE_REASONS).nullable(),
      consentScope: HostMcpConnectionConsentScope,
      revokedAt: primitives.dateTime.nullable(),
      updatedAt: primitives.dateTime,
    })
    .strict(),
);
export type HostOrganizationMcpConnection = z.infer<typeof HostOrganizationMcpConnection>;

/** Headers of every host webhook delivery. */
export const HOST_WEBHOOK_SIGNATURE_HEADER = "X-Host-Signature";
export const HOST_WEBHOOK_DELIVERY_HEADER = "X-Host-Delivery";

/**
 * The `mcp_connection.revoked` host webhook (`settings.hostWebhooks.mcpConnectionRevoked`):
 * POSTed once for each MCP connection of an organization that is disconnected
 * (`change: "revoked"`, `revokedAt` set) or whose access setting loses a
 * permission or a workspace (`change: "consent_downgraded"`, `revokedAt` null,
 * `consentScope` the new setting). Sent only after the change committed.
 *
 * `X-Host-Signature` is `sha256=` and the lowercase hex HMAC-SHA256 of the raw
 * body under the configured secret; verify it over the exact bytes received.
 * `X-Host-Delivery` is the delivery's id: every retry of one delivery sends
 * the same id and body, so a host deduplicates on it. A delivery is retried
 * with backoff until the host answers 2xx; a 3xx (never followed) or a 4xx
 * other than 408 and 429 ends it. The worker looks for the committed change
 * for about two minutes (24 checks, 5 seconds apart) and sends nothing after
 * that. A delivery that can't be started never blocks the change: the API logs
 * `host_webhook.delivery_start_failed` and writes it anyway, and the host MCP
 * connection read stays authoritative. Membership changes and other reasons a connection stops being live (see
 * the host MCP connection read) send nothing.
 */
export const HostMcpConnectionRevokedWebhook = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: z.literal("mcp_connection.revoked"),
      change: z.enum(["revoked", "consent_downgraded"]),
      connectionId: primitives.uuid,
      organizationId: primitives.uuid,
      workspaceId: primitives.nullableUuid,
      clientId: z.string().min(1).max(1024),
      revokedAt: primitives.dateTime.nullable(),
      consentScope: HostMcpConnectionConsentScope,
    })
    .strict(),
);
export type HostMcpConnectionRevokedWebhook = z.infer<typeof HostMcpConnectionRevokedWebhook>;

/**
 * One durable host webhook delivery the API asks the worker to make, before
 * it writes the change: the worker sends it only once the change is seen
 * committed, so a change that never commits sends nothing.
 */
export type HostWebhookDeliveryRequest = {
  deliveryId: string;
  event: {
    type: "mcp_connection.revoked";
    organizationId: string;
    connectionId: string;
  } & (
    | { change: "revoked" }
    | {
        change: "consent_downgraded";
        /** The setting the change starts from. */
        previousConsentScope: HostMcpConnectionConsentScope;
        /** The setting the change writes. */
        consentScope: HostMcpConnectionConsentScope;
      }
  );
};

/**
 * Whether a new consent takes something away from an old one: a permission
 * the old one had, or a workspace it covered (every workspace narrowed to
 * selected ones, or a selected workspace dropped). A change that only adds is
 * not one.
 */
export function isConsentScopeDowngrade(
  before: Pick<HostMcpConnectionConsentScope, "permissions" | "workspaceScope">,
  after: Pick<HostMcpConnectionConsentScope, "permissions" | "workspaceScope">,
): boolean {
  const kept = new Set(after.permissions);
  if (before.permissions.some((permission) => !kept.has(permission))) return true;
  if (after.workspaceScope.kind === "all") return false;
  if (before.workspaceScope.kind === "all") return true;
  const selected = new Set(after.workspaceScope.workspaceIds);
  return before.workspaceScope.workspaceIds.some((workspaceId) => !selected.has(workspaceId));
}

/**
 * Host invitation read (`GET /v1/host/organizations/:id/invitations/:invitationId`):
 * where one of the organization's invitations stands, so a host can settle a
 * revoke it retries. A read: no `actingExternalUser`, no attribution. An
 * invitation that is unknown or another organization's answers 404
 * `HOST_INVITATION_NOT_IN_ORGANIZATION`, the same for both.
 *
 * - `status`: `expired` is a pending invitation past `expiresAt`. `accepted`,
 *   `revoked` and `expired` are final.
 * - `revision`: what a revoke's `expectedRevision` must equal while pending.
 * - `acceptedMembershipId`, `acceptedAt`: the membership the acceptance made
 *   and when, for an accepted invitation; otherwise null. An accepted
 *   invitation never changes again.
 *
 * Instants are ISO-8601 UTC with millisecond precision. The invitee's email,
 * name and workspaces are not part of it.
 */
export const HostOrganizationInvitation = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: primitives.uuid,
      organizationId: primitives.uuid,
      status: OrganizationInvitationStatus,
      revision: primitives.positiveInteger,
      acceptedMembershipId: primitives.nullableUuid,
      acceptedAt: primitives.dateTime.nullable(),
      expiresAt: primitives.dateTime,
    })
    .strict(),
);
export type HostOrganizationInvitation = z.infer<typeof HostOrganizationInvitation>;

/** One pending native OAuth proposal. This projection carries no code or bearer. */
export const HostMcpOAuthConsentProposal = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      organizationId: primitives.uuid,
      workspaceId: primitives.uuid,
      revision: z.number().int().positive(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      operationId: primitives.uuid,
      expiresAt: z.string().datetime(),
      material: z
        .object({
          clientId: z.string().min(1).max(256),
          organizationId: primitives.uuid,
          workspaceId: primitives.uuid,
          subjectId: z.string().min(1).max(1024),
          resource: z.string().url().max(2048),
          redirectUri: z.string().url().max(2048),
          codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          codeChallengeMethod: z.literal("S256"),
          permissions: z.array(Permission).max(4096),
          toolIdentities: z.array(ToolGatewayIdentity).max(4096),
          organizationAccess: OrganizationAccessPolicy.nullable(),
          consentPreset: OrganizationAccessPreset.nullable(),
          toolSetVersions: z
            .record(z.string().min(1).max(256), z.string().min(1).max(256))
            .nullable(),
          expiresAt: z.string().max(64),
          human: z
            .object({
              identityId: primitives.uuid,
              authSessionId: z.string().min(1).max(1024),
              loginBindingId: primitives.uuid,
              loginBindingRevision: z.number().int().positive(),
            })
            .strict(),
        })
        .strict(),
      admitted: z.boolean(),
    })
    .strict(),
);
export type HostMcpOAuthConsentProposal = z.infer<typeof HostMcpOAuthConsentProposal>;
export const HostAdmitMcpOAuthConsentRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      actingExternalUser: ActingExternalUser,
      command: z
        .object({
          revision: z.number().int().positive(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          operationId: primitives.uuid,
        })
        .strict(),
    })
    .strict(),
);
export type HostAdmitMcpOAuthConsentRequest = z.infer<typeof HostAdmitMcpOAuthConsentRequest>;
/**
 * Optional embedding-host handoff for an explicitly approved native proposal.
 * Read the opaque human credential only to authenticate to the configured host;
 * never serialize/persist/log it or an exception it appears in. The host verifies
 * the JWT locally and independently reads/admit the canonical proposal through
 * HOST commands. Returning from this call grants nothing. Honor the aggregate
 * signal/deadline and clamp each network call to min(5s, remaining time).
 */
export type McpOAuthHostConsentPort = {
  admit(input: {
    proposal: Pick<
      HostMcpOAuthConsentProposal,
      | "requestHash"
      | "organizationId"
      | "workspaceId"
      | "revision"
      | "digest"
      | "operationId"
      | "expiresAt"
    >;
    readCredential: () => string;
    signal: AbortSignal;
    deadlineAt: number;
  }): Promise<void>;
};
