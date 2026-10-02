import { expect, test } from "bun:test";
import type { AttemptToolAuthorization, AttemptToolDefinition } from "@opengeni/codemode";
import { testSettings } from "@opengeni/testing";
import { prepareAgentTools, type PrepareToolsOptions } from "../src/index";

type Invocation = Parameters<AttemptToolAuthorization>[0];

function scope(): PrepareToolsOptions {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("execution fences receive each prepared invocation and await before its prior begin", async () => {
  const preparedInvocations = new Map<string, Invocation>();
  const executionInvocations: Invocation[] = [];
  const events: string[] = [];
  const operationA = crypto.randomUUID();
  const operationB = crypto.randomUUID();
  const gateA = deferred();
  const gateB = deferred();
  const enteredA = deferred();
  const enteredB = deferred();
  const definitions = ["wait_a", "wait_b"].map(
    (toolName): AttemptToolDefinition => ({
      identity: { serverId: "fixture", toolName },
      modelName: `fixture__${toolName}`,
      inputSchema: {
        type: "object",
        properties: { timeoutSeconds: { type: "integer" } },
        required: ["timeoutSeconds"],
        additionalProperties: false,
      },
      source: "interaction",
      approval: "none",
      lifecycle: {
        prepare: async ({ call, entry }) => {
          preparedInvocations.set(call.operationId, { call, entry });
          return {
            begin: async () => {
              events.push(`begin:${call.operationId}`);
            },
          };
        },
      },
      execute: async (_args, context) => {
        events.push(`execute:${context.operationId}`);
        return { content: [{ type: "text", text: "executed" }] };
      },
    }),
  );
  const prepared = await prepareAgentTools(testSettings(), [], {
    ...scope(),
    attemptToolDefinitions: definitions,
    authorizeAttemptExecution: async (invocation?: Invocation) => {
      if (!invocation) throw new Error("Execution invocation missing");
      executionInvocations.push(invocation);
      if (invocation.call.operationId === operationA) {
        enteredA.resolve();
        await gateA.promise;
      } else if (invocation.call.operationId === operationB) {
        enteredB.resolve();
        await gateB.promise;
      }
      events.push(`fence:${invocation.call.operationId}`);
    },
  });
  try {
    const environment = prepared.attemptToolEnvironment!;
    const callA = await environment.prepareCall({
      operationId: operationA,
      catalogDigest: environment.catalog.digest,
      identity: definitions[0]!.identity,
      arguments: { timeoutSeconds: 59 },
      caller: { kind: "codemode", subjectId: "agent:test" },
    });
    const callB = await environment.prepareCall({
      operationId: operationB,
      catalogDigest: environment.catalog.digest,
      identity: definitions[1]!.identity,
      arguments: { timeoutSeconds: 60 },
      caller: { kind: "codemode", subjectId: "agent:test" },
    });
    expect(executionInvocations).toEqual([]);
    expect(events).toEqual([]);
    const executionB = callB.execute();
    const executionA = callA.execute();
    await Promise.race([
      Promise.all([enteredA.promise, enteredB.promise]),
      Promise.all([executionA, executionB]),
    ]);
    expect(events).toEqual([]);
    expect(executionInvocations.map(({ call }) => call.operationId)).toEqual([
      operationB,
      operationA,
    ]);
    for (const invocation of executionInvocations) {
      const captured = preparedInvocations.get(invocation.call.operationId)!;
      expect(invocation.call).toBe(captured.call);
      expect(invocation.entry).toBe(captured.entry);
    }
    expect(executionInvocations[0]!.call).toBe(callB.call);
    expect(executionInvocations[1]!.call).toBe(callA.call);
    expect(executionInvocations[0]!.call.arguments).toEqual({ timeoutSeconds: 60 });
    expect(executionInvocations[1]!.call.arguments).toEqual({ timeoutSeconds: 59 });
    gateB.resolve();
    await executionB;
    expect(events).toEqual([`fence:${operationB}`, `begin:${operationB}`, `execute:${operationB}`]);
    gateA.resolve();
    await executionA;
    expect(events.slice(3)).toEqual([
      `fence:${operationA}`,
      `begin:${operationA}`,
      `execute:${operationA}`,
    ]);
    await environment.callModel({
      modelName: definitions[0]!.modelName,
      arguments: { timeoutSeconds: 59 },
      subjectId: "agent:model",
    });
    const modelInvocation = executionInvocations[2]!;
    const captured = preparedInvocations.get(modelInvocation.call.operationId)!;
    expect(modelInvocation.call).toBe(captured.call);
    expect(modelInvocation.entry).toBe(captured.entry);
    expect(modelInvocation.call.caller).toEqual({ kind: "model", subjectId: "agent:model" });
    expect(modelInvocation.call.identity).toEqual(definitions[0]!.identity);
    expect(modelInvocation.call.arguments).toEqual({ timeoutSeconds: 59 });
  } finally {
    gateA.resolve();
    gateB.resolve();
    await prepared.close();
  }
});

test("refused execution cannot begin a connector action, consume approval, or execute", async () => {
  const events: string[] = [];
  const operationId = crypto.randomUUID();
  const prepared = await prepareAgentTools(testSettings(), [], {
    ...scope(),
    authorizeAttemptExecution: async (invocation?: Invocation) => {
      if (!invocation) throw new Error("Execution invocation missing");
      expect(invocation.call.operationId).toBe(operationId);
      expect(invocation.call.arguments).toEqual({ timeoutSeconds: 59 });
      events.push("fence-refused");
      throw new Error("Accepted deadline exceeded");
    },
    connectorActionPolicy: {
      prepare: async () => {
        events.push("prepare-policy");
        return { managed: true, decision: "allow" };
      },
      begin: async () => {
        events.push("begin-consume-approval");
        return { allowed: true, managed: true, requestId: "fixture-request" };
      },
      complete: async () => {
        events.push("complete-policy");
      },
    },
    attemptConnectorActionBindings: [
      {
        modelName: "fixture__wait",
        call: (approvalId, arguments_) => ({
          approvalId,
          serverId: "fixture",
          toolName: "wait",
          arguments: arguments_,
        }),
      },
    ],
    attemptToolDefinitions: [
      {
        identity: { serverId: "fixture", toolName: "wait" },
        modelName: "fixture__wait",
        inputSchema: {
          type: "object",
          properties: { timeoutSeconds: { type: "integer" } },
          required: ["timeoutSeconds"],
          additionalProperties: false,
        },
        source: "interaction",
        approval: "none",
        execute: async () => {
          events.push("execute");
          return { content: [{ type: "text", text: "executed" }] };
        },
      },
    ],
  });
  try {
    const environment = prepared.attemptToolEnvironment!;
    const call = await environment.prepareCall({
      operationId,
      catalogDigest: environment.catalog.digest,
      identity: { serverId: "fixture", toolName: "wait" },
      arguments: { timeoutSeconds: 59 },
      caller: { kind: "codemode", subjectId: "agent:test" },
    });
    expect(events).toEqual(["prepare-policy"]);
    await expect(call.execute()).rejects.toThrow("Accepted deadline exceeded");
    expect(events).toEqual(["prepare-policy", "fence-refused"]);
  } finally {
    await prepared.close();
  }
});

test("legacy zero-argument execution authorizers still run before model and Codemode effects", async () => {
  const events: string[] = [];
  const prepared = await prepareAgentTools(testSettings(), [], {
    ...scope(),
    authorizeAttemptExecution: () => {
      events.push("fence");
    },
    attemptToolDefinitions: [
      {
        identity: { serverId: "fixture", toolName: "execute" },
        modelName: "fixture__execute",
        inputSchema: { type: "object", additionalProperties: false },
        source: "interaction",
        approval: "none",
        lifecycle: {
          prepare: () => ({
            begin: () => {
              events.push("begin");
            },
          }),
        },
        execute: (_args, context) => {
          events.push(`execute:${context.caller.kind}`);
          return { content: [{ type: "text", text: "executed" }] };
        },
      },
    ],
  });
  try {
    const environment = prepared.attemptToolEnvironment!;
    await environment.callModel({
      modelName: "fixture__execute",
      arguments: {},
      subjectId: "agent:model",
    });
    await environment.call({
      operationId: crypto.randomUUID(),
      catalogDigest: environment.catalog.digest,
      identity: { serverId: "fixture", toolName: "execute" },
      arguments: {},
      caller: { kind: "codemode", subjectId: "agent:codemode" },
    });
    expect(events).toEqual([
      "fence",
      "begin",
      "execute:model",
      "fence",
      "begin",
      "execute:codemode",
    ]);
  } finally {
    await prepared.close();
  }
});
