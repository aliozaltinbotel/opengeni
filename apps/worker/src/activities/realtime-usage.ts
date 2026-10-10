import { randomBytes } from "node:crypto";
import { heartbeat } from "@temporalio/activity";
import { CODEX_CLIENT_VERSION, codexSubscriptionHeaders } from "@opengeni/codex";
import type { ModelCallOutcome, ReadRealtimeSessionUsageSource } from "@opengeni/contracts";
import { createRealtimeVoiceBilling } from "@opengeni/core";
import { buildCodexTokenResolver, existingUsageEventIdempotencyKeys, isTransactionHandle,
  loadRealtimeSessionUsageSource, recordUsageEvent } from "@opengeni/db";
import type { ControlActivityServices, RealtimeUsageInput } from "./types";

type Observation = { action: "waiting" } | { action: "closed"; outcome: ModelCallOutcome };
type ObserverInput = { url: string; headers: Record<string, string>; source: ReadRealtimeSessionUsageSource;
  previouslyAttached: boolean; onAttached: () => Promise<void>; heartbeat: () => void };

/** Only authenticated messages on the exact existing provider session are
 * considered. An observer disconnect is never a session close. */
export async function observeRealtimeSession(input: ObserverInput): Promise<Observation> {
  const NativeWebSocket = WebSocket as unknown as new (url: string,
    options: { headers: Record<string, string> }) => WebSocket;
  const result = await new Promise<Observation>((resolve, reject) => {
    const socket = new NativeWebSocket(input.url, { headers: input.headers });
    let settled = false;
    let finalObserved = false;
    let attachment: Promise<void> = Promise.resolve();
    const finish = (value: Observation, error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(pulse); socket.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish({ action: "waiting" }), 30_000);
    const pulse = setInterval(() => {
      try { input.heartbeat(); } catch (error) { finish({ action: "waiting" }, error); }
    }, 5_000);
    socket.onopen = () => {
      attachment = input.onAttached();
      void attachment.catch(error => finish({ action: "waiting" }, error));
    };
    socket.onmessage = event => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== "object") return;
      const closed = message as { type?: unknown; reason?: unknown };
      // This provider event is defined by Azure GPT Live. Do not ascribe its
      // semantics to other providers merely because their JSON resembles it.
      if (input.source.provider !== "azure-live" || closed.type !== "session.closed") return;
      finalObserved = true;
      const outcome: ModelCallOutcome = closed.reason === "content" ? "failed"
        : closed.reason === "connection_lost" ? "indeterminate"
        : ["close_requested", "expired", "remote_hangup"].includes(String(closed.reason))
          ? "completed" : "indeterminate";
      void attachment.then(() => finish({ action: "closed", outcome }), error => finish({ action: "waiting" }, error));
    };
    socket.onerror = () => { if (!finalObserved) finish({ action: "waiting" }); };
    socket.onclose = () => { if (!finalObserved) finish({ action: "waiting" }); };
  });
  if (result.action === "closed" || !input.previouslyAttached || input.source.provider !== "codex-subscription") return result;
  // Bun's WebSocket error does not expose the actual handshake HTTP status.
  // Read it independently; a previously authenticated attachment is mandatory.
  try {
    const response = await fetch(input.url.replace(/^wss:/, "https:"), { method: "GET", redirect: "error",
      signal: AbortSignal.timeout(5_000), headers: { ...input.headers, Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") } });
    const status = response.status;
    await response.body?.cancel();
    if (status === 404 || status === 410) return { action: "closed", outcome: "indeterminate" };
  } catch { /* Active upgrade, transport failure and timeout remain unknown. */ }
  return { action: "waiting" };
}

export function createRealtimeUsageActivities(services: () => Promise<ControlActivityServices>, options: {
  observe?: (input: ObserverInput) => Promise<Observation>;
  heartbeat?: () => void;
} = {}) {
  async function observeRealtimeSessionUsage(input: RealtimeUsageInput): Promise<{ action: "terminal" } | { action: "waiting"; delayMs: number }> {
    const { db, settings } = await services();
    if (isTransactionHandle(db)) throw new Error("REALTIME_USAGE_REQUIRES_ROOT_DATABASE");
    const source = await loadRealtimeSessionUsageSource(db, input);
    if (!source) throw new Error("REALTIME_PROVIDER_SOURCE_UNBOUND");
    const finalKey = `usage:model.call:realtime:${input.connectionId}`;
    const attachedKey = `usage:model.realtime.session.attached:${input.connectionId}`;
    const keys = await existingUsageEventIdempotencyKeys(db, { ...input, keys: [finalKey, attachedKey] });
    if (keys.has(finalKey)) return { action: "terminal" };
    const waiting = { action: "waiting", delayMs: 30_000 } as const;
    if (!source.source.providerSessionId) return waiting;
    let url: string;
    let headers: Record<string, string>;
    if (source.source.provider === "codex-subscription" && source.source.providerCredentialId) {
      // Resolve the exact credential which created this provider occurrence,
      // including its current revocation fence; never choose another account.
      let token;
      try { token = await buildCodexTokenResolver(db, settings, input.workspaceId, source.source.providerCredentialId).getToken(); }
      catch { return waiting; }
      headers = codexSubscriptionHeaders({ ...token, clientVersion: CODEX_CLIENT_VERSION });
      url = `wss://api.openai.com/v1/live/${encodeURIComponent(source.source.providerSessionId)}`;
    } else if (source.source.provider === "azure-live" && settings.azureLiveEndpoint && settings.azureLiveApiKey) {
      url = `${settings.azureLiveEndpoint.replace(/\/+$/, "").replace(/^https:/, "wss:")}/openai/v1/live/sessions/${encodeURIComponent(source.source.providerSessionId)}/attach`;
      headers = { "api-key": settings.azureLiveApiKey };
    } else return waiting;
    const result = await (options.observe ?? observeRealtimeSession)({ url, headers, source: source.source,
      previouslyAttached: keys.has(attachedKey), heartbeat: options.heartbeat ?? (() => heartbeat()),
      onAttached: async () => {
        await recordUsageEvent(db, { ...input, eventType: "model.realtime.session.attached", quantity: 1, unit: "session",
          sourceResourceType: "model_realtime_session", sourceResourceId: input.connectionId, idempotencyKey: attachedKey,
          attributes: source.source });
      } });
    // A physically closed connection without final accounting evidence leaves
    // the final key free. Keep the durable observer alive for a later receipt.
    if (result.action === "waiting" || result.outcome === "indeterminate") return waiting;
    await createRealtimeVoiceBilling({ db, settings }).recordProviderSessionFinal({ ...input, source: source.source, outcome: result.outcome });
    return { action: "terminal" };
  }
  return { observeRealtimeSessionUsage };
}
