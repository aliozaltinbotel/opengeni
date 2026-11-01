import { createHash } from "node:crypto";
import { ModelCallSourceBasisResponse, NATIVE_HOST_SOURCE_HEADER, canonicalModelSourceJson, verifyHostSourceAttestation, type AccessGrant, type NativeHostSourceContext, type ToolGatewayCatalogEntry } from "@opengeni/contracts";
import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import { digestCanonicalJson } from "@opengeni/tool-gateway";
import { readModelCallSourceReceipt } from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
import { requireLiveAgentAttemptGrant } from "./access-grant-rls";

export type NativeHostSourceVerifier = (entry: ToolGatewayCatalogEntry, args: Record<string, unknown>) => Promise<NativeHostSourceContext>;
type Owners = Readonly<{
  currentAttempt(grant: AccessGrant): Promise<void>;
  currentConnection(entry: ToolGatewayCatalogEntry): Promise<void>;
  readReceipt(scope: Parameters<typeof readModelCallSourceReceipt>[1]): Promise<unknown>;
}>;
function refuse(): never { throw new HTTPException(403, { message: "native host source attestation refused" }); }

/** Normal connection authority is required independently; this proof grants no tool permission. */
export function nativeHostSourceVerifier(deps: Pick<ApiRouteDeps, "db" | "settings">, grant: AccessGrant, request: Request, owners: Owners = {
  currentAttempt: async attempt => await requireLiveAgentAttemptGrant(deps, attempt),
  currentConnection: async entry => {
    const { resolveMcpOAuthRouteAccess } = await import("./mcp-oauth");
    const current = await resolveMcpOAuthRouteAccess(deps, request, grant.workspaceId);
    if (!current || current.grant.accountId !== grant.accountId || current.grant.workspaceId !== grant.workspaceId
      || current.grant.subjectId !== grant.subjectId || grant.permissions.some(permission => !current.grant.permissions.includes(permission))
      || !current.allowedToolIdentities.some(identity => identity.serverId === entry.identity.serverId && identity.toolName === entry.identity.toolName)) refuse();
  },
  readReceipt: async scope => await readModelCallSourceReceipt(deps.db, scope),
}): NativeHostSourceVerifier | undefined {
  const token = request.headers.get(NATIVE_HOST_SOURCE_HEADER);
  if (token === null) return undefined;
  return async (entry, args) => {
    if (grant.principalKind !== "human_session" || grant.metadata?.mcpOAuth !== true) refuse();
    const secret = resolveFirstPartyDelegationSecret(deps.settings);
    const payload = secret ? await verifyHostSourceAttestation(secret, token) : null;
    if (!payload || !payload.sessionId || !payload.turnId || !payload.attemptId || !payload.executionGeneration) refuse();
    const source = payload.hostSource;
    if (payload.accountId !== grant.accountId || payload.workspaceId !== grant.workspaceId || source.connectionSubjectId !== grant.subjectId
      || source.resource !== (deps.settings.publicBaseUrl ? new URL(`/v1/workspaces/${grant.workspaceId}/mcp`, deps.settings.publicBaseUrl).href : request.url)
      || new URL(request.url).pathname !== `/v1/workspaces/${grant.workspaceId}/mcp` || source.serverId !== entry.identity.serverId || source.toolName !== entry.identity.toolName
      || source.wireToolName !== entry.modelName || source.inputSha256 !== digestCanonicalJson(args)
      || source.credentialSha256 !== digestCanonicalJson(request.headers.get("authorization"))) refuse();
    const attempt: AccessGrant = { accountId: payload.accountId, workspaceId: payload.workspaceId, subjectId: payload.subjectId,
      permissions: payload.permissions, principalKind: "agent_attempt", metadata: { delegated: true,
        sessionId: payload.sessionId, turnId: payload.turnId, attemptId: payload.attemptId, executionGeneration: payload.executionGeneration } };
    await owners.currentAttempt(attempt);
    const receipt = ModelCallSourceBasisResponse.parse(await owners.readReceipt({ accountId: payload.accountId,
      workspaceId: payload.workspaceId, sessionId: payload.sessionId, sourceKey: source.nativeModelSourceKey })).receipt;
    if (!receipt || receipt.accountId !== payload.accountId || receipt.workspaceId !== payload.workspaceId || receipt.sessionId !== payload.sessionId
      || receipt.turnId !== payload.turnId || receipt.attemptId !== payload.attemptId || receipt.executionGeneration !== payload.executionGeneration
      || receipt.sourceKey !== source.nativeModelSourceKey || receipt.purpose !== "AGENT" || !receipt.complete || receipt.incompleteReasons.length
      || receipt.inputs.length === 0 || receipt.closure.length === 0) refuse();
    const { digest, ...body } = receipt;
    // Same canonical hashing owner as producer/validatedStoredModelCallSourceReceipt.
    if (createHash("sha256").update(canonicalModelSourceJson(body), "utf8").digest("hex") !== digest) refuse();
    await owners.currentConnection(entry);
    await owners.currentAttempt(attempt);
    return Object.freeze({ accountId: receipt.accountId, workspaceId: receipt.workspaceId, sessionId: receipt.sessionId,
      turnId: receipt.turnId, attemptId: receipt.attemptId, executionGeneration: receipt.executionGeneration,
      nativeModelSourceKey: receipt.sourceKey, requestIndex: receipt.requestIndex, receiptId: receipt.id, receiptDigest: receipt.digest,
      sourceCallId: source.sourceCallId, operationId: source.operationId, serverId: source.serverId, toolName: source.toolName, inputSha256: source.inputSha256 });
  };
}
