import { createHash } from "node:crypto";
import { withModelRequestCapture, type ModelRequestCapture } from "../src/model-request-capture";
import { describe, expect, test } from "bun:test";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  TOOL_RESULT_SPILL_MEDIA_TYPE,
  toolResultSpillFilename,
  toolResultSpillSandboxPath,
  type AttemptToolResult,
} from "@opengeni/contracts";
import { MCP_MAX_TOOL_RESULT_BYTES } from "../src/mcp-network";
import {
  modelToolResultOverflowError,
  projectAttemptToolResultForCaller,
  spilledModelToolResult,
  wrapAttemptToolDefinitions,
  wrapAttemptToolExecute,
  type SpillOversizedModelToolResult,
} from "../src/tool-result-spill";

const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function context(kind: "model" | "codemode"): AttemptToolExecutionContext {
  return {
    operationId: OPERATION_ID,
    caller: { kind, subjectId: kind === "codemode" ? "codemode:test" : "worker:mcp-model" },
  };
}

function smallResult(): AttemptToolResult {
  return {
    content: [{ type: "text", text: "ok" }],
    structuredContent: { ok: true },
  };
}

function oversizedResult(): AttemptToolResult {
  return {
    content: [{ type: "text", text: "x".repeat(MCP_MAX_TOOL_RESULT_BYTES + 1) }],
  };
}

describe("attempt tool result caller projection", () => {
  test("names spilled files from the operation UUID", () => {
    expect(toolResultSpillFilename(OPERATION_ID)).toBe(`${OPERATION_ID}.json`);
    expect(toolResultSpillFilename(OPERATION_ID.toUpperCase())).toBe(`${OPERATION_ID}.json`);
    expect(toolResultSpillSandboxPath(`${OPERATION_ID}.json`)).toBe(
      `/workspace/tool-results/${OPERATION_ID}.json`,
    );
    expect(() => toolResultSpillFilename("not-a-uuid")).toThrow(/lowercase UUID/);
  });
  test("Codemode caller keeps a result larger than the 1 MiB model cap", async () => {
    const result = oversizedResult();
    const projected = await projectAttemptToolResultForCaller(result, context("codemode"));
    expect(projected).toBe(result);
    expect(projected.isError).toBeUndefined();
  });

  test("model caller returns a fitting result unchanged", async () => {
    const result = smallResult();
    expect(await projectAttemptToolResultForCaller(result, context("model"))).toBe(result);
  });

  test("model caller without a spill port returns result_too_large", async () => {
    const projected = await projectAttemptToolResultForCaller(oversizedResult(), context("model"));
    expect(projected).toEqual(modelToolResultOverflowError());
    expect(JSON.stringify(projected.structuredContent ?? {})).not.toContain("x".repeat(64));
  });

  test("model caller spills exact bytes and returns the compact receipt", async () => {
    const result = oversizedResult();
    const receipt = {
      type: "tool_result_spilled" as const,
      sandboxPath: toolResultSpillSandboxPath(`${OPERATION_ID}.json`),
      fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      byteSize: MCP_MAX_TOOL_RESULT_BYTES + 64,
      mediaType: TOOL_RESULT_SPILL_MEDIA_TYPE,
    };
    const spill: SpillOversizedModelToolResult = async (input) => {
      expect(input.operationId).toBe(OPERATION_ID);
      expect(input.result).toBe(result);
      expect(input.serializedBytes).toBeGreaterThan(MCP_MAX_TOOL_RESULT_BYTES);
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        structuredContent: receipt,
      };
    };
    const projected = await projectAttemptToolResultForCaller(result, context("model"), spill);
    expect(projected.isError).toBe(false);
    expect(projected.structuredContent).toEqual(receipt);
    expect(projected.content[0]).toEqual({ type: "text", text: JSON.stringify(receipt) });
    expect(JSON.stringify(projected)).not.toContain("x".repeat(64));
  });

  test("model spill failure returns result_too_large without the huge payload", async () => {
    const projected = await projectAttemptToolResultForCaller(
      oversizedResult(),
      context("model"),
      async () => {
        throw new Error("object storage unavailable");
      },
    );
    expect(projected).toEqual(modelToolResultOverflowError());
    expect(JSON.stringify(projected)).not.toContain("x".repeat(64));
  });

  test("wrapAttemptToolExecute branches on caller kind", async () => {
    const execute = wrapAttemptToolExecute(async () => oversizedResult());
    const codemode = await execute({}, context("codemode"));
    expect(codemode).toEqual(oversizedResult());
    const model = await execute({}, context("model"));
    expect(model).toEqual(modelToolResultOverflowError());
  });

  test("wrapAttemptToolDefinitions wraps every execute", async () => {
    const [wrapped] = wrapAttemptToolDefinitions([
      {
        identity: { serverId: "interaction", toolName: "echo" },
        modelName: "echo",
        inputSchema: { type: "object" },
        source: "interaction",
        approval: "none",
        execute: async () => smallResult(),
      },
    ]);
    expect(wrapped).toBeDefined();
    expect(await wrapped!.execute({}, context("model"))).toEqual(smallResult());
  });
});

describe("spilledModelToolResult", () => {
  test("projects the cwd-relative shell path while durable receipts stay virtual", () => {
    const filename = toolResultSpillFilename(OPERATION_ID);
    const projected = spilledModelToolResult({
      type: "tool_result_spilled",
      sandboxPath: toolResultSpillSandboxPath(filename),
      fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      byteSize: 64,
      mediaType: TOOL_RESULT_SPILL_MEDIA_TYPE,
    });
    expect(projected.structuredContent).toMatchObject({
      type: "tool_result_spilled",
      sandboxPath: `tool-results/${filename}`,
    });
    expect(JSON.stringify(projected)).not.toContain("/workspace/tool-results/");
  });
});

// Raw-result capture must happen before either model compaction or oversized spill.
test("native source capture preserves exact raw digest and retained refs before spill",async()=>{
 const raw=oversizedResult();const ref={owner:"fixture.retained_revision",id:OPERATION_ID,version:"1",sha256:createHash("sha256").update("Synthetic source").digest("hex")};
 const events:string[]=[];const capture:ModelRequestCapture=()=>{};capture.onModelToolSource=async source=>{events.push("capture");expect(source.nativeModelSourceKey).toBe("exact-source");expect(source.rawSourceRef.sha256).toBe(createHash("sha256").update(JSON.stringify(raw)).digest("hex"));expect(source.retainedSources).toEqual([ref]);};
 const execute=wrapAttemptToolExecute(async()=>raw,async()=>{events.push("spill");return smallResult();},undefined,()=>[ref]);
 await withModelRequestCapture(capture,()=>execute({}, {...context("model"),sourceCallId:"sdk-call",nativeModelSourceKey:"exact-source"}));expect(events).toEqual(["capture","spill"]);
 capture.onModelToolSource=async()=>{throw Error("source unavailable");};events.length=0;await expect(withModelRequestCapture(capture,()=>execute({}, {...context("model"),sourceCallId:"sdk-call"}))).rejects.toThrow("source unavailable");expect(events).toEqual([]);
});
