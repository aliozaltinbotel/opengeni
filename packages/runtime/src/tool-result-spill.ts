import { createHash } from "node:crypto";
import { recordModelToolSource } from "./model-request-capture";
import type { AttemptToolDefinition, AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  ModelSourceRef,
  WorkspaceMemorySearchResponse,
  KnowledgeEntryRecord,
  KnowledgeEntryListResponse,
  KnowledgeSavePreparationResponse,
  ToolResultSpilledReceipt,
  sandboxShellPath,
  type AttemptToolIdentity,
  type AttemptToolResult as AttemptToolResultValue,
  type ToolResultSpilledReceipt as ToolResultSpilledReceiptValue,
} from "@opengeni/contracts";
import { projectKnowledgeToolResultForModel } from "./knowledge-model-projection";
import { MCP_MAX_TOOL_RESULT_BYTES, mcpSerializedSizeBytes } from "./mcp-network";

export type SpillOversizedModelToolResult = (input: {
  operationId: string;
  result: AttemptToolResultValue;
  serializedBytes: number;
}) => Promise<AttemptToolResultValue>;

const OVERFLOW_ERROR = {
  code: "result_too_large",
  message: "Tool result exceeded the bounded model-visible size.",
  retryable: false,
} as const;

export function modelToolResultOverflowError(): AttemptToolResultValue {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: OVERFLOW_ERROR }) }],
    structuredContent: { error: OVERFLOW_ERROR },
  };
}

export function spilledModelToolResult(
  receipt: ToolResultSpilledReceiptValue,
): AttemptToolResultValue {
  // Rematerialization keeps the virtual `/workspace/tool-results/...` path.
  // The model-visible receipt is cwd-relative so exec_command can open the copy
  // on a Connected Machine (no `/workspace` directory exists there).
  const structuredContent = ToolResultSpilledReceipt.parse({
    ...receipt,
    sandboxPath: receipt.sandboxPath === null ? null : sandboxShellPath(receipt.sandboxPath),
  });
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/** True when the model receives this result as is, without a spill or overflow error. */
export function modelToolResultFits(result: AttemptToolResultValue): boolean {
  return mcpSerializedSizeBytes(result) <= MCP_MAX_TOOL_RESULT_BYTES;
}

/**
 * The single per-caller seam over one executor result. Codemode receives the
 * exact result. The model receives its model-visible projection (compact
 * Knowledge discovery output for the exact tool identity) when that fits in
 * 1 MiB; otherwise the exact result is spilled to a file, as for any tool.
 * MCP-backed tools are already bounded on their exact result by the MCP
 * transport cap before this seam runs.
 */
export async function projectAttemptToolResultForCaller(
  result: AttemptToolResultValue,
  context: AttemptToolExecutionContext,
  spill?: SpillOversizedModelToolResult,
  identity?: AttemptToolIdentity,
): Promise<AttemptToolResultValue> {
  switch (context.caller.kind) {
    case "codemode":
      return result;
    case "model": {
      const visible = identity ? projectKnowledgeToolResultForModel(identity, result) : result;
      if (modelToolResultFits(visible)) return visible;
      if (!spill) return modelToolResultOverflowError();
      try {
        return await spill({
          operationId: context.operationId,
          result,
          serializedBytes: mcpSerializedSizeBytes(result),
        });
      } catch {
        return modelToolResultOverflowError();
      }
    }
    default: {
      const unexpected: never = context.caller.kind;
      throw new Error(`unhandled tool caller ${unexpected}`);
    }
  }
}

export function wrapAttemptToolExecute(
  execute: AttemptToolDefinition["execute"],
  spill?: SpillOversizedModelToolResult,
  identity?: AttemptToolIdentity,
  sourceRefs?: (
    result: AttemptToolResultValue,
    context: AttemptToolExecutionContext,
  ) => readonly import("@opengeni/contracts").ModelSourceRef[] | Promise<readonly import("@opengeni/contracts").ModelSourceRef[]>,
): AttemptToolDefinition["execute"] {
  return async (args,context) => {
    const result=await execute(args,context);
    if(context.caller.kind==="model" && context.sourceCallId) {
      const retainedSources=(await sourceRefs?.(result,context) ?? nativeKnowledgeSources(result,identity)).map(ref=>ModelSourceRef.parse(ref));
      await recordModelToolSource({sourceCallId:context.sourceCallId,
        ...(context.nativeModelSourceKey?{nativeModelSourceKey:context.nativeModelSourceKey}:{}),
        rawSourceRef:{owner:"native.tool.result",id:context.operationId,sha256:createHash("sha256").update(JSON.stringify(result)).digest("hex")},retainedSources},result);
    }
    return await projectAttemptToolResultForCaller(result,context,spill,identity);
  };
}

export function wrapAttemptToolDefinitions(
  definitions: readonly AttemptToolDefinition[],
  spill?: SpillOversizedModelToolResult,
): AttemptToolDefinition[] {
  return definitions.map(({ modelSourceRefs, ...definition }) => ({
    ...definition,
    execute: wrapAttemptToolExecute(definition.execute, spill, definition.identity,modelSourceRefs),
  }));
}

function nativeKnowledgeSources(result:AttemptToolResultValue,identity?:AttemptToolIdentity):import("@opengeni/contracts").ModelSourceRef[] {
  if(!identity || !["opengeni","docs"].includes(identity.serverId) || !(identity.toolName.startsWith("knowledge_") || identity.toolName==="memory_search")) return [];
  let value:unknown=result.structuredContent;
  if(value===undefined && result.content.length===1 && result.content[0]?.type==="text") {try{value=JSON.parse(result.content[0].text);}catch{return [];}}
  if(identity.toolName==="memory_search") {
    const parsed=WorkspaceMemorySearchResponse.safeParse(value);if(!parsed.success)return [];
    return parsed.data.results.map(({memory})=>({owner:"native.memory.selection",id:memory.id,version:memory.updatedAt,sha256:createHash("sha256").update(JSON.stringify(memory)).digest("hex")}));
  }
  const list=KnowledgeEntryListResponse.safeParse(value);const entry=KnowledgeEntryRecord.safeParse(value);const prepared=KnowledgeSavePreparationResponse.safeParse(value);
  const selections=list.success?list.data.entries:entry.success?[entry.data]:prepared.success?[...prepared.data.matches.published.entries,...prepared.data.matches.needs_review.entries]:[];
  return selections.map(selection=>({owner:"native.knowledge.selection",id:selection.revision.id,version:String(selection.version),sha256:createHash("sha256").update(JSON.stringify(selection.revision)).digest("hex")}));
}
