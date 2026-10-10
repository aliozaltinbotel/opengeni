import type { AccessGrant, KnowledgeEntryScope, Permission } from "@opengeni/contracts";
import type { KnowledgeContext } from "@opengeni/db";
import { hasPermission, requireNativeAccessContinuationAuthority, type AccessGrantAuthorization } from "../access";
import type { Settings } from "@opengeni/config";
import { requireLiveAgentAttemptAuthorization } from "../session-authorization";
import type { ApiRouteDeps } from "../dependencies";
import { HTTPException } from "hono/http-exception";
import { requireExternalContinuationAuthority } from "../application/external-continuation";
import { findActiveWorkspaceApiKeyById, getWorkspaceGrant, lockExternalWorkspaceMembershipLifecycle, withWorkspaceSubjectRls, type Database } from "@opengeni/db";
import type { KnowledgeQueryWorkflowRequest } from "../dependencies";

/** Revalidate the installed principal's exact current authority in the short
 * admission/settlement transaction. Frozen audit metadata is not a credential. */
export async function authorizeKnowledgeQueryOwner(tx: Database, input: Pick<KnowledgeQueryWorkflowRequest, "context" | "grant" | "externalContinuation" | "nativeContinuation">, settings?: Settings, permission: Permission = "documents:search"): Promise<void> {
  const { context, grant, externalContinuation, nativeContinuation } = input;
  if (grant.accountId !== context.accountId || grant.workspaceId !== context.workspaceId || !hasPermission(grant.permissions, permission, grant.permissionMode))
    throw new Error("KNOWLEDGE_QUERY_AUTHORITY_UNAVAILABLE");
  if (context.actor.kind === "agent") {
    const current = await requireLiveAgentAttemptAuthorization(tx, grant, context.actor.sessionId);
    if (current.turnId !== context.actor.turnId || current.attemptId !== context.actor.attemptId || current.executionGeneration !== context.actor.executionGeneration)
      throw new Error("KNOWLEDGE_QUERY_AUTHORITY_UNAVAILABLE");
    return;
  }
  if (grant.subjectId !== context.actor.subjectId) throw new Error("KNOWLEDGE_QUERY_AUTHORITY_UNAVAILABLE");
  if (externalContinuation) {
    await requireExternalContinuationAuthority(tx, externalContinuation, { ...context, subjectId: grant.subjectId }, permission);
    return;
  }
  const keyId = /^api_key:([0-9a-f-]{36})$/i.exec(grant.subjectId)?.[1];
  if (keyId) {
    const key = await findActiveWorkspaceApiKeyById(tx, { ...context, apiKeyId: keyId });
    if (!key || !hasPermission(key.permissions, permission, key.permissionMode)) throw new Error("KNOWLEDGE_QUERY_AUTHORITY_UNAVAILABLE");
    return;
  }
  if (grant.principalKind === "configured_key" || grant.principalKind === "service" || grant.metadata?.delegated === true) {
    if (!nativeContinuation || !settings) throw new Error("KNOWLEDGE_QUERY_AUTHORITY_UNAVAILABLE");
    await requireNativeAccessContinuationAuthority(tx, settings, nativeContinuation, grant, permission);
    return;
  }
  if (context.actor.kind !== "human") throw new Error("KNOWLEDGE_QUERY_AUTHORITY_UNAVAILABLE");
  await lockExternalWorkspaceMembershipLifecycle(tx, context.accountId);
  const current = await withWorkspaceSubjectRls(tx, context.workspaceId, grant.subjectId,
    scoped => getWorkspaceGrant(scoped, grant.subjectId, context.workspaceId, { accountId: context.accountId, lock: "share" }));
  if (!current || current.accountId !== context.accountId || !hasPermission(current.permissions, permission, current.permissionMode))
    throw new Error("KNOWLEDGE_QUERY_AUTHORITY_UNAVAILABLE");
}

/** A delegated MCP gateway can retrieve shared Knowledge. Its subject label
 * does not establish personal ownership or human review authority. */
export async function knowledgeContextForGateway(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
): Promise<KnowledgeContext> {
  if (!hasPermission(grant.permissions, "documents:search"))
    throw new HTTPException(403, { message: "Missing permission: documents:search" });
  if (grant.principalKind === "agent_attempt") {
    const sessionId = grant.metadata?.sessionId;
    if (typeof sessionId !== "string")
      throw new HTTPException(403, { message: "Knowledge attempt unavailable" });
    const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "agent",
        sessionId: attempt.callerSessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
    };
  }
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "service",
      principalKind: "mcp_gateway",
      subjectId: grant.subjectId,
      writeScopes: [],
      review: false,
      settingsScopes: [],
    },
  };
}

/** One host boundary for HTTP, SDK-through-HTTP and first-party Knowledge tools. */
export async function knowledgeContextForAccess(
  deps: Pick<ApiRouteDeps, "db">,
  access: AccessGrantAuthorization,
  permission: Permission,
): Promise<KnowledgeContext> {
  const { grant } = access;
  if (!hasPermission(grant.permissions, permission)) {
    throw new HTTPException(403, { message: `Missing permission: ${permission}` });
  }
  if (grant.principalKind === "agent_attempt") {
    const sessionId = grant.metadata?.sessionId;
    if (typeof sessionId !== "string")
      throw new HTTPException(403, { message: "Knowledge attempt unavailable" });
    const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "agent",
        sessionId: attempt.callerSessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
    };
  }
  if (
    grant.principalKind === "service" ||
    grant.principalKind === "api_key" ||
    grant.principalKind === "configured_key"
  ) {
    const writeScopes: Array<"workspace" | "organization"> = hasPermission(
      grant.permissions,
      "documents:manage",
    )
      ? ["workspace"]
      : [];
    if (writeScopes.length && access.accountGrant?.permissions.includes("account:admin"))
      writeScopes.push("organization");
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "service",
        principalKind: grant.principalKind,
        subjectId: grant.subjectId,
        writeScopes,
        review: false,
        settingsScopes: [],
      },
    };
  }
  if (
    grant.principalKind !== "human_session" ||
    !access.contextIntegrity ||
    access.authenticatedSubjectId !== grant.subjectId ||
    grant.serviceInitiator ||
    grant.serviceInitiatorContext ||
    grant.metadata?.attemptId !== undefined ||
    grant.metadata?.turnId !== undefined
  ) {
    throw new HTTPException(403, {
      message: "Knowledge management requires an authenticated human or agent attempt",
    });
  }
  const canWrite = hasPermission(grant.permissions, "documents:manage");
  const writeScopes: KnowledgeEntryScope[] = canWrite ? ["workspace", "personal"] : [];
  // Organization authority does not follow from the workspace-admin wildcard.
  if (canWrite && access.accountGrant?.permissions.includes("account:admin"))
    writeScopes.push("organization");
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: access.authenticatedSubjectId,
      writeScopes,
      review: canWrite,
      settingsScopes: [
        "personal",
        ...(hasPermission(grant.permissions, "workspace:admin") ? ["workspace" as const] : []),
      ],
    },
  };
}
