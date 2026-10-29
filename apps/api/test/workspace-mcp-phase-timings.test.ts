import { describe, expect, spyOn, test } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createObservability, type WorkspaceMcpTimingObservation } from "@opengeni/observability";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import { requireAccessGrantAuthorization } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import { Hono, type Context } from "hono";
import { requireAccessKey } from "../src/http/auth";
import { handleMcpRequestWithClientAbort } from "../src/mcp/request-abort";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import {
  buildWorkspaceToolGatewayMcpServer,
  type PreparedWorkspaceToolGateway,
} from "../src/workspace-tool-gateway";
import {
  workspaceToolGatewayTimingMiddleware,
  observeWorkspaceToolGatewayMcpTransport,
} from "../src/workspace-tool-gateway-observability";

const grant: AccessGrant = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "user:private-timing-fixture",
  principalKind: "human_session",
  permissions: ["workspace:read"],
};
const phases = [
  "route_prepare",
  "transport_setup",
  "sdk_dispatch",
  "host_handler",
  "response_write",
];
function observer() {
  return createObservability(
    {
      serviceName: "test",
      environment: "test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: false,
      observabilityOtlpHeaders: "",
    },
    { component: "api" },
  );
}
function gateway(
  options: {
    fail?: boolean;
    toolError?: boolean;
    hidden?: boolean;
    approval?: boolean;
    blocked?: boolean;
    delay?: boolean;
    onExecute?: () => void;
    wait?: (signal?: AbortSignal) => Promise<void>;
  } = {},
): PreparedWorkspaceToolGateway {
  const { gateway: toolGateway, catalog: toolGatewayCatalog } = createWorkspaceToolGateway({
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    generation: 1,
    authorize: async () => {
      if (options.blocked) throw new Error("private-policy-failure");
    },
    resolveArguments: async ({ arguments: args }) => {
      if (options.delay) await Bun.sleep(15);
      return args;
    },
    definitions: [
      {
        identity: { serverId: "host", toolName: "private_lookup" },
        modelName: "host__private_lookup",
        inputSchema: { type: "object" },
        source: "mcp",
        approval: options.approval ? "human" : "none",
        ...(options.hidden ? { meta: { ui: { visibility: ["app"] } } } : {}),
        lifecycle: {
          prepare: async () => ({
            begin: async () => {
              if (options.delay) await Bun.sleep(15);
            },
            complete: async () => {
              if (options.delay) await Bun.sleep(15);
            },
          }),
        },
        execute: async (_args, context) => {
          options.onExecute?.();
          await options.wait?.(context.signal);
          if (options.delay) await Bun.sleep(15);
          if (options.fail) throw new Error("private-host-failure");
          return {
            isError: options.toolError ?? false,
            content: [{ type: "text", text: "private-result" }],
          };
        },
      },
    ],
  });
  return { toolGateway, toolGatewayCatalog, close: async () => {} };
}
function request(
  method = "tools/call",
  options: { id?: number; name?: string; accept?: string; version?: string } = {},
) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: options.accept ?? "application/json, text/event-stream",
      ...(options.version ? { "mcp-protocol-version": options.version } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: options.id ?? 1,
      method,
      ...(method === "tools/call"
        ? {
            params: {
              name: options.name ?? "host__private_lookup",
              arguments: { secret: "private-argument" },
            },
          }
        : {}),
    }),
  });
}
async function serve(obs = observer(), prepared = gateway(), access = grant) {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = buildWorkspaceToolGatewayMcpServer(prepared, access, obs);
  await server.connect(transport);
  observeWorkspaceToolGatewayMcpTransport(obs, transport);
  return {
    transport,
    close: async () => {
      await server.close();
      await prepared.close();
    },
  };
}
function expectClosed(
  events: WorkspaceMcpTimingObservation[],
  outcome: WorkspaceMcpTimingObservation["outcome"],
  kind: "call" | "list" = "call",
) {
  expect(events).toHaveLength(5);
  expect(events.map((event) => event.phase)).toEqual(phases);
  expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
  expect(new Set(events.map((event) => event.totalMs)).size).toBe(1);
  expect(
    events.every(
      (event) => event.outcome === outcome && event.toolKind === kind && event.durationMs >= 0,
    ),
  ).toBe(true);
  expect(
    Math.abs(events.reduce((sum, event) => sum + event.durationMs, 0) - events[0]!.totalMs),
  ).toBeLessThan(0.001);
  for (const event of events)
    expect(Object.keys(event).sort()).toEqual([
      "durationMs",
      "outcome",
      "phase",
      "requestId",
      "toolKind",
      "totalMs",
    ]);
  expect(JSON.stringify(events)).not.toMatch(
    /private|arguments|results|identity|subjectId|workspaceId|accountId|params/,
  );
}

describe("workspace MCP phase timings", () => {
  test("every call emits five closed correlated phases through the observability subscription", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    const unsubscribe = obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const run = await serve(obs);
    try {
      const response = await run.transport.handleRequest(request());
      expect((await response.json()).result.content[0].text).toBe("private-result");
      expectClosed(events, "ok");
      expect(events[4]!.durationMs).toBeGreaterThan(0);
    } finally {
      unsubscribe();
      await run.close();
    }
  });
  test("host execution excludes secret resolution and lifecycle overhead", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const run = await serve(obs, gateway({ delay: true }));
    try {
      await run.transport.handleRequest(request());
      expectClosed(events, "ok");
      expect(events[3]!.durationMs).toBeGreaterThan(10);
      expect(events[2]!.durationMs).toBeGreaterThan(35);
      expect(events[3]!.durationMs).toBeLessThan(events[2]!.durationMs);
    } finally {
      await run.close();
    }
  });
  test("tools/list truthfully has no downstream host execution", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const run = await serve(obs);
    try {
      expect(
        (await (await run.transport.handleRequest(request("tools/list"))).json()).result.tools,
      ).toHaveLength(1);
      expectClosed(events, "ok", "list");
      expect(events[3]!.durationMs).toBe(0);
    } finally {
      await run.close();
    }
  });
  test("refusals and execution errors close once without exposing error bodies", async () => {
    for (const [options, outcome] of [
      [{ hidden: true }, "rejected"],
      [{ approval: true }, "rejected"],
      [{ blocked: true }, "failed"],
      [{ fail: true }, "failed"],
      [{ toolError: true }, "tool_error"],
    ] as const) {
      const obs = observer();
      const events: WorkspaceMcpTimingObservation[] = [];
      obs.onWorkspaceMcpTiming((event) => {
        events.push(event);
      });
      const run = await serve(obs, gateway(options));
      try {
        await run.transport.handleRequest(request());
        expectClosed(events, outcome);
        if (options.hidden || options.approval || options.blocked)
          expect(events[3]!.durationMs).toBe(0);
      } finally {
        await run.close();
      }
    }
  });
  test("complete-body pre-admission refusals close separately from canonical gateway rejections", async () => {
    for (const options of [{ accept: "application/json" }, { version: "invalid" }]) {
      const obs = observer();
      const events: WorkspaceMcpTimingObservation[] = [];
      obs.onWorkspaceMcpTiming((event) => {
        events.push(event);
      });
      const run = await serve(obs);
      try {
        expect(
          (await run.transport.handleRequest(request("tools/call", options))).status,
        ).toBeGreaterThanOrEqual(400);
        expectClosed(events, "refused");
        expect(events.slice(2).map((event) => event.durationMs)).toEqual([0, 0, 0]);
      } finally {
        await run.close();
      }
    }
  });
  test("concurrent requests retain separate identities and observation failures never affect execution", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming(() => {
      throw new Error("private-observer-error");
    });
    obs.onWorkspaceMcpTiming(async () => {
      throw new Error("private-async-observer-error");
    });
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const runs = await Promise.all([serve(obs, gateway({ delay: true })), serve(obs)]);
    try {
      const responses = await Promise.all(
        runs.map((run) => run.transport.handleRequest(request())),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(events).toHaveLength(10);
      const ids = [...new Set(events.map((event) => event.requestId))];
      expect(ids).toHaveLength(2);
      for (const id of ids)
        expectClosed(
          events.filter((event) => event.requestId === id),
          "ok",
        );
    } finally {
      await Promise.all(runs.map((run) => run.close()));
    }
  });
  test("stateless transport reuse refusal cannot corrupt active request timings", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const run = await serve(obs, gateway({ delay: true }));
    try {
      const responses = await Promise.allSettled([
        run.transport.handleRequest(request("tools/call", { id: 1 })),
        run.transport.handleRequest(request("tools/list", { id: 1 })),
      ]);
      expect(responses[0]).toMatchObject({ status: "fulfilled", value: { status: 200 } });
      expect(responses[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
      expectClosed(
        events.filter((event) => event.toolKind === "call"),
        "ok",
      );
      const refused = events.filter((event) => event.toolKind === "list");
      // SDK refuses reuse before body admission; diagnostic recognition is best-effort.
      if (refused.length > 0) expectClosed(refused, "refused", "list");
      expect(new Set(events.map((event) => event.requestId)).size).toBe(refused.length > 0 ? 2 : 1);
    } finally {
      await run.close();
    }
  });
  test("nested host invocations count their union instead of overlapping durations twice", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const nested = gateway({ delay: true });
    const run = await serve(
      obs,
      gateway({
        wait: async () => {
          const call = await nested.toolGateway.prepareCall({
            operationId: crypto.randomUUID(),
            catalogDigest: nested.toolGatewayCatalog.digest,
            identity: { serverId: "host", toolName: "private_lookup" },
            arguments: {},
            caller: { kind: "mcp", subjectId: grant.subjectId },
          });
          await call.execute();
        },
      }),
    );
    try {
      await run.transport.handleRequest(request());
      expectClosed(events, "ok");
      expect(events[3]!.durationMs).toBeGreaterThan(45);
    } finally {
      await run.close();
    }
  });
  test("route_prepare is non-zero with real signed credential verification and grant admission", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const secret = "workspace-timing-delegation-test-secret";
    const settings = testSettings({
      productAccessMode: "configured",
      authRequired: true,
      accessKey: "workspace-timing-access-key",
      delegationSecret: secret,
    });
    let executions = 0;
    const app = new Hono();
    app.use("*", workspaceToolGatewayTimingMiddleware(obs, requireAccessKey(settings)));
    app.post("/v1/workspaces/:workspaceId/mcp", async (c) => {
      const authorization = await requireAccessGrantAuthorization(
        c,
        { settings, db: {} as never },
        c.req.param("workspaceId"),
        "workspace:read",
      );
      const run = await serve(
        obs,
        gateway({
          onExecute: () => {
            executions++;
          },
        }),
        authorization.grant,
      );
      try {
        return await run.transport.handleRequest(c.req.raw);
      } finally {
        await run.close();
      }
    });
    const token = (key: string) =>
      signDelegatedAccessToken(key, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: "service:timing-fixture",
        principalKind: "service",
        permissions: ["workspace:read"],
        exp: Math.floor(Date.now() / 1000) + 60,
      });
    const path = `http://localhost/v1/workspaces/${grant.workspaceId}/mcp`;
    const authorized = new Request(path, request());
    authorized.headers.set("authorization", `Bearer ${await token(secret)}`);
    expect((await app.request(authorized)).status).toBe(200);
    expect(executions).toBe(1);
    expectClosed(events, "ok");
    expect(events[0]!.durationMs).toBeGreaterThan(0);
    events.length = 0;
    const denied = new Request(path, request());
    denied.headers.set("authorization", `Bearer ${await token("wrong-signing-secret")}`);
    expect((await app.request(denied)).status).toBe(401);
    expect(executions).toBe(1);
    expectClosed(events, "refused");
    expect(events.slice(1).map((event) => event.durationMs)).toEqual([0, 0, 0, 0]);
  });
  test("subscribed diagnostics never wait for unfinished uploads before real authentication refuses", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const settings = testSettings({
      productAccessMode: "configured",
      authRequired: true,
      accessKey: "timing-stream-access-key",
      delegationSecret: "timing-stream-secret",
    });
    const app = new Hono();
    app.use("*", workspaceToolGatewayTimingMiddleware(obs, requireAccessKey(settings)));
    app.post("/v1/workspaces/:workspaceId/mcp", (c) => c.text("host must not execute", 500));
    const wrongToken = await signDelegatedAccessToken("wrong-stream-signing-secret", {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: "service:stream-fixture",
      principalKind: "service",
      permissions: ["workspace:read"],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    for (const [authorization, abort] of [
      [undefined, false],
      [`Bearer ${wrongToken}`, false],
      [undefined, true],
    ] as const) {
      const controller = new AbortController();
      let closeUpload = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(uploadController) {
          closeUpload = () => uploadController.close();
          uploadController.enqueue(
            new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":'),
          );
        },
      });
      const streamingRequest = new Request(
        `http://localhost/v1/workspaces/${grant.workspaceId}/mcp`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
          },
          signal: controller.signal,
          body: stream,
        },
      );
      const cancellation = spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      const response = app.request(streamingRequest);
      if (abort) controller.abort();
      try {
        const result = await Promise.race([response, Bun.sleep(100).then(() => undefined)]);
        expect(result?.status).toBe(401);
        expect(streamingRequest.signal.aborted).toBe(abort);
        expect(cancellation).toHaveBeenCalledTimes(1);
        expect(events).toHaveLength(0);
      } finally {
        cancellation.mockRestore();
        closeUpload();
        await response;
      }
    }
  });
  test("subscribed transport diagnostics never wait for unfinished uploads before SDK header refusal", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const run = await serve(obs);
    let closeUpload = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(uploadController) {
        closeUpload = () => uploadController.close();
        uploadController.enqueue(
          new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":'),
        );
      },
    });
    const streamingRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: stream,
    });
    const cancellation = spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const response = run.transport.handleRequest(streamingRequest);
    try {
      const result = await Promise.race([response, Bun.sleep(100).then(() => undefined)]);
      expect(result?.status).toBe(406);
      expect(streamingRequest.signal.aborted).toBe(false);
      expect(cancellation).toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      cancellation.mockRestore();
      closeUpload();
      await response;
      await run.close();
    }
  });
  test("transport close disposes unfinished diagnostic reads without aborting the original request", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const run = await serve(obs);
    let closeUpload = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(uploadController) {
        closeUpload = () => uploadController.close();
        uploadController.enqueue(
          new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":'),
        );
      },
    });
    const streamingRequest = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: stream,
    });
    const cancellation = spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const controller = new AbortController();
    const response = handleMcpRequestWithClientAbort(
      run.transport,
      streamingRequest,
      controller.signal,
    );
    try {
      controller.abort();
      expect((await response).status).toBe(499);
      expect(cancellation).toHaveBeenCalledTimes(1);
      expect(streamingRequest.signal.aborted).toBe(false);
      expect(events).toHaveLength(0);
    } finally {
      cancellation.mockRestore();
      closeUpload();
      await run.close();
    }
  });
  test("SDK send failures close as failed before client cancellation", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    const observed = Promise.withResolvers<void>();
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
      if (events.length === 5) observed.resolve();
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = buildWorkspaceToolGatewayMcpServer(gateway(), grant, obs);
    await server.connect(transport);
    transport.send = async () => {
      throw new Error("private-send-failure");
    };
    observeWorkspaceToolGatewayMcpTransport(obs, transport);
    const controller = new AbortController();
    const pending = handleMcpRequestWithClientAbort(transport, request(), controller.signal);
    try {
      await observed.promise;
      expectClosed(events, "failed");
      expect(events[4]!.durationMs).toBeGreaterThan(0);
      controller.abort();
      expect((await pending).status).toBe(499);
      expect(events).toHaveLength(5);
    } finally {
      controller.abort();
      await server.close();
    }
  });
  test("client cancellation closes once without inventing a response write", async () => {
    const obs = observer();
    const events: WorkspaceMcpTimingObservation[] = [];
    obs.onWorkspaceMcpTiming((event) => {
      events.push(event);
    });
    const entered = Promise.withResolvers<void>();
    const run = await serve(
      obs,
      gateway({
        wait: async (signal) => {
          entered.resolve();
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      }),
    );
    const controller = new AbortController();
    try {
      const pending = handleMcpRequestWithClientAbort(run.transport, request(), controller.signal);
      await entered.promise;
      controller.abort();
      expect((await pending).status).toBe(499);
      expectClosed(events, "cancelled");
      expect(events[4]!.durationMs).toBe(0);
    } finally {
      await run.close();
    }
  });
  test("stock console without an extension is unchanged", async () => {
    const obs = observer();
    const run = await serve(obs);
    const methods = [
      run.transport.handleRequest,
      run.transport.send,
      run.transport.close,
      run.transport.onmessage,
    ];
    const middleware = workspaceToolGatewayTimingMiddleware(obs, (_c, next) => next());
    const completion = Promise.resolve();
    const next = () => completion;
    const clock = spyOn(performance, "now");
    const uuid = spyOn(crypto, "randomUUID");
    try {
      expect(middleware({} as Context, next)).toBe(completion);
      observeWorkspaceToolGatewayMcpTransport(obs, run.transport);
      expect(clock).not.toHaveBeenCalled();
      expect(uuid).not.toHaveBeenCalled();
      expect([
        run.transport.handleRequest,
        run.transport.send,
        run.transport.close,
        run.transport.onmessage,
      ]).toEqual(methods);
    } finally {
      clock.mockRestore();
      uuid.mockRestore();
    }
    try {
      const response = await run.transport.handleRequest(request());
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { isError: false, content: [{ type: "text", text: "private-result" }] },
      });
    } finally {
      await run.close();
    }
  });
});
