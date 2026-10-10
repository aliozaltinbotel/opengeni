import { ApplicationFailure, defineQuery, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { KnowledgeQueryWorkflowRequest, KnowledgePreparationWorkflowRequest } from "@opengeni/core";

/** Both discovery views and their catalog belong to one authenticated owner. */
export async function knowledgePreparationWorkflow(input: KnowledgePreparationWorkflowRequest & {
  callId: string; bindingDigest: string; baseTaskQueue: string;
}) {
  setHandler(defineQuery<string>("knowledgeQueryBinding"), () => input.bindingDigest);
  const dispatch = proxyActivities<Pick<typeof activities, "executeKnowledgePreparation">>({
    taskQueue: input.baseTaskQueue, startToCloseTimeout: "2 minutes", retry: { maximumAttempts: 1 },
  });
  const recovery = proxyActivities<Pick<typeof activities, "settleKnowledgeQueryUnknown">>({
    taskQueue: input.baseTaskQueue, startToCloseTimeout: "1 minute",
    retry: { initialInterval: "1 second", maximumInterval: "30 seconds" },
  });
  try { return await dispatch.executeKnowledgePreparation(input); }
  catch {
    await recovery.settleKnowledgeQueryUnknown({ ...input, operationKind: "preparation" });
    throw ApplicationFailure.nonRetryable("Knowledge preparation outcome is unknown", "KNOWLEDGE_QUERY_OUTCOME_UNKNOWN");
  }
}

/** One authenticated logical request, distinct from the scheduled index sweep. */
export async function knowledgeQueryWorkflow(input: KnowledgeQueryWorkflowRequest & {
  callId: string; bindingDigest: string; baseTaskQueue: string;
}) {
  setHandler(defineQuery<string>("knowledgeQueryBinding"), () => input.bindingDigest);
  const dispatch = proxyActivities<Pick<typeof activities, "executeKnowledgeQuery">>({
    taskQueue: input.baseTaskQueue, startToCloseTimeout: "2 minutes", retry: { maximumAttempts: 1 },
  });
  const recovery = proxyActivities<Pick<typeof activities, "settleKnowledgeQueryUnknown">>({
    taskQueue: input.baseTaskQueue, startToCloseTimeout: "1 minute",
    retry: { initialInterval: "1 second", maximumInterval: "30 seconds" },
  });
  try { return await dispatch.executeKnowledgeQuery(input); }
  catch {
    await recovery.settleKnowledgeQueryUnknown(input);
    throw ApplicationFailure.nonRetryable("Knowledge query outcome is unknown", "KNOWLEDGE_QUERY_OUTCOME_UNKNOWN");
  }
}

const indexing = proxyActivities<Pick<typeof activities, "indexKnowledge">>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

/** Rebuild derived search projections; this is not a source-ingestion task. */
export async function knowledgeIndexingWorkflow(): Promise<void> {
  await indexing.indexKnowledge();
}
