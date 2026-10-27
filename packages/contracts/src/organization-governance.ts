import { z } from "zod";
import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { CanonicalHumanIdentityStatus } from "./canonical-human-identities";
import {
  CreateOrganizationInvitationRequest,
  OrganizationInvitationStatus,
  OrganizationMember,
  OrganizationMembershipRole,
  PutOrganizationWorkspaceMemberRequest,
  RevokeOrganizationInvitationRequest,
  RevokeOrganizationWorkspaceMemberRequest,
} from "./organization-membership-lifecycle";

/**
 * Every native route that changes who belongs to an organization, what they may
 * do there, or which credentials act in it (including connected MCP agents),
 * the organization recovery operations that hand ownership to a member, and
 * workspace deletion, which removes every grant in that workspace. An
 * embedding host that governs an organization decides each one
 * (`OrganizationGovernancePort.decide`). The list may grow in later releases.
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
};

/** Refusal detail codes (`error.details.code`). */
export const ORGANIZATION_GOVERNED_BY_HOST = "ORGANIZATION_GOVERNED_BY_HOST";
export const ORGANIZATION_NOT_HOST_GOVERNED = "ORGANIZATION_NOT_HOST_GOVERNED";
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
 * pending: `details.status` is `"accepted"`, `"revoked"` or `"expired"`. Final:
 * no retry can revoke it.
 */
export const HOST_INVITATION_NOT_PENDING = "HOST_INVITATION_NOT_PENDING";

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

/**
 * What the organization knows about one native identity that is, or was, its
 * member (any membership status). An identity with no membership here answers
 * 404 `HOST_IDENTITY_NOT_IN_ORGANIZATION`, the same as an unknown one.
 *
 * - `memberships`: the identity's memberships in this organization, oldest
 *   first (a list: an identity can have more than one account). Every status
 *   answers 200; a host MUST refuse to link a membership that is not `active`.
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
