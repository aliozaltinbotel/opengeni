import { continueAsNew, proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { RealtimeUsageInput } from "../activities/types";

export async function realtimeUsageWorkflow(input: RealtimeUsageInput & { baseTaskQueue: string }): Promise<void> {
  const activity = proxyActivities<Pick<typeof activities, "observeRealtimeSessionUsage">>({
    taskQueue: input.baseTaskQueue, startToCloseTimeout: "1 minute", heartbeatTimeout: "15 seconds",
    retry: { initialInterval: "1 second", maximumInterval: "30 seconds", maximumAttempts: 3 },
  });
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const result = await activity.observeRealtimeSessionUsage(input);
    if (result.action === "terminal") return;
    await sleep(result.delayMs);
  }
  await continueAsNew<typeof realtimeUsageWorkflow>(input);
}
