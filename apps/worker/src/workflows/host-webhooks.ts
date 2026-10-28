import { ApplicationFailure, proxyActivities, sleep } from "@temporalio/workflow";
import type { HostWebhookDeliveryRequest } from "@opengeni/contracts/organization-governance";
import type { DeliverHostWebhookInput, HostWebhookChangeState } from "../activities/host-webhooks";

/**
 * How long a delivery waits to see its change committed. The API starts the
 * delivery just before it writes the change, so a change that never commits
 * (the write failed, or the API process died first) sends nothing.
 */
export const HOST_WEBHOOK_CONFIRM_ATTEMPTS = 24;
export const HOST_WEBHOOK_CONFIRM_INTERVAL = "5 seconds";

/** Retries until the host answers 2xx, with backoff, for about a day. */
export const HOST_WEBHOOK_DELIVERY_RETRY = {
  initialInterval: "10 seconds",
  backoffCoefficient: 2,
  maximumInterval: "1 hour",
  maximumAttempts: 30,
} as const;

export type HostWebhookDeliveryActivities = {
  confirmHostWebhookChange: (
    request: HostWebhookDeliveryRequest,
  ) => Promise<HostWebhookChangeState>;
  deliverHostWebhook: (input: DeliverHostWebhookInput) => Promise<void>;
};

export type HostWebhookDeliveryOutcome = "delivered" | "not_committed" | "superseded";

export async function runHostWebhookDelivery(
  request: HostWebhookDeliveryRequest,
  activities: HostWebhookDeliveryActivities,
  wait: () => Promise<void>,
): Promise<HostWebhookDeliveryOutcome> {
  for (let attempt = 0; attempt < HOST_WEBHOOK_CONFIRM_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait();
    const state = await activities.confirmHostWebhookChange(request);
    if (state.status === "superseded") return "superseded";
    if (state.status === "committed") {
      await activities.deliverHostWebhook({ deliveryId: request.deliveryId, body: state.body });
      return "delivered";
    }
  }
  return "not_committed";
}

const confirmActivity = proxyActivities<
  Pick<HostWebhookDeliveryActivities, "confirmHostWebhookChange">
>({
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "30 seconds" },
});

const deliverActivity = proxyActivities<Pick<HostWebhookDeliveryActivities, "deliverHostWebhook">>({
  startToCloseTimeout: "1 minute",
  retry: HOST_WEBHOOK_DELIVERY_RETRY,
});

/**
 * One host webhook delivery; its workflow id is `host-webhook:<deliveryId>`.
 * A change that never committed fails the run, so the same delivery can be
 * started again; a delivered or superseded one completes.
 */
export async function hostWebhookDeliveryWorkflow(
  request: HostWebhookDeliveryRequest,
): Promise<Exclude<HostWebhookDeliveryOutcome, "not_committed">> {
  const outcome = await runHostWebhookDelivery(
    request,
    {
      confirmHostWebhookChange: confirmActivity.confirmHostWebhookChange,
      deliverHostWebhook: deliverActivity.deliverHostWebhook,
    },
    async () => await sleep(HOST_WEBHOOK_CONFIRM_INTERVAL),
  );
  if (outcome === "not_committed")
    throw ApplicationFailure.nonRetryable(
      "the change this delivery reports was not committed",
      "HOST_WEBHOOK_CHANGE_NOT_COMMITTED",
    );
  return outcome;
}
