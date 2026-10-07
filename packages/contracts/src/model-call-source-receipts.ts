import { z } from "zod";
export const MODEL_CALL_SOURCE_MAX_INPUTS=16384;

/** Source identities are evidence, never permission or instruction authority. */
export const ModelSourceRef = z.object({
  owner: z.string().min(1).max(128),
  id: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().min(1).max(2048).optional(),
}).strict();
export type ModelSourceRef = z.infer<typeof ModelSourceRef>;
export const ModelSourceKind = z.enum(["INSTRUCTION", "HISTORY_ROW", "TOOL_RESULT", "IMPORTED", "SUMMARY", "COPIED", "MEMORY", "KNOWLEDGE"]);
export const ModelSourceClosureNode = z.object({
  sourceRef: ModelSourceRef,
  kind: ModelSourceKind,
  parents: z.array(ModelSourceRef).max(16384),
  retainedSources: z.array(ModelSourceRef).max(16384),
}).strict();
export type ModelSourceClosureNode = z.infer<typeof ModelSourceClosureNode>;
export const ModelSourceInput = z.object({
  ordinal: z.number().int().nonnegative(),
  kind: ModelSourceKind,
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRef: ModelSourceRef.nullable(),
  parents: z.array(ModelSourceRef).max(16384),
  retainedSources: z.array(ModelSourceRef).max(16384),
}).strict();
export type ModelSourceInput = z.infer<typeof ModelSourceInput>;
export const ModelCallSourceReceipt = z.object({
  version: z.literal(1),
  id: z.uuid(), accountId: z.uuid(), workspaceId: z.uuid(), sessionId: z.uuid(),
  turnId: z.uuid(), attemptId: z.uuid(), executionGeneration: z.number().int().positive(),
  sourceKey: z.string().min(1).max(256), requestIndex: z.number().int().positive(),
  purpose: z.enum(["AGENT", "COMPACTION", "TITLE"]),
  inputs: z.array(ModelSourceInput).max(MODEL_CALL_SOURCE_MAX_INPUTS),
  closure: z.array(ModelSourceClosureNode).max(16384),
  complete: z.boolean(),
  incompleteReasons: z.array(z.enum(["EMPTY_BASIS", "UNKNOWN_SOURCE", "UNRESOLVED_PARENT", "CAP_EXCEEDED", "UNAVAILABLE_INPUT", "UNATTRIBUTED_IMPORT"])),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ModelCallSourceReceipt = z.infer<typeof ModelCallSourceReceipt>;
export const ModelCallSourceBasisResponse = z.object({
  schema: z.literal("cendra.native-source-basis/v1"),
  receipt: ModelCallSourceReceipt.nullable(),
}).strict();
export type ModelCallSourceBasisResponse = z.infer<typeof ModelCallSourceBasisResponse>;
export const ImportedMessageOrigin = z.object({
  source: z.string().min(1).max(128), externalId: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ImportedMessageOrigin = z.infer<typeof ImportedMessageOrigin>;

/** Canonical metadata only; callers hash exact input separately. Undefined is JSON-wire absence. */
export function canonicalModelSourceJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Unavailable model source input");
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("Unavailable model source input");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalModelSourceJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalModelSourceJson(object[key])}`).join(",")}}`;
}

/** Trusted producer binding attached before model-input transformation; never an HTTP input. */
export type ModelSourceBinding = {ordinal:number;sourceRef:ModelSourceRef;kind:z.infer<typeof ModelSourceKind>;parents:ModelSourceRef[];retainedSources:ModelSourceRef[];
  /** Native-only transient output owner. The DB re-reads this exact completed call's basis. */
  nativeProducerSourceKey?:string; rawToolSource?:NativeModelToolSource; rawToolResult?:unknown};

export type NativeModelToolSource = {
  sourceCallId:string; nativeModelSourceKey?:string; rawSourceRef:ModelSourceRef;
  retainedSources:ModelSourceRef[];
};
export type ModelHistorySourceBasis = {
  kind:"SUMMARY"|"COPIED"|"IMPORTED"|"TOOL_RESULT"|"INSTRUCTION";
  parents:ModelSourceRef[]; retainedSources?:ModelSourceRef[];
  rawToolSource?:NativeModelToolSource;
};

export const IMPORTED_HISTORY_CONTEXT_HEADER = "Earlier conversation imported from the product, oldest first:";


/** Host authority over one committed native source receipt. Completeness grants no authority.
 * The worker awaits this callback for AGENT, COMPACTION and TITLE before provider dispatch.
 * A rejection prevents that call. Embedded hosts install it in trusted worker dependencies,
 * never in session/model metadata. Standalone hosts may omit it. */
export type AuthorizeModelCallSource = (
  receipt: ModelCallSourceReceipt,
  context: Readonly<{ signal?: AbortSignal }>,
) => Promise<void>;
