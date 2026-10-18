import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Agent, Runner, tool, type Model, type ModelRequest, type StreamEvent } from "@openai/agents";
import { ScriptedModel, functionCall } from "@opengeni/testing";
import { observeStreamEmissionTimes } from "../src/activities/streaming";

// Contract with the PINNED Agents SDK. Tool event `occurredAt` (stream-attempt.ts)
// comes from `observeStreamEmissionTimes`, which wraps the run result's internal
// `_addItem`. If an SDK upgrade renames, privatises or bypasses that funnel, the
// worker silently falls back to append time; this test fails loudly instead.

const workerManifest = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const pinned = workerManifest.dependencies?.["@openai/agents-core"] ?? workerManifest.devDependencies?.["@openai/agents-core"];

test("the installed @openai/agents-core is the version the worker pins", () => {
  const require = createRequire(join(import.meta.dir, "../package.json"));
  const installed = JSON.parse(readFileSync(require.resolve("@openai/agents-core/package.json"), "utf8")) as { version: string };
  // Moving this pin means re-proving the `_addItem` emission contract below.
  expect(pinned).toBe("0.14.3");
  expect(installed.version).toBe(pinned!);
});

test("the real StreamedRunResult emits tool items through _addItem, bracketing the batch's execution", async () => {
  const executions = new Map<string, { startedAt: number; endedAt: number }>();
  const read = tool({
    name: "read",
    description: "Synthetic read",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    strict: true,
    execute: async (input) => {
      const { id } = input as { id: string };
      const startedAt = Date.now();
      await Bun.sleep(100);
      executions.set(id, { startedAt, endedAt: Date.now() });
      return `read ${id}`;
    },
  });
  // The model answers only after the emission observer is installed.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scripted = new ScriptedModel([
    { output: [functionCall("read", { id: "a" }, "call_a"), functionCall("read", { id: "b" }, "call_b")] },
    { outputText: "Both read." },
  ]);
  const model: Model = {
    async getResponse(request: ModelRequest) { await gate; return scripted.getResponse(request); },
    async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> { await gate; yield* scripted.getStreamedResponse(request); },
  };
  const agent = new Agent({ name: "contract", model, instructions: "Read both.", tools: [read] });
  const result = await new Runner({ tracingDisabled: true }).run(agent, "Read a and b", { stream: true, maxTurns: 3 });

  expect(typeof (result as unknown as { _addItem?: unknown })._addItem).toBe("function");
  const emittedAt = observeStreamEmissionTimes(result);
  release();

  const called = new Map<string, number>();
  const outputs = new Map<string, number>();
  for await (const event of result.toStream()) {
    if (event.type !== "run_item_stream_event") continue;
    const raw = (event.item as { rawItem?: { callId?: string } }).rawItem;
    const at = emittedAt(event)?.getTime();
    if (event.item.type === "tool_call_item" && raw?.callId) {
      expect(at).toBeNumber();
      called.set(raw.callId, at!);
    }
    if (event.item.type === "tool_call_output_item" && raw?.callId) {
      expect(at).toBeNumber();
      outputs.set(raw.callId, at!);
    }
  }
  await result.completed;

  expect([...called.keys()].sort()).toEqual(["call_a", "call_b"]);
  expect([...outputs.keys()].sort()).toEqual(["call_a", "call_b"]);
  const batchEnd = Math.max(...[...executions.values()].map((execution) => execution.endedAt));
  for (const [callId, id] of [["call_a", "a"], ["call_b", "b"]] as const) {
    const execution = executions.get(id)!;
    // Emitted immediately before the SDK executes the batch, and after it ends.
    expect(called.get(callId)!).toBeLessThanOrEqual(execution.startedAt);
    expect(outputs.get(callId)!).toBeGreaterThanOrEqual(batchEnd);
    expect(outputs.get(callId)! - called.get(callId)!).toBeGreaterThanOrEqual(100);
  }
});
