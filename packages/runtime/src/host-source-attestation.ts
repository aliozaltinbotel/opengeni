import { AsyncLocalStorage } from "node:async_hooks";
import { NATIVE_HOST_SOURCE_HEADER, signDelegatedAccessToken, type ModelCallSourceReceipt, type ToolGatewayIdentity } from "@opengeni/contracts";
import { firstPartyMcpInternalWorkspaceUrl, firstPartyMcpWorkspaceUrl, resolveFirstPartyDelegationSecret, type Settings } from "@opengeni/config";
import { digestCanonicalJson, type ToolGatewayExecutionContext } from "@opengeni/tool-gateway";
import { nativeModelSourceKeyForToolCall } from "./model-request-capture";

type AttemptScope = Pick<ModelCallSourceReceipt, "accountId" | "workspaceId" | "sessionId" | "turnId" | "attemptId" | "executionGeneration">;
type Invocation = Readonly<{ scope: AttemptScope; subjectId: string; connectionSubjectId: string; sourceKey: string; sourceCallId: string; operationId: string; identity: ToolGatewayIdentity; wireToolName: string; inputSha256: string }>;
// Private, invocation-local propagation to the actual HTTP request, never registration state.
const invocation = new AsyncLocalStorage<Invocation>();

export function withNativeHostSourceInvocation<T>(
  scope: AttemptScope | undefined, subjectId: string | undefined, connectionSubjectId: string | undefined, context: ToolGatewayExecutionContext,
  identity: ToolGatewayIdentity | undefined, wireToolName: string, args: Record<string, unknown>, operation: () => T,
): T {
  const sourceKey = nativeModelSourceKeyForToolCall(context.sourceCallId);
  if (!scope || !subjectId || !identity || !["model", "codemode"].includes(context.caller.kind)) return operation();
  // Exact source ownership comes from native's request-local output owner, not context/transport claims.
  if (!connectionSubjectId || !sourceKey || !context.sourceCallId || sourceKey !== context.nativeModelSourceKey) throw new Error("HOST_SOURCE_ORIGINAL_CALL_UNAVAILABLE");
  return invocation.run(Object.freeze({ scope: Object.freeze({ ...scope }), subjectId, connectionSubjectId, sourceKey,
    sourceCallId: context.sourceCallId, operationId: context.operationId, identity: Object.freeze({ ...identity }),
    wireToolName, inputSha256: digestCanonicalJson(args) }), operation);
}

export function nativeHostToolIdentity(meta: unknown): ToolGatewayIdentity | undefined {
  if (!meta || typeof meta !== "object" || !("opengeni/identity" in meta)) return undefined;
  const value = meta["opengeni/identity"];
  if (!value || typeof value !== "object" || !("serverId" in value) || !("toolName" in value)
    || typeof value.serverId !== "string" || !value.serverId || typeof value.toolName !== "string" || !value.toolName) return undefined;
  return { serverId: value.serverId, toolName: value.toolName };
}

export function ownsNativeHostSourceDestination(settings: Settings, scope: AttemptScope, resource: string): boolean {
  const candidates = [firstPartyMcpWorkspaceUrl(settings, scope.workspaceId), firstPartyMcpInternalWorkspaceUrl(settings, scope.workspaceId)];
  if (settings.publicBaseUrl) candidates.push(new URL(`/v1/workspaces/${scope.workspaceId}/mcp`, settings.publicBaseUrl).href);
  return candidates.some(candidate => new URL(candidate).href === resource);
}

/** Existing OAuth credential remains Authorization. This separate delegation purpose is evidence only. */
export async function nativeHostSourceRequestInit(settings: Settings, input: string | URL | Request, init?: RequestInit): Promise<RequestInit | undefined> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.delete(NATIVE_HOST_SOURCE_HEADER);
  const current = invocation.getStore();
  const resource = new URL(input instanceof Request ? input.url : String(input)).href;
  if (!current || !ownsNativeHostSourceDestination(settings, current.scope, resource)) return { ...init, headers };
  const body = typeof init?.body === "string" ? init.body : input instanceof Request && !init?.body ? await input.clone().text() : undefined;
  if (body === undefined) throw new Error("HOST_SOURCE_TRANSPORT_UNAVAILABLE");
  let request: unknown;
  try { request = JSON.parse(body); } catch { throw new Error("HOST_SOURCE_TRANSPORT_UNAVAILABLE"); }
  if (!request || typeof request !== "object" || !("method" in request) || request.method !== "tools/call") return { ...init, headers };
  if (!("params" in request) || !request.params || typeof request.params !== "object" || !("name" in request.params)) throw new Error("HOST_SOURCE_TARGET_MISMATCH");
  const args = "arguments" in request.params ? request.params.arguments : {};
  if (request.params.name !== current.wireToolName || digestCanonicalJson(args) !== current.inputSha256) throw new Error("HOST_SOURCE_TARGET_MISMATCH");
  const authorization = headers.get("authorization");
  // A native first-party bearer can never replace the separately consented host connection.
  if (!authorization?.startsWith("Bearer ogmcp_at_")) throw new Error("HOST_SOURCE_OAUTH_REQUIRED");
  const secret = resolveFirstPartyDelegationSecret(settings);
  if (!secret) throw new Error("HOST_SOURCE_AUTHORITY_UNAVAILABLE");
  headers.set(NATIVE_HOST_SOURCE_HEADER, await signDelegatedAccessToken(secret, {
    ...current.scope, subjectId: current.subjectId, principalKind: "agent_attempt", permissions: ["workspace:read"],
    exp: Math.floor(Date.now() / 1000) + 60,
    hostSource: { purpose: "HOST_SOURCE", resource: settings.publicBaseUrl
      ? new URL(`/v1/workspaces/${current.scope.workspaceId}/mcp`, settings.publicBaseUrl).href : resource, ...current.identity, wireToolName: current.wireToolName,
      nativeModelSourceKey: current.sourceKey, sourceCallId: current.sourceCallId, operationId: current.operationId,
      inputSha256: current.inputSha256, credentialSha256: digestCanonicalJson(authorization), connectionSubjectId: current.connectionSubjectId },
  }));
  return { ...init, headers };
}
