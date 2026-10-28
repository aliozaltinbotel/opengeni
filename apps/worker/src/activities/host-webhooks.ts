import { createHmac } from "node:crypto";
import { ApplicationFailure } from "@temporalio/activity";
import {
  HOST_WEBHOOK_DELIVERY_HEADER,
  HOST_WEBHOOK_SIGNATURE_HEADER,
  HostMcpConnectionRevokedWebhook,
  isConsentScopeDowngrade,
  type HostWebhookDeliveryRequest,
} from "@opengeni/contracts/organization-governance";
import { getMcpOAuthConnectionRecord, mcpOAuthConnectionConsentScope } from "@opengeni/db";
import { DestinationPolicyError, pinnedFetch } from "@opengeni/network";
import type { ControlActivityServices } from "./types";

/** Where a requested change stands, as the database shows it now. */
export type HostWebhookChangeState =
  | { status: "committed"; body: string }
  | { status: "pending" }
  /** A later change made this one moot (a downgraded connection was then revoked). */
  | { status: "superseded" };

export type DeliverHostWebhookInput = { deliveryId: string; body: string };

const DELIVERY_TIMEOUT_MS = 10_000;

/** `sha256=<lowercase hex HMAC-SHA256(secret, body)>`, the `X-Host-Signature` value. */
export function hostWebhookSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/**
 * The body is built once, when the change is seen committed, and every retry
 * sends exactly it: one delivery id, one body, one signature.
 */
export function createHostWebhookActivities(
  services: () => Promise<ControlActivityServices>,
  options: { fetch?: typeof pinnedFetch } = {},
) {
  async function confirmHostWebhookChange(
    request: HostWebhookDeliveryRequest,
  ): Promise<HostWebhookChangeState> {
    const { db } = await services();
    const { event } = request;
    const record = await getMcpOAuthConnectionRecord(db, {
      accountId: event.organizationId,
      connectionId: event.connectionId,
    });
    if (!record) return { status: "pending" };
    const consentScope = mcpOAuthConnectionConsentScope(record);
    if (event.change === "revoked") {
      if (!record.revokedAt) return { status: "pending" };
    } else {
      if (record.revokedAt) return { status: "superseded" };
      // Committed once the stored setting has lost something against the one
      // the change started from, even when a later change that only widened
      // landed first; the body names the setting as it stands now.
      if (!isConsentScopeDowngrade(event.previousConsentScope, consentScope))
        return { status: "pending" };
    }
    const body = HostMcpConnectionRevokedWebhook.parse({
      type: event.type,
      change: event.change,
      connectionId: record.id,
      organizationId: record.accountId,
      workspaceId: record.grant.workspaceId,
      clientId: record.clientId,
      revokedAt: event.change === "revoked" ? record.revokedAt!.toISOString() : null,
      consentScope,
    });
    return { status: "committed", body: JSON.stringify(body) };
  }

  async function deliverHostWebhook(input: DeliverHostWebhookInput): Promise<void> {
    const { settings } = await services();
    const target = settings.hostWebhooks?.mcpConnectionRevoked;
    if (!target)
      throw ApplicationFailure.nonRetryable(
        "the host webhook is not configured on this worker",
        "HOST_WEBHOOK_NOT_CONFIGURED",
      );
    let response: Response;
    try {
      response = await (options.fetch ?? pinnedFetch)(
        target.url,
        {
          method: "POST",
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          headers: {
            "content-type": "application/json",
            [HOST_WEBHOOK_SIGNATURE_HEADER]: hostWebhookSignature(target.secret, input.body),
            [HOST_WEBHOOK_DELIVERY_HEADER]: input.deliveryId,
          },
          body: input.body,
        },
        // The deployment's operator configured this target, so a host inside
        // the cluster is reachable; it must still be https outside local/test.
        { ...settings, integrationsAllowPrivateNetworkTargets: true },
        { label: "Host webhook", requireHttpsOutsideLocalTest: true },
      );
    } catch (error) {
      // A target the policy refuses is refused on every attempt; a DNS failure may pass.
      if (
        error instanceof DestinationPolicyError &&
        !["dns_failed", "dns_empty"].includes(error.reason)
      )
        throw ApplicationFailure.nonRetryable(
          `host webhook target refused: ${error.message}`,
          "HOST_WEBHOOK_TARGET_REFUSED",
        );
      throw ApplicationFailure.retryable(
        `host webhook delivery failed: ${error instanceof Error ? error.name : "error"}`,
        "HOST_WEBHOOK_UNREACHABLE",
      );
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return;
    const message = `host webhook answered ${response.status}`;
    // A refusal or redirect the host will repeat ends the delivery (redirects
    // are never followed); anything else is retried.
    if (response.status < 500 && ![408, 429].includes(response.status))
      throw ApplicationFailure.nonRetryable(message, "HOST_WEBHOOK_REFUSED");
    throw ApplicationFailure.retryable(message, "HOST_WEBHOOK_REJECTED");
  }

  return { confirmHostWebhookChange, deliverHostWebhook };
}
