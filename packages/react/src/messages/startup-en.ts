/** Synchronous copy used before any workspace or session route is loaded. */
export const startupEnglishMessages = {
  "formDialog.cancel": "Cancel",
  "formDialog.working": "Working…",
  "organizationModel.orgShortaccountid": "Org {shortAccountId}",
  "lib.format.reconcileBeforeRetry":
    "This client cannot safely retry this uncertain request after remount; reconcile the session before sending again.",
  "lib.format.thisClientCannotResumeThe":
    "This client cannot resume the workspace. Ask your administrator for a control-capable client.",
  "lib.format.modelUnavailable":
    "This chat's model is no longer available. Choose another model to continue. Your message is saved.",
  "lib.format.accountUnavailable":
    "A selected connector account is unavailable. Review accounts in + → Connectors, then edit and send your saved message.",
  "lib.format.sessionUsageLimitReached":
    "This task's usage limit is reached. Your message is saved.",
  "lib.format.thisSiteSAssistantCan":
    "This Site's assistant can't do that for you. Your message is saved.",
  "lib.format.thisSiteSAssistantHas":
    "This Site's assistant has reached its usage limit for now. Your message is saved.",
  "lib.format.thisSiteSAssistantIs":
    "This Site's assistant is busy. Try again in a moment. Your message is saved.",
  "lib.format.thisSiteSAssistantIs2":
    "This Site's assistant is paused for visitors right now. Your message is saved.",
  "lib.format.workspaceUsageLimitReachedAn":
    "Workspace usage limit reached. An organization admin can raise the workspace budget. Your draft is preserved.",
  "lib.format.usageLimitReachedAWorkspace":
    "Usage limit reached. A workspace admin can raise this limit. Your draft is preserved.",
  "lib.format.messageReferenceCorrelationid": "{message} Reference: {correlationId}.",
  "lib.format.yourOrganizationDoesnTHave":
    "Your remaining credits don't cover this model. Choose a model they cover or add credits. Your message and attachments are saved.",
} as const;
