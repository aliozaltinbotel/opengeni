import { createHash } from "node:crypto";
import type { OrganizationAccessPolicy } from "@opengeni/contracts";
import {
  isConsentScopeDowngrade,
  type HostWebhookDeliveryRequest,
} from "@opengeni/contracts/organization-governance";
import type { ApiRouteDeps } from "@opengeni/core";

type McpConnectionChange =
  | { change: "revoked" }
  | {
      change: "consent_downgraded";
      /** The setting before the change, which the worker compares the committed one to. */
      previousConsentScope: OrganizationAccessPolicy;
      consentScope: OrganizationAccessPolicy;
    };

/** The startup refusal when the webhook is configured but deliveries can't be started. */
export const HOST_WEBHOOK_DELIVERY_UNAVAILABLE = "HOST_WEBHOOK_DELIVERY_UNAVAILABLE";

/**
 * Refuse to start an API that has the host webhook configured but a workflow
 * client that cannot start deliveries: the misconfiguration surfaces at boot,
 * not as a warning on every disconnect.
 */
export function assertHostWebhookDeliveryConfigured(
  deps: Pick<ApiRouteDeps, "settings" | "workflowClient">,
): void {
  if (
    deps.settings.hostWebhooks?.mcpConnectionRevoked &&
    !deps.workflowClient.startHostWebhookDelivery
  )
    throw new Error(
      `${HOST_WEBHOOK_DELIVERY_UNAVAILABLE}: hostWebhooks.mcpConnectionRevoked is configured but the workflow client cannot start host webhook deliveries`,
    );
}

/**
 * Start the host's `mcp_connection.revoked` delivery for a change about to be
 * written: call it after every check and right before the write. The worker
 * sends it only once it sees the change committed, so a write that fails, or
 * a process that dies before writing, sends nothing. Nothing is started while
 * `settings.hostWebhooks.mcpConnectionRevoked` is unset. A revoke has one
 * delivery id per connection, so concurrent revokes share one delivery.
 *
 * A notification never blocks the change: when the delivery can't be started
 * (Temporal unreachable), one structured warning is logged and the caller
 * writes the change anyway. The host MCP connection read stays authoritative.
 */
export async function startMcpConnectionRevokedDelivery(
  deps: Pick<ApiRouteDeps, "settings" | "workflowClient">,
  input: { organizationId: string; connectionId: string } & McpConnectionChange,
): Promise<void> {
  if (!deps.settings.hostWebhooks?.mcpConnectionRevoked) return;
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
            previousConsentScope: input.previousConsentScope,
            consentScope: input.consentScope,
          },
        };
  try {
    const start = deps.workflowClient.startHostWebhookDelivery;
    if (!start) throw new Error(HOST_WEBHOOK_DELIVERY_UNAVAILABLE);
    await start(request);
  } catch (error) {
    console.warn("host_webhook.delivery_start_failed", {
      event: request.event.type,
      change: request.event.change,
      organizationId,
      connectionId,
      deliveryId: request.deliveryId,
      errorClass: error instanceof Error ? error.name : typeof error,
    });
  }
}

/** Whether a new access setting takes a permission or a workspace away (see `isConsentScopeDowngrade`). */
export function isConsentDowngrade(
  before: OrganizationAccessPolicy,
  after: OrganizationAccessPolicy,
): boolean {
  return isConsentScopeDowngrade(before, after);
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
