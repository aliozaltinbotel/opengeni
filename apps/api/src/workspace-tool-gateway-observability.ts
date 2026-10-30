import type { ToolGatewayCatalogEntry } from "@opengeni/contracts";
import type { Observability } from "@opengeni/observability";
import {
  withWorkspaceMcpHostTiming,
  hasWorkspaceMcpTimingSubscribers,
  publishWorkspaceMcpTiming,
  type WorkspaceMcpTimingScope,
} from "@opengeni/observability/internal/workspace-mcp-timing";
import type { WorkspaceMcpTimingObservation } from "@opengeni/observability";
import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MCP_MAX_INBOUND_REQUEST_BYTES } from "@opengeni/runtime/mcp-network";

type TimingOutcome = WorkspaceMcpTimingObservation["outcome"];
type TimingRequest = { id: string | number; kind: "call" | "list" };
const gatewayRouteTiming = new AsyncLocalStorage<{ current: GatewayRouteTiming | undefined }>();

class GatewayRequestTiming {
  readonly scope: WorkspaceMcpTimingScope = { current: this };
  transportAt: number | undefined;
  dispatchAt: number | undefined;
  writeAt: number | undefined;
  outcome: TimingOutcome = "ok";
  private hostAt = 0;
  private hostActive = 0;
  private hostMs = 0;
  private closed = false;

  constructor(
    private readonly observer: Observability,
    readonly request: TimingRequest,
    private readonly startedAt: number,
    readonly requestId: string,
    private readonly queueDelivery: (deliver: () => void) => void,
  ) {}

  begin = (): { end: () => void } => {
    if (this.hostActive++ === 0) this.hostAt = performance.now();
    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        if (--this.hostActive === 0 && !this.closed) this.hostMs += performance.now() - this.hostAt;
      },
    };
  };

  finish(endedAt: number, outcome = this.outcome): void {
    if (this.closed) return;
    this.closed = true;
    this.scope.current = undefined;
    const totalMs = Math.max(0, endedAt - this.startedAt);
    const routeMs = Math.max(0, (this.transportAt ?? endedAt) - this.startedAt);
    const setupMs =
      this.transportAt === undefined
        ? 0
        : Math.max(0, (this.dispatchAt ?? endedAt) - this.transportAt);
    const hostMs = this.hostMs + (this.hostActive > 0 ? Math.max(0, endedAt - this.hostAt) : 0);
    const writeMs = this.writeAt === undefined ? 0 : Math.max(0, endedAt - this.writeAt);
    const dispatchMs = Math.max(0, totalMs - routeMs - setupMs - hostMs - writeMs);
    const durations = {
      route_prepare: routeMs,
      transport_setup: setupMs,
      sdk_dispatch: dispatchMs,
      host_handler: hostMs,
      response_write: writeMs,
    };
    const observer = this.observer;
    const requestId = this.requestId;
    const kind = this.request.kind;
    // The route releases delivery after cleanup; standalone transports queue it directly.
    this.queueDelivery(() => {
      for (const phase of [
        "route_prepare",
        "transport_setup",
        "sdk_dispatch",
        "host_handler",
        "response_write",
      ] as const) {
        try {
          publishWorkspaceMcpTiming(
            observer,
            Object.freeze({
              requestId,
              totalMs,
              phase,
              durationMs: durations[phase],
              toolKind: kind,
              outcome,
            }),
          );
        } catch {
          // Neither observer failure nor private error text enters execution or telemetry.
        }
      }
    });
  }
}

class GatewayRouteTiming {
  readonly scope: { current: GatewayRouteTiming | undefined } = { current: this };
  gateway = false;
  excluded = false;
  discoveredBody: string | undefined;
  disposeDiscovery: (() => void) | undefined;
  readonly requests = new Map<string | number, GatewayRequestTiming>();
  private transportAt: number | undefined;
  private endedAt: number | undefined;
  private outcome: TimingOutcome | undefined;
  private readonly pendingDeliveries: Array<() => void> = [];

  constructor(
    private readonly observer: Observability,
    private readonly startedAt: number,
    readonly requestId: string,
    private deliveryDeferred = false,
  ) {}

  private queueDelivery = (deliver: () => void): void => {
    if (this.deliveryDeferred) this.pendingDeliveries.push(deliver);
    else setTimeout(deliver, 0);
  };

  /** Close measurements at SDK completion, but let the API return after its cleanup. */
  releaseDelivery(): void {
    this.deliveryDeferred = false;
    for (const deliver of this.pendingDeliveries.splice(0)) this.queueDelivery(deliver);
  }

  recognize(message: unknown): GatewayRequestTiming | undefined {
    if (this.excluded) return undefined;
    if (
      typeof message !== "object" ||
      message === null ||
      !("method" in message) ||
      !("id" in message)
    )
      return undefined;
    if (
      (message.method !== "tools/call" && message.method !== "tools/list") ||
      (typeof message.id !== "string" && typeof message.id !== "number")
    )
      return undefined;
    let timing = this.requests.get(message.id);
    if (!timing) {
      timing = new GatewayRequestTiming(
        this.observer,
        { id: message.id, kind: message.method === "tools/call" ? "call" : "list" },
        this.startedAt,
        this.requestId,
        this.queueDelivery,
      );
      timing.transportAt = this.transportAt;
      this.requests.set(message.id, timing);
      if (this.endedAt !== undefined) timing.finish(this.endedAt, this.outcome);
    }
    return timing;
  }

  enterTransport(transportAt: number): void {
    this.transportAt = transportAt;
    for (const timing of this.requests.values()) timing.transportAt = transportAt;
  }

  exclude(): void {
    this.excluded = true;
    this.pendingDeliveries.length = 0;
    this.scope.current = undefined;
    this.disposeDiscovery?.();
    this.discoveredBody = undefined;
    for (const timing of this.requests.values()) timing.scope.current = undefined;
    this.requests.clear();
  }

  finish(outcome?: TimingOutcome): void {
    if (this.endedAt !== undefined || this.excluded) return;
    const endedAt = (this.endedAt = performance.now());
    this.scope.current = undefined;
    this.outcome = outcome;
    this.disposeDiscovery?.();
    for (const timing of this.requests.values()) timing.finish(endedAt, outcome);
    // Canonical recognition wins. Refusal-only discovery parses after the caller
    // receives its response, outside every measured phase, and retains no route.
    const body = this.requests.size === 0 ? this.discoveredBody : undefined;
    this.discoveredBody = undefined;
    this.requests.clear();
    if (body === undefined) return;
    const { observer, startedAt, requestId, transportAt } = this;
    this.queueDelivery(() => {
      try {
        const discovered: unknown = JSON.parse(body);
        const completed = new GatewayRouteTiming(observer, startedAt, requestId);
        if (transportAt !== undefined) completed.enterTransport(transportAt);
        for (const message of Array.isArray(discovered) ? discovered : [discovered])
          completed.recognize(message);
        for (const timing of completed.requests.values()) timing.finish(endedAt, outcome);
      } catch {
        /* Canonical body admission owns malformed requests. */
      }
    });
  }
}

/** Best-effort discovery runs beside admission and never delays its response. */
function startTimingDiscovery(request: Request, timing: GatewayRouteTiming): () => void {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    request.signal.removeEventListener("abort", dispose);
    // A tee's cancellation can await its original branch; never await it here.
    void reader?.cancel().catch(() => {});
  };
  const read = async (): Promise<void> => {
    if (request.method !== "POST") return;
    try {
      reader = request.clone().body?.getReader();
      if (!reader) return;
      if (request.signal.aborted) {
        dispose();
        return;
      }
      request.signal.addEventListener("abort", dispose, { once: true });
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      for (;;) {
        const chunk = await reader.read();
        if (disposed) return;
        if (chunk.done) {
          timing.discoveredBody = text + decoder.decode();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > MCP_MAX_INBOUND_REQUEST_BYTES) return;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      // The canonical request remains responsible for body/protocol admission.
    } finally {
      dispose();
      reader?.releaseLock();
    }
  };
  timing.disposeDiscovery = dispose;
  void read().catch(() => {});
  return dispose;
}

/** Wrap an existing middleware before authentication, without another Hono layer. */
export function workspaceToolGatewayTimingMiddleware(
  observability: Observability,
  middleware: MiddlewareHandler,
  correlationId?: (context: Parameters<MiddlewareHandler>[0]) => string | undefined,
): MiddlewareHandler {
  return (c, next) => {
    if (
      !hasWorkspaceMcpTimingSubscribers(observability) ||
      !/^\/v1\/workspaces\/[^/]+\/mcp(?:\/(?:docs|files))?$/.test(c.req.path)
    )
      return middleware(c, next);
    const timing = new GatewayRouteTiming(
      observability,
      performance.now(),
      correlationId?.(c) ?? crypto.randomUUID(),
      true,
    );
    const scope = timing.scope;
    const dispose = startTimingDiscovery(c.req.raw, timing);
    return gatewayRouteTiming.run(scope, async () => {
      try {
        const response = await middleware(c, next);
        const status = response?.status ?? c.res.status;
        // Native agent-attempt / dedicated first-party servers are not the gateway.
        if (!timing.gateway && !timing.excluded && status >= 400)
          timing.finish(status >= 500 ? "failed" : "refused");
        return response;
      } catch (error) {
        timing.finish("failed");
        throw error;
      } finally {
        dispose();
        scope.current = undefined;
        timing.releaseDelivery();
      }
    });
  };
}

/** Native servers share the URL, but never represent gateway work. */
export function excludeWorkspaceToolGatewayTiming(): void {
  gatewayRouteTiming.getStore()?.current?.exclude();
}

/** Install after Server.connect, which owns transport.onmessage. */
export function observeWorkspaceToolGatewayMcpTransport(
  observability: Observability | undefined,
  transport: WebStandardStreamableHTTPServerTransport,
): void {
  if (!observability || !hasWorkspaceMcpTimingSubscribers(observability)) return;
  const routeTiming = gatewayRouteTiming.getStore()?.current;
  if (routeTiming) routeTiming.gateway = true;
  const pending = new Set<GatewayRouteTiming>();
  const handleRequest = transport.handleRequest;
  const onmessage = transport.onmessage;
  const send = transport.send;
  const close = transport.close;
  transport.onmessage = (message, extra) => {
    const timing = gatewayRouteTiming.getStore()?.current?.recognize(message);
    if (!timing) return onmessage?.(message, extra);
    timing.dispatchAt = performance.now();
    return withWorkspaceMcpHostTiming(timing.scope, () => onmessage?.(message, extra));
  };
  transport.send = (message, options) => {
    const id = "id" in message && !("method" in message) ? message.id : undefined;
    const timing =
      typeof id === "string" || typeof id === "number"
        ? gatewayRouteTiming.getStore()?.current?.requests.get(id)
        : undefined;
    if (timing) {
      timing.writeAt = performance.now();
      timing.outcome =
        "error" in message
          ? message.error.code === -32602
            ? "rejected"
            : "failed"
          : "result" in message &&
              typeof message.result === "object" &&
              message.result !== null &&
              "isError" in message.result &&
              message.result.isError === true
            ? "tool_error"
            : "ok";
    }
    if (!timing) return send.call(transport, message, options);
    try {
      return send.call(transport, message, options).catch((error: unknown) => {
        timing.finish(performance.now(), "failed");
        throw error;
      });
    } catch (error) {
      timing.finish(performance.now(), "failed");
      throw error;
    }
  };
  transport.handleRequest = (request, options) => {
    if (!hasWorkspaceMcpTimingSubscribers(observability))
      return handleRequest.call(transport, request, options);
    const transportAt = performance.now();
    const observe = async (): Promise<Response> => {
      const route = gatewayRouteTiming.getStore()?.current;
      const timing =
        route ??
        new GatewayRouteTiming(
          observability,
          transportAt,
          request.headers.get("x-opengeni-correlation-id") ?? crypto.randomUUID(),
        );
      const scope = timing.scope;
      const dispose = route ? undefined : startTimingDiscovery(request, timing);
      pending.add(timing);
      timing.enterTransport(transportAt);
      try {
        const response = await gatewayRouteTiming.run(scope, () =>
          handleRequest.call(transport, request, options),
        );
        timing.finish(
          response.status >= 500 ? "failed" : response.status >= 400 ? "refused" : undefined,
        );
        return response;
      } catch (error) {
        // An exception before canonical dispatch has no stable SDK refusal code.
        // Emit nothing for it, including stateless transport reuse.
        if (timing.requests.size === 0) timing.exclude();
        else timing.finish("failed");
        throw error;
      } finally {
        dispose?.();
        pending.delete(timing);
        scope.current = undefined;
      }
    };
    return observe();
  };
  transport.close = () => {
    const result = close.call(transport);
    if (pending.size === 0) return result;
    return result.then(
      () => {
        for (const timing of pending) timing.finish("cancelled");
        pending.clear();
      },
      (error: unknown) => {
        for (const timing of pending) timing.finish("failed");
        pending.clear();
        throw error;
      },
    );
  };
}

export type WorkspaceToolGatewayAdapter = "http" | "mcp";
export type WorkspaceToolGatewayOperation = "approval" | "call";
export type WorkspaceToolGatewayOutcome =
  | "ok"
  | "tool_error"
  | "approval_required"
  | "catalog_stale"
  | "invalid_input"
  | "not_found"
  | "rate_limited"
  | "failed";

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export function recordWorkspaceToolTargetOperation(
  observability: Observability | null | undefined,
  input: {
    operation: "resolve" | "invoke" | "target-approvals" | "manifest";
    outcome: "ok" | "failed";
    durationSeconds: number;
  },
): void {
  try {
    const labels = { operation: input.operation, outcome: input.outcome };
    observability?.incrementCounter({
      name: "opengeni_tool_target_operations_total",
      help: "Targeted workspace tool requests; never full-catalog fallback.",
      labels,
    });
    observability?.observeHistogram({
      name: "opengeni_tool_target_duration_seconds",
      help: "Total targeted request time including metadata, provider preparation and execution.",
      labels,
      buckets: DURATION_BUCKETS,
      value: Math.max(0, input.durationSeconds),
    });
  } catch {
    /* Observation never changes execution. */
  }
}

/**
 * Bounded preparation telemetry: how long the request spent constructing,
 * credentialing, connecting, and listing connectors before any execution, and
 * whether a call used target-only preparation through a catalog attestation.
 */
export function recordWorkspaceToolGatewayPreparation(
  observability: Observability | null | undefined,
  input: {
    operation: "catalog" | "call";
    scope: "complete" | "target";
    attestation: "hit" | "miss" | "mismatch" | "bypass" | "record";
    durationSeconds: number;
  },
): void {
  try {
    const labels = {
      operation: input.operation,
      scope: input.scope,
      attestation: input.attestation,
    };
    observability?.incrementCounter({
      name: "opengeni_tool_gateway_preparations_total",
      help: "Workspace tool gateway HTTP preparations by bounded operation, scope, and catalog attestation outcome.",
      labels,
    });
    observability?.observeHistogram({
      name: "opengeni_tool_gateway_preparation_duration_seconds",
      help: "Workspace tool gateway HTTP preparation wall time in seconds, before execution.",
      labels,
      buckets: DURATION_BUCKETS,
      value: Math.max(0, input.durationSeconds),
    });
  } catch {
    // Telemetry must never change gateway execution truth.
  }
}

/**
 * Low-cardinality gateway telemetry shared by HTTP/SDK/Site and aggregate MCP
 * adapters. Tool names, workspace/subject ids, arguments, results, credentials,
 * and approval tokens are excluded by construction.
 */
export function startWorkspaceToolGatewayObservation(
  observability: Observability | null | undefined,
  input: {
    adapter: WorkspaceToolGatewayAdapter;
    operation: WorkspaceToolGatewayOperation;
    source: ToolGatewayCatalogEntry["source"] | "aggregate";
  },
): { end: (outcome: WorkspaceToolGatewayOutcome) => void } {
  const startedAt = performance.now();
  let span: ReturnType<Observability["startSpan"]> | undefined;
  try {
    span = observability?.startSpan("opengeni.tool_gateway.operation", {
      surface: "workspace_tool_gateway",
      op: `${input.adapter}.${input.operation}`,
      provider: input.source,
    });
  } catch {
    // Telemetry must never change gateway execution truth.
  }
  let ended = false;
  return {
    end: (outcome) => {
      if (ended) return;
      ended = true;
      const durationMs = Math.max(0, performance.now() - startedAt);
      try {
        observability?.incrementCounter({
          name: "opengeni_tool_gateway_operations_total",
          help: "Workspace tool gateway operations by bounded adapter, operation, source, and outcome.",
          labels: {
            adapter: input.adapter,
            operation: input.operation,
            source: input.source,
            outcome,
          },
        });
        observability?.observeHistogram({
          name: "opengeni_tool_gateway_operation_duration_seconds",
          help: "Workspace tool gateway operation duration in seconds.",
          labels: {
            adapter: input.adapter,
            operation: input.operation,
            source: input.source,
          },
          buckets: DURATION_BUCKETS,
          value: durationMs / 1_000,
        });
        observability?.info("Workspace tool gateway operation completed", {
          surface: "workspace_tool_gateway",
          op: `${input.adapter}.${input.operation}`,
          provider: input.source,
          outcome,
          durationMs: Math.round(durationMs),
        });
      } catch {
        try {
          observability?.incrementCounter({
            name: "opengeni_observability_observer_errors_total",
            help: "Observability observer failures isolated from product execution.",
            labels: { observer: "workspace_tool_gateway" },
          });
        } catch {
          // Telemetry must never change gateway execution truth.
        }
      }
      try {
        span?.end({
          attributes: {
            outcome,
            "opengeni.duration_ms": Math.round(durationMs),
          },
        });
      } catch {
        // Telemetry must never change gateway execution truth.
      }
    },
  };
}
