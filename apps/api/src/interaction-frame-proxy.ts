import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { canonicalPublicOrigin } from "@opengeni/config";
import { AccessGrant, RealtimeSessionUsageSource, REALTIME_SESSION_SOURCE_SCHEMA } from "@opengeni/contracts";
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import type { KnowledgeQueryWorkflowRequest } from "@opengeni/core";
import { WebSocket as UpstreamWebSocket } from "ws";
import type {
  ApiWebSocketConnection,
  ApiWebSocketLike,
  ApiWebSocketUpgradeServer,
} from "./api-websocket";

export const INTERACTION_FRAME_PROXY_PATH = "/v1/interaction/frame-proxy";
export const INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX = "opengeni-frame-proxy.";

const TOKEN_VERSION = 1;
const TOKEN_IV_BYTES = 12;
const TOKEN_TAG_BYTES = 16;
const TOKEN_MAX_BYTES = 8 * 1024;
const TOKEN_KEY_CONTEXT = "OpenGeni interaction frame proxy v1";
const MAX_QUEUED_MESSAGES = 64;
const MAX_QUEUED_BYTES = 12 * 1024 * 1024;

type ProxyGrant = Readonly<{
  version: 1;
  upstreamUrl: string;
  upstreamProtocols: readonly string[];
  responseProtocol: string;
  origin: string | null;
  expiresAt: number;
  realtime?: RealtimeProxySource;
}>;

/** Signed/encrypted server-origin continuation, never a public query field. */
export type RealtimeProxySource = {
  authority: Pick<KnowledgeQueryWorkflowRequest, "context" | "grant" | "externalContinuation" | "nativeContinuation">;
  sessionId: string;
  source: Omit<RealtimeSessionUsageSource, "schema" | "billingPath">;
};
export type RealtimeProxyLifecycle = {
  beforeDispatch: (source: RealtimeProxySource, ownerId: string) => Promise<void>;
  observe: (source: RealtimeProxySource, message: Record<string, unknown>) => Promise<void>;
  closed: (source: RealtimeProxySource, ownerId: string) => Promise<void>;
};

export type InteractionFrameProxyAttachment = Readonly<{
  url: string;
  protocols: readonly string[];
}>;

/** Docker boxes cannot carry browserd's WebSocket subprotocol grant to the
 * viewer. Unsigned OpenSandbox Channel B still uses the lifecycle proxy, so
 * it needs the same hatch. Signed URI-mode ingress keeps native subprotocols;
 * `openSandboxInteractionFrameProxy` is an emergency override only. */
export function placementUsesInteractionFrameProxy(
  backend: string | null | undefined,
  options?: {
    openSandboxSignedEndpoints?: boolean;
    openSandboxInteractionFrameProxy?: boolean;
  },
): boolean {
  if (backend === "docker") return true;
  if (backend !== "opensandbox") return false;
  if (typeof options?.openSandboxInteractionFrameProxy === "boolean") {
    return options.openSandboxInteractionFrameProxy;
  }
  return options?.openSandboxSignedEndpoints !== true;
}

/** Public origin the browser can open. TLS-terminating reverse proxies make
 * `requestUrl` `http://127.0.0.1` / the API container; that would mint `ws://`
 * and Chrome blocks it from an `https://` console. */
export function resolveInteractionFrameProxyRequestUrl(input: {
  requestUrl: string;
  publicBaseUrl?: string | undefined;
  webBaseUrl?: string | undefined;
  forwardedProto?: string | null | undefined;
  forwardedHost?: string | null | undefined;
}): string {
  const publicOrigin =
    canonicalPublicOrigin(input.publicBaseUrl) ??
    (input.webBaseUrl?.startsWith("https://") ? canonicalPublicOrigin(input.webBaseUrl) : null);
  if (publicOrigin) return `${publicOrigin}/`;
  const request = new URL(input.requestUrl);
  const forwardedProto = firstForwardedValue(input.forwardedProto)?.toLowerCase();
  const protocol =
    forwardedProto === "https" ? "https:" : forwardedProto === "http" ? "http:" : request.protocol;
  const forwardedHost = firstForwardedValue(input.forwardedHost);
  const host = forwardedHost && isSafeForwardedHost(forwardedHost) ? forwardedHost : request.host;
  try {
    return new URL(`${protocol}//${host}/`).toString();
  } catch {
    return request.toString();
  }
}

export function createInteractionFrameProxyAttachment(input: {
  requestUrl: string;
  publicBaseUrl?: string | undefined;
  webBaseUrl?: string | undefined;
  forwardedProto?: string | null | undefined;
  forwardedHost?: string | null | undefined;
  rootSecret: string;
  upstreamUrl: string;
  upstreamProtocols: readonly string[];
  origin: string | null;
  expiresAt: string;
  realtime?: RealtimeProxySource;
}): InteractionFrameProxyAttachment {
  const grant = validateGrant({
    version: TOKEN_VERSION,
    upstreamUrl: input.upstreamUrl,
    upstreamProtocols: input.upstreamProtocols,
    responseProtocol: input.realtime ? "opengeni-realtime.v1" : input.upstreamProtocols[0] ?? "",
    origin: input.origin,
    expiresAt: Date.parse(input.expiresAt),
    ...(input.realtime ? { realtime: input.realtime } : {}),
  });
  const token = encryptGrant(grant, input.rootSecret);
  if (token.length > TOKEN_MAX_BYTES) throw new Error("WebSocket proxy grant is too large");
  const url = new URL(
    resolveInteractionFrameProxyRequestUrl({
      requestUrl: input.requestUrl,
      publicBaseUrl: input.publicBaseUrl,
      webBaseUrl: input.webBaseUrl,
      forwardedProto: input.forwardedProto,
      forwardedHost: input.forwardedHost,
    }),
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = INTERACTION_FRAME_PROXY_PATH;
  url.search = "";
  url.hash = "";
  return Object.freeze({
    url: url.toString(),
    protocols: Object.freeze([
      grant.responseProtocol,
      `${INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX}${token}`,
    ]),
  });
}

export class InteractionFrameProxyTransport {
  constructor(
    private readonly rootSecret: string | undefined,
    private readonly clock: () => number = Date.now,
    private readonly realtimeLifecycle?: RealtimeProxyLifecycle,
  ) {}

  handles(request: Request): boolean {
    return new URL(request.url).pathname === INTERACTION_FRAME_PROXY_PATH;
  }

  upgrade(request: Request, server: ApiWebSocketUpgradeServer): Response | undefined {
    if (!this.handles(request)) return undefined;
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
    }
    if (!this.rootSecret) return new Response("Service Unavailable", { status: 503 });
    const offered = offeredProtocols(request.headers.get("sec-websocket-protocol"));
    const proxyProtocol = offered.find((protocol) =>
      protocol.startsWith(INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX),
    );
    if (!proxyProtocol) return new Response("WebSocket proxy grant required", { status: 426 });
    let grant: ProxyGrant;
    try {
      grant = decryptGrant(
        proxyProtocol.slice(INTERACTION_FRAME_PROXY_PROTOCOL_PREFIX.length),
        this.rootSecret,
      );
    } catch {
      return new Response("Invalid WebSocket proxy grant", { status: 401 });
    }
    if (grant.expiresAt <= this.clock()) {
      return new Response("WebSocket proxy grant expired", { status: 401 });
    }
    if (!offered.includes(grant.responseProtocol)) {
      return new Response("WebSocket protocol required", { status: 426 });
    }
    const origin = normalizedOrigin(request.headers.get("origin"));
    if (origin !== grant.origin) {
      return new Response("WebSocket origin is not allowed", { status: 403 });
    }
    if (grant.realtime && !this.realtimeLifecycle) return new Response("Service Unavailable", { status: 503 });
    const connection = new InteractionFrameProxyConnection(grant, this.realtimeLifecycle);
    const upgraded = server.upgrade(request, {
      data: connection,
      headers: { "sec-websocket-protocol": grant.responseProtocol },
    });
    return upgraded ? undefined : new Response("Bad Request", { status: 400 });
  }
}

export class InteractionFrameProxyConnection implements ApiWebSocketConnection {
  private socket: ApiWebSocketLike | null = null;
  private upstream: UpstreamWebSocket | null = null;
  private upstreamOpen = false;
  private terminal = false;
  private queued: Array<Uint8Array | string> = [];
  private queuedBytes = 0;
  private observations: Promise<void> = Promise.resolve();
  private readonly ownerId = randomUUID();

  constructor(private readonly grant: ProxyGrant, private readonly lifecycle?: RealtimeProxyLifecycle) {}

  attach(socket: ApiWebSocketLike): void {
    if (this.socket || this.terminal) {
      socket.close(4400, "invalid connection state");
      return;
    }
    this.socket = socket;
    if (this.grant.realtime) {
      void this.lifecycle!.beforeDispatch(this.grant.realtime, this.ownerId).then(() => {
        if (!this.terminal) this.openUpstream();
      }, () => this.fail(4403, "realtime authority unavailable"));
    } else this.openUpstream();
  }

  private openUpstream(): void {
    let upstream: UpstreamWebSocket;
    try {
      upstream = new UpstreamWebSocket(this.grant.upstreamUrl, [...this.grant.upstreamProtocols], {
        ...(this.grant.origin ? { headers: { origin: this.grant.origin } } : {}),
      });
    } catch {
      this.fail(1011, "upstream unavailable");
      return;
    }
    this.upstream = upstream;
    upstream.binaryType = "arraybuffer";
    upstream.once("open", () => {
      if (this.terminal) {
        upstream.close(1000, "viewer closed");
        return;
      }
      this.upstreamOpen = true;
      for (const message of this.queued) upstream.send(typeof message === "string" ? message : webSocketBinary(message));
      this.queued = [];
      this.queuedBytes = 0;
    });
    upstream.on("message", (data, isBinary) => {
      if (this.terminal || !this.socket) return;
      if (this.grant.realtime) {
        if (isBinary) { this.fail(4400, "text frames required"); return; }
        const bytes = binaryMessage(data);
        if (!bytes) { this.fail(4400, "invalid realtime event"); return; }
        const text = new TextDecoder().decode(bytes);
        let message: unknown;
        try { message = JSON.parse(text); } catch { this.fail(4400, "invalid realtime event"); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { this.fail(4400, "invalid realtime event"); return; }
        this.observations = this.observations.then(async () => {
          await this.lifecycle!.observe(this.grant.realtime!, message as Record<string, unknown>);
          if (!this.terminal && this.socket && this.socket.send(text, false) <= 0) this.fail(1011, "stream unavailable");
        });
        void this.observations.catch(() => this.fail(1011, "realtime receipt unavailable"));
        return;
      }
      const bytes = binaryMessage(data);
      if (!bytes || this.socket.send(bytes, false) <= 0) {
        this.fail(1011, "stream unavailable");
      }
    });
    upstream.on("error", () => this.fail(1011, "upstream unavailable"));
    upstream.once("close", (code, reason) => {
      if (this.grant.realtime) {
        // Only the actual owned upstream close event supplies this proof. A
        // browser disconnect, timeout or absent process heartbeat does not.
        void this.observations.then(() => this.lifecycle!.closed(this.grant.realtime!, this.ownerId))
          .catch(() => this.fail(1011, "realtime receipt unavailable"));
      }
      this.fail(safeCloseCode(code), boundedReason(reason.toString("utf8")));
    });
  }

  receive(message: string | Uint8Array | ArrayBuffer): void {
    if (this.terminal) return;
    if (this.grant.realtime) {
      if (typeof message !== "string") { this.fail(4400, "text frames required"); return; }
      if (this.upstreamOpen && this.upstream) { this.upstream.send(message); return; }
      const bytes = Buffer.byteLength(message, "utf8");
      if (this.queued.length + 1 > MAX_QUEUED_MESSAGES || this.queuedBytes + bytes > MAX_QUEUED_BYTES) {
        this.fail(4409, "viewer is too fast"); return;
      }
      this.queued.push(message); this.queuedBytes += bytes; return;
    }
    if (typeof message === "string") {
      this.fail(4400, "binary frames required");
      return;
    }
    const bytes =
      message instanceof Uint8Array ? Uint8Array.from(message) : new Uint8Array(message).slice();
    if (this.upstreamOpen && this.upstream) {
      this.upstream.send(webSocketBinary(bytes));
      return;
    }
    if (
      this.queued.length + 1 > MAX_QUEUED_MESSAGES ||
      this.queuedBytes + bytes.byteLength > MAX_QUEUED_BYTES
    ) {
      this.fail(4409, "viewer is too fast");
      return;
    }
    this.queued.push(bytes);
    this.queuedBytes += bytes.byteLength;
  }

  transportClosed(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.upstream?.close(1000, "viewer closed");
    this.clear();
  }

  private fail(code: number, reason: string): void {
    if (this.terminal) return;
    this.terminal = true;
    this.upstream?.close(code === 1000 ? 1000 : 1011, reason);
    this.socket?.close(code, reason);
    this.clear();
  }

  private clear(): void {
    this.queued = [];
    this.queuedBytes = 0;
    this.socket = null;
    this.upstream = null;
  }
}

function encryptGrant(grant: ProxyGrant, rootSecret: string): string {
  const iv = randomBytes(TOKEN_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(rootSecret), iv);
  cipher.setAAD(Buffer.from(TOKEN_KEY_CONTEXT));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(grant), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function decryptGrant(token: string, rootSecret: string): ProxyGrant {
  const bytes = Buffer.from(token, "base64url");
  if (
    token.length === 0 ||
    token.length > TOKEN_MAX_BYTES ||
    bytes.byteLength <= TOKEN_IV_BYTES + TOKEN_TAG_BYTES
  ) {
    throw new Error("invalid proxy grant");
  }
  const iv = bytes.subarray(0, TOKEN_IV_BYTES);
  const tag = bytes.subarray(TOKEN_IV_BYTES, TOKEN_IV_BYTES + TOKEN_TAG_BYTES);
  const ciphertext = bytes.subarray(TOKEN_IV_BYTES + TOKEN_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(rootSecret), iv);
  decipher.setAAD(Buffer.from(TOKEN_KEY_CONTEXT));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return validateGrant(JSON.parse(plaintext));
}

function tokenKey(rootSecret: string): Buffer {
  if (rootSecret.length === 0) throw new Error("proxy authority is empty");
  return createHmac("sha256", rootSecret).update(TOKEN_KEY_CONTEXT).digest();
}

function validateGrant(value: unknown): ProxyGrant {
  if (!value || typeof value !== "object") throw new Error("invalid proxy grant");
  const grant = value as Record<string, unknown>;
  if (grant.version !== TOKEN_VERSION) throw new Error("invalid proxy grant version");
  const upstreamUrl = requireUpstreamUrl(grant.upstreamUrl);
  const upstreamProtocols = requireProtocols(grant.upstreamProtocols);
  if (
    typeof grant.responseProtocol !== "string" ||
    grant.responseProtocol !== (grant.realtime ? "opengeni-realtime.v1" : upstreamProtocols[0])
  ) {
    throw new Error("invalid proxy response protocol");
  }
  const origin = grant.origin === null ? null : normalizedOrigin(grant.origin);
  if (grant.origin !== null && !origin) throw new Error("invalid proxy origin");
  if (!Number.isSafeInteger(grant.expiresAt) || (grant.expiresAt as number) <= 0) {
    throw new Error("invalid proxy expiry");
  }
  let realtime: RealtimeProxySource | undefined;
  if (grant.realtime) {
    const value = grant.realtime as RealtimeProxySource;
    const authority = value.authority;
    const access = AccessGrant.parse(authority.grant);
    const source = RealtimeSessionUsageSource.parse({ ...value.source, schema: REALTIME_SESSION_SOURCE_SCHEMA, billingPath: "external" });
    if (authority.context.accountId !== access.accountId || authority.context.workspaceId !== access.workspaceId ||
      !/^[0-9a-f-]{36}$/i.test(value.sessionId) || !["ai-gateway", "xai-subscription"].includes(source.provider)) throw new Error("invalid realtime grant");
    realtime = { ...value, authority: { ...authority, grant: access,
      externalContinuation: authority.externalContinuation ? ExternalActorContinuation.parse(authority.externalContinuation) : null } };
  }
  return Object.freeze({
    version: TOKEN_VERSION,
    upstreamUrl,
    upstreamProtocols: Object.freeze(upstreamProtocols),
    responseProtocol: grant.responseProtocol as string,
    origin,
    expiresAt: grant.expiresAt as number,
    ...(realtime ? { realtime } : {}),
  });
}

function requireUpstreamUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new Error("invalid upstream URL");
  }
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("invalid upstream URL");
  }
  return url.toString();
}

function requireProtocols(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw new Error("invalid upstream protocols");
  }
  return value.map((protocol) => {
    if (
      typeof protocol !== "string" ||
      protocol.length === 0 ||
      protocol.length > 2048 ||
      protocol.includes(",")
    ) {
      throw new Error("invalid upstream protocol");
    }
    return protocol;
  });
}

function offeredProtocols(value: string | null): string[] {
  return value
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}

function normalizedOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch {
    return null;
  }
}

function firstForwardedValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const part = value.split(",")[0]?.trim() ?? "";
  return part.length > 0 ? part : null;
}

function isSafeForwardedHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && !/[\s/@?#\\]/.test(host);
}

function binaryMessage(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  return null;
}

function webSocketBinary(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function safeCloseCode(code: number): number {
  return Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1011;
}

function boundedReason(reason: string): string {
  const normalized = reason.trim();
  return normalized.length > 0 && Buffer.byteLength(normalized) <= 123
    ? normalized
    : "upstream closed";
}
