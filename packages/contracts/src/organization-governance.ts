import { z } from "zod";
import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import {
  CreateOrganizationInvitationRequest,
  OrganizationMembershipRole,
  PutOrganizationWorkspaceMemberRequest,
  RevokeOrganizationInvitationRequest,
} from "./organization-membership-lifecycle";

/**
 * Every native route that changes who belongs to an organization, what they may
 * do there, or which credentials act in it (including connected MCP agents).
 * An embedding host that governs an organization decides each one
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
 * `decide` MUST answer "refuse" for any mutation it does not recognize:
 * `GOVERNED_MUTATIONS` may grow, and a new mutation must stay closed until the
 * host has decided to allow it.
 */
export type OrganizationGovernancePort = {
  /** Organizations this host governs, keyed by the org's external identity source. */
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

/** Suspend, reactivate and offboard take the same command. */
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
