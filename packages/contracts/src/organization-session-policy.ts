import { z } from "zod";
import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import {
  AGENT_FUNCTION_TOOL_CAPABILITIES,
  FIRST_PARTY_MCP_TOOL_CAPABILITIES,
} from "./agent-config";
import { isCuaDesktopModelTool } from "./cua-desktop-tools";
import { ActingExternalUser } from "./organization-governance";

/**
 * What sessions in one organization's workspaces may receive, whoever starts
 * them (chat, API, schedules, automations). An embedding host that governs the
 * organization sets it with a host command; no native route writes it.
 *
 * - `attachments`: whether people may upload files into the workspace and
 *   attach files to messages. `disabled` refuses both on the server.
 * - `toolFamilies`: generic tool families removed from every session's tool
 *   catalog and refused at call admission. `deny` names the removed families;
 *   `allow` names the only families kept. Either way the policy only narrows:
 *   a family it keeps still follows the session's own capabilities.
 */
export const SESSION_TOOL_FAMILIES = ["shell", "codemode", "browser", "computerUse"] as const;
export const SessionToolFamily = /* @__PURE__ */ defineSchema(() => z.enum(SESSION_TOOL_FAMILIES));
export type SessionToolFamily = z.infer<typeof SessionToolFamily>;

export const OrganizationSessionAttachments = /* @__PURE__ */ defineSchema(() =>
  z.enum(["enabled", "disabled"]),
);
export type OrganizationSessionAttachments = z.infer<typeof OrganizationSessionAttachments>;

export const OrganizationSessionPolicy = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      attachments: OrganizationSessionAttachments,
      toolFamilies: z
        .object({
          mode: z.enum(["deny", "allow"]),
          families: z
            .array(SessionToolFamily)
            .max(SESSION_TOOL_FAMILIES.length)
            .refine((families) => new Set(families).size === families.length, {
              message: "families must not repeat",
            }),
        })
        .strict(),
    })
    .strict(),
);
export type OrganizationSessionPolicy = z.infer<typeof OrganizationSessionPolicy>;

/** No stored policy and no governing host: nothing is restricted. */
export const STOCK_ORGANIZATION_SESSION_POLICY: OrganizationSessionPolicy = Object.freeze({
  attachments: "enabled",
  toolFamilies: Object.freeze({ mode: "deny", families: [] as SessionToolFamily[] }),
}) as OrganizationSessionPolicy;

/**
 * A governed organization's policy until its host sets one: no attachments
 * and no generic shell, Codemode, browser or computer-use tools.
 */
export const GOVERNED_ORGANIZATION_SESSION_POLICY: OrganizationSessionPolicy = Object.freeze({
  attachments: "disabled",
  toolFamilies: Object.freeze({ mode: "deny", families: [...SESSION_TOOL_FAMILIES] }),
}) as OrganizationSessionPolicy;

/** `stock`: nothing stored. `governed_default`: stored when first seen governed. `host`: set by the host. */
export const OrganizationSessionPolicySource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["stock", "governed_default", "host"]),
);
export type OrganizationSessionPolicySource = z.infer<typeof OrganizationSessionPolicySource>;

export const OrganizationSessionPolicyView = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      organizationId: primitives.uuid,
      policy: OrganizationSessionPolicy,
      source: OrganizationSessionPolicySource,
      /** 0 when nothing is stored. */
      revision: primitives.nonnegativeInteger,
      updatedAt: primitives.nullableString,
    })
    .strict(),
);
export type OrganizationSessionPolicyView = z.infer<typeof OrganizationSessionPolicyView>;

/** The host command's answer: the stored policy, and whether this was a replay of its operation. */
export const HostPutOrganizationSessionPolicyResponse = /* @__PURE__ */ defineSchema(() =>
  OrganizationSessionPolicyView.extend({ replay: primitives.boolean }).strict(),
);
export type HostPutOrganizationSessionPolicyResponse = z.infer<
  typeof HostPutOrganizationSessionPolicyResponse
>;

/** `PUT /v1/host/organizations/:organizationId/session-policy`. */
export const HostPutOrganizationSessionPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      actingExternalUser: ActingExternalUser,
      command: z
        .object({
          policy: OrganizationSessionPolicy,
          operationId: primitives.uuid,
          /**
           * The stored revision this command replaces (`revision` of a GET). 0
           * means no host policy yet: nothing stored, or only the governed default.
           */
          expectedRevision: primitives.nonnegativeInteger,
        })
        .strict(),
    })
    .strict(),
);
export type HostPutOrganizationSessionPolicyRequest = z.infer<
  typeof HostPutOrganizationSessionPolicyRequest
>;

/** Refusal detail codes (`error.details.code`). */
export const ATTACHMENTS_DISABLED = "ATTACHMENTS_DISABLED";
export const SESSION_TOOL_FAMILY_DENIED = "SESSION_TOOL_FAMILY_DENIED";
/** 409: this operation id already wrote a different policy. */
export const SESSION_POLICY_OPERATION_CONFLICT = "SESSION_POLICY_OPERATION_CONFLICT";
/** 409: `expectedRevision` is not the stored revision. */
export const SESSION_POLICY_REVISION_CONFLICT = "SESSION_POLICY_REVISION_CONFLICT";

/** The digest a host command's policy is idempotent on: canonical JSON, families sorted. */
export function organizationSessionPolicyDigestInput(policy: OrganizationSessionPolicy): string {
  return JSON.stringify({
    attachments: policy.attachments,
    toolFamilies: {
      mode: policy.toolFamilies.mode,
      families: [...policy.toolFamilies.families].sort(),
    },
  });
}

/** The families a policy removes, in `SESSION_TOOL_FAMILIES` order. */
export function deniedSessionToolFamilies(policy: OrganizationSessionPolicy): SessionToolFamily[] {
  const named = new Set(policy.toolFamilies.families);
  return SESSION_TOOL_FAMILIES.filter((family) =>
    policy.toolFamilies.mode === "deny" ? named.has(family) : !named.has(family),
  );
}

const INTERACTION_MODEL_PREFIX = "interaction__";

/** First-party tools that move the session's compute or add a machine. */
const COMPUTE_ROUTING_TOOLS: ReadonlySet<string> = new Set([
  "sandboxes_list",
  "sandbox_attach",
  "sandbox_swap",
  "sandbox_provision",
  "run_on",
  "connected_machine_enroll_token",
  "connected_machine_remove",
]);
const COMPUTER_USE_TOOLS: ReadonlySet<string> = new Set([
  "excel_run",
  "connected_machine_enable_screen_control",
]);

/**
 * The generic family a model-visible tool belongs to, or null for every other
 * tool (business, runtime, Knowledge, MCP servers a workspace or host adds).
 * Accepts first-party MCP names, function-tool names and the desktop tools'
 * model names.
 */
export function sessionToolFamilyOf(toolName: string): SessionToolFamily | null {
  if (isCuaDesktopModelTool(toolName)) return "computerUse";
  // In-process interaction tools reach the model as `interaction__<tool>`.
  if (toolName.startsWith(INTERACTION_MODEL_PREFIX))
    return sessionToolFamilyOf(toolName.slice(INTERACTION_MODEL_PREFIX.length));
  if (COMPUTER_USE_TOOLS.has(toolName)) return "computerUse";
  if (COMPUTE_ROUTING_TOOLS.has(toolName)) return "shell";
  const firstParty = (FIRST_PARTY_MCP_TOOL_CAPABILITIES as Record<string, string | undefined>)[
    toolName
  ];
  if (firstParty === "browser") return toolName.startsWith("computer_") ? "computerUse" : "browser";
  if (firstParty === "sandbox") return "shell";
  const functionTool = (AGENT_FUNCTION_TOOL_CAPABILITIES as Record<string, string | undefined>)[
    toolName
  ];
  if (functionTool === "sandbox") return "shell";
  return null;
}

export type SessionToolFamilyGate = {
  readonly deniedFamilies: ReadonlySet<SessionToolFamily>;
  denies(family: SessionToolFamily): boolean;
  /** False only for a tool of a denied family. */
  allowsTool(toolName: string): boolean;
};

/** The gate for a policy; no policy means stock (nothing denied). */
export function sessionToolFamilyGate(
  policy: OrganizationSessionPolicy | null | undefined,
): SessionToolFamilyGate {
  const deniedFamilies: ReadonlySet<SessionToolFamily> = new Set(
    policy ? deniedSessionToolFamilies(policy) : [],
  );
  return {
    deniedFamilies,
    denies: (family) => deniedFamilies.has(family),
    allowsTool: (toolName) => {
      if (deniedFamilies.size === 0) return true;
      const family = sessionToolFamilyOf(toolName);
      return family === null || !deniedFamilies.has(family);
    },
  };
}
