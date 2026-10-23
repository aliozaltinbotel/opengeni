import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { RunContext } from "@openai/agents-core";
import * as esm from "@openai/agents-core/sandbox";
import type { ExecCommandArgs, SandboxSessionLike } from "@openai/agents-core/sandbox";

// The SDK publishes the same synchronous capability contract in both formats.
const cjs = createRequire(import.meta.url)("@openai/agents-core/sandbox") as typeof esm;

for (const [format, sdk] of [["ESM", esm], ["CJS", cjs]] as const) {
  test(`${format} patched shell tools stay synchronous through clone and rebind`, async () => {
    const calls: ExecCommandArgs[] = [];
    const session: SandboxSessionLike = {
      state: { manifest: new sdk.Manifest({ root: "/workspace" }) },
      execCommand: async (args) => { calls.push(args); return "synthetic command output"; },
      supportsPty: () => true,
      writeStdin: async () => "synthetic stdin output",
    };
    const original = sdk.shell().bind(session);
    const rebound = original.clone().bind(session).bindRunAs("synthetic-runner");
    const tools = rebound.tools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.map((tool) => tool.type === "function" ? tool.name : tool.type))
      .toEqual(["exec_command", "write_stdin"]);
    const command = tools.find((tool) => tool.type === "function" && tool.name === "exec_command");
    if (!command || command.type !== "function") throw new Error("Expected SDK exec_command");
    expect(await command.invoke(new RunContext({}), JSON.stringify({ cmd: "synthetic-command" })))
      .toBe("synthetic command output");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.runAs).toBe("synthetic-runner");
  });

  test(`${format} patched exec error callback retains the exact typed error and context`, async () => {
    class SyntheticAdmissionError extends Error {}
    const refusal = new SyntheticAdmissionError("synthetic admission refusal");
    const context = new RunContext({});
    let callbacks = 0;
    const session: SandboxSessionLike = {
      state: { manifest: new sdk.Manifest({ root: "/workspace" }) },
      execCommand: async () => { throw refusal; },
    };
    const capability = sdk.shell({ execCommandErrorFunction: (receivedContext, error) => {
      callbacks++;
      expect(receivedContext).toBe(context);
      expect(error).toBe(refusal);
      throw error;
    } }).clone().bind(session);
    const tools = capability.tools();
    expect(Array.isArray(tools)).toBe(true);
    const command = tools.find((tool) => tool.type === "function" && tool.name === "exec_command");
    if (!command || command.type !== "function") throw new Error("Expected SDK exec_command");
    await expect(command.invoke(context, JSON.stringify({ cmd: "synthetic-command" }))).rejects.toBe(refusal);
    expect(callbacks).toBe(1);
  });
}
