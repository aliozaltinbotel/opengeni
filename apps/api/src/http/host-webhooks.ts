import { createHash } from "node:crypto";
import type { OrganizationAccessPolicy } from "@opengeni/contracts";
import type { HostWebhookDeliveryRequest } from "@opengeni/contracts/organization-governance";
import type { ApiRouteDeps } from "@opengeni/core";
import { ApiHttpError } from "./api-error";

type McpConnectionChange =
  | { change: "revoked" }
  | { change: "consent_downgraded"; consentScope: OrganizationAccessPolicy };

/**
 * Start the host's `mcp_connection.revoked` delivery for a change about to be
 * written: call it after every check and right before the write. The worker
 * sends it only once it sees the change committed, so a write that fails, or
 * a process that dies before writing, sends nothing. Nothing is started while
 * `settings.hostWebhooks.mcpConnectionRevoked` is unset. A revoke has one
 * delivery id per connection, so concurrent revokes share one delivery.
 */
export async function startMcpConnectionRevokedDelivery(
  deps: Pick<ApiRouteDeps, "settings" | "workflowClient">,
  input: { organizationId: string; connectionId: string } & McpConnectionChange,
): Promise<void> {
  if (!deps.settings.hostWebhooks?.mcpConnectionRevoked) return;
  const start = deps.workflowClient.startHostWebhookDelivery;
  if (!start)
    throw new Error(
      "HOST_WEBHOOK_DELIVERY_UNAVAILABLE: the workflow client cannot start deliveries",
    );
  const { organizationId, connectionId } = input;
  const request: HostWebhookDeliveryRequest =
    input.change === "revoked"
      ? {
          deliveryId: deterministicUuid(`mcp_connection.revoked:${connectionId}`),
          event: {
            type: "mcp_connection.revoked",
            organizationId,
            connectionId,
            change: "revoked",
          },
        }
      : {
          deliveryId: crypto.randomUUID(),
          event: {
            type: "mcp_connection.revoked",
            organizationId,
            connectionId,
            change: "consent_downgraded",
            consentScope: input.consentScope,
          },
        };
  try {
    await start(request);
  } catch {
    // Nothing was written: the change waits until its delivery can start.
    throw new ApiHttpError(503, {
      code: "upstream_unavailable",
      message: "This change can't be recorded right now. Try again shortly.",
      retryable: true,
      outcomeUnknown: false,
      details: { code: HOST_WEBHOOK_DELIVERY_UNAVAILABLE },
    });
  }
}

/** The 503 `details.code` when a configured host webhook's delivery can't be started. */
export const HOST_WEBHOOK_DELIVERY_UNAVAILABLE = "HOST_WEBHOOK_DELIVERY_UNAVAILABLE";

/**
 * Whether a new access setting takes something away: a permission the old one
 * had, or a workspace it covered (every workspace narrowed to selected ones,
 * or a selected workspace dropped). A change that only adds is not one.
 */
export function isConsentDowngrade(
  before: OrganizationAccessPolicy,
  after: OrganizationAccessPolicy,
): boolean {
  const kept = new Set(after.permissions);
  if (before.permissions.some((permission) => !kept.has(permission))) return true;
  if (after.workspaceScope.kind === "all") return false;
  if (before.workspaceScope.kind === "all") return true;
  const selected = new Set(after.workspaceScope.workspaceIds);
  return before.workspaceScope.workspaceIds.some((workspaceId) => !selected.has(workspaceId));
}

/** A name-based (version 5 layout) UUID: the same name always gives the same id. */
function deterministicUuid(name: string): string {
  const bytes = createHash("sha256")
    .update(`opengeni.host-webhook:${name}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
