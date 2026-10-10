import { resolveFirstPartyDelegationSecret } from "@opengeni/config";
import { authorizeKnowledgeQueryOwner, createRealtimeVoiceBilling,
  externalActorContinuationForAuthorization, nativeAccessContinuationForAuthorization,
  knowledgeContextForAccess, type AccessGrantAuthorization, type ApiRouteDeps } from "@opengeni/core";
import { loadRealtimeSessionUsageSource } from "@opengeni/db";
import { createInteractionFrameProxyAttachment, INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX,
  type RealtimeProxyLifecycle, type RealtimeProxySource } from "./interaction-frame-proxy";

/** Reuse an installed deployment encryption/delegation key. The relay does not
 * create an authentication issuer or expose an upstream client secret. */
export function realtimeProxyRootSecret(deps: Pick<ApiRouteDeps, "settings">): string | undefined {
  return resolveFirstPartyDelegationSecret(deps.settings) ?? deps.settings.environmentsEncryptionKey;
}

export async function realtimeProxyAuthority(deps: ApiRouteDeps, authorization: AccessGrantAuthorization): Promise<RealtimeProxySource["authority"]> {
  return { context: await knowledgeContextForAccess(deps, authorization, "sessions:control"), grant: authorization.grant,
    externalContinuation: externalActorContinuationForAuthorization(authorization),
    nativeContinuation: nativeAccessContinuationForAuthorization(authorization) };
}

export async function createRealtimeUsageProxyAttachment(input: {
  deps: ApiRouteDeps; authorization: AccessGrantAuthorization; request: Request;
  sessionId: string; connectionId: string; connectionEpoch: number;
  provider: "ai-gateway" | "xai-subscription"; model: string;
  secret: { url: string; token: string; upstreamModelId: string; expiresAt: number | null };
}): Promise<{ url: string; token: string }> {
  const { deps, secret, authorization } = input;
  const rootSecret = realtimeProxyRootSecret(deps);
  if (!rootSecret) throw new Error("REALTIME_PROXY_AUTHORITY_UNAVAILABLE");
  const source: RealtimeProxySource = {
    authority: await realtimeProxyAuthority(deps, authorization),
    sessionId: input.sessionId,
    source: { connectionId: input.connectionId, connectionEpoch: input.connectionEpoch,
      provider: input.provider, providerSessionId: null, providerCredentialId: null,
      model: input.model, upstreamModel: secret.upstreamModelId },
  };
  const attachment = createInteractionFrameProxyAttachment({ requestUrl: input.request.url,
    publicBaseUrl: deps.settings.publicBaseUrl, webBaseUrl: deps.settings.webBaseUrl,
    rootSecret, upstreamUrl: secret.url,
    upstreamProtocols: input.provider === "ai-gateway" ? ["ai-gateway-realtime.v1", `ai-gateway-auth.${secret.token}`]
      : [`xai-client-secret.${secret.token}`],
    origin: input.request.headers.get("origin"),
    // This is only the native attachment grant's lifetime. Mint is not occurrence.
    expiresAt: new Date(Math.min(secret.expiresAt ?? Date.now() + 60_000, Date.now() + 60_000)).toISOString(),
    realtime: source,
  });
  return { url: attachment.url, token: attachment.protocols[1]!.slice(INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX.length) };
}

/** Actual provider messages on the one owned socket supply occurrence/final
 * evidence. Browser frames, credential mint and response-done never do. */
export function createRealtimeUsageProxyLifecycle(deps: ApiRouteDeps): RealtimeProxyLifecycle {
  const scope = (value: RealtimeProxySource) => ({ accountId: value.authority.grant.accountId,
    workspaceId: value.authority.grant.workspaceId, sessionId: value.sessionId,
    connectionId: value.source.connectionId });
  return {
    beforeDispatch: async (value, ownerId) => {
      await createRealtimeVoiceBilling(deps).recordProviderSessionDispatch({ ...scope(value), ownerId, source: value.source,
        authorize: tx => authorizeKnowledgeQueryOwner(tx, value.authority,
          deps.catalogSourceSettings ?? deps.settings, "sessions:control") });
    },
    observe: async (value, message) => {
      const billing = createRealtimeVoiceBilling(deps);
      const gateway = value.source.provider === "ai-gateway";
      const started = gateway ? message.type === "session-started" : message.type === "session.created";
      if (started) {
        const nativeSession = message.session && typeof message.session === "object"
          ? message.session as Record<string, unknown> : null;
        const identifier = gateway ? message.sessionId : nativeSession?.id;
        if (gateway && (typeof identifier !== "string" || identifier.length === 0)) throw new Error("REALTIME_PROVIDER_SESSION_ID_MISSING");
        await billing.recordProviderSessionOccurrence({ ...scope(value), source: { ...value.source,
          providerSessionId: typeof identifier === "string" && identifier.length > 0 ? identifier : null } });
        if (!deps.workflowClient.startRealtimeUsageObservation) throw new Error("REALTIME_USAGE_WORKFLOW_UNAVAILABLE");
        await deps.workflowClient.startRealtimeUsageObservation(scope(value));
        return;
      }
      if (!gateway || message.type !== "session-closed") return;
      const source = await loadRealtimeSessionUsageSource(deps.db, scope(value));
      if (!source || source.source.provider !== value.source.provider ||
        (typeof message.sessionId === "string" && source.source.providerSessionId !== message.sessionId)) throw new Error("REALTIME_PROVIDER_SOURCE_UNBOUND");
      // Gateway's normalized close supplies final duration, not final token
      // pools or a realized provider price. Its free-text reason is not a
      // documented success enum, so it cannot establish completed execution.
      await billing.recordProviderSessionFinal({ ...scope(value), source: source.source, outcome: "indeterminate" });
    },
    closed: async (value, ownerId) => {
      await createRealtimeVoiceBilling(deps).recordProviderConnectionClosed({ ...scope(value), ownerId });
    },
  };
}
