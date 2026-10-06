import { canonicalModelSourceJson, type ModelSourceBinding, type NativeModelToolSource } from "@opengeni/contracts";
import { createHash } from "node:crypto";
import { toSmartString } from "@openai/agents-core/utils";
import { protocol } from "@openai/agents-core";
import { rememberPreparedModelRequest } from "./prepared-compaction-request";
import { stripProviderItemId } from "./model-input";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentInputItem, Model, ModelProvider, ModelRequest, StreamEvent } from "@openai/agents";

/** One exact source producer; the optional dispatch callback rechecks that same
 * committed source at each literal transport attempt, including HTTP retries. */
export type BeforeModelCallSourceReceipt = ((request: ModelRequest) => Promise<string>) & {
  beforeProviderDispatch?: (sourceKey: string) => Promise<void>;
};
const modelSourceDispatch = new AsyncLocalStorage<{ sourceKey: string; authorize: (sourceKey: string) => Promise<void> } | undefined>();

export function withModelCallSourceDispatch<T>(
  producer: BeforeModelCallSourceReceipt | undefined,
  sourceKey: string | undefined,
  operation: () => T,
): T {
  if (!producer?.beforeProviderDispatch) return modelSourceDispatch.run(undefined, operation);
  if (!sourceKey) throw new Error("MODEL_SOURCE_RECEIPT_UNAVAILABLE");
  return modelSourceDispatch.run({ sourceKey, authorize: producer.beforeProviderDispatch }, operation);
}

/** Called only at the real provider transport boundary, before request bytes. */
export async function authorizeModelSourceProviderDispatch(): Promise<void> {
  const context = modelSourceDispatch.getStore();
  if (context) await context.authorize(context.sourceKey);
}

export type ModelRequestCapture = ((request: ModelRequest) => void | Promise<void>) & {
  /** Authoritative, awaited owner; persistence failure prevents calling the model. */
  beforeCall?: BeforeModelCallSourceReceipt;
  callCompleted?: (sourceKey:string,responseId:string|null,response:object) => void | Promise<void>;
  toolSourceKeys?: Map<string,string>;
  onModelToolSource?:(source:NativeModelToolSource)=>Promise<void>;
  nextProviderRequestIndex?: () => number;
  onProviderRequest?: (
    provider: string,
    body: string | null,
    reason?: string,
    index?: number,
  ) => void | Promise<void>;
};
const modelRequestCapture = new AsyncLocalStorage<ModelRequestCapture>();
const captureIndices = new WeakMap<object, number>();
const nativeSourceBinding = Symbol("native-model-source-owner");
type InputBinding = Omit<ModelSourceBinding,"ordinal">;
const producedSources = new WeakMap<ModelRequestCapture, {
  outputs: Map<string,InputBinding|null>;
  tools: Map<string,{source:NativeModelToolSource; rawResult?:unknown; projection?:string; modelName?:string}>;
}>();
function sourceState(capture:ModelRequestCapture) {
  let state=producedSources.get(capture);
  if(!state) {state={outputs:new Map(),tools:new Map()};producedSources.set(capture,state);}
  return state;
}
const inputDigest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Symbol metadata follows existing object-spread projections but never JSON/model input. */
export function bindModelSourceInput<T extends object>(item:T,binding:Omit<ModelSourceBinding,"ordinal">):T {
  Object.defineProperty(item,nativeSourceBinding,{value:binding,enumerable:true,configurable:true});
  return item;
}
/** Remove only this owner's non-wire binding after durable source refs have been captured. */
export function omitModelSourceInputBinding<T extends object>(item:T):T {
  const persisted:T & {[nativeSourceBinding]?:Omit<ModelSourceBinding,"ordinal">}=Object.create(Object.getPrototypeOf(item),Object.getOwnPropertyDescriptors(item));
  delete persisted[nativeSourceBinding];
  return persisted;
}
export function modelSourceInputBinding(item:unknown):Omit<ModelSourceBinding,"ordinal">|undefined {
  return item && typeof item==="object" ? (item as {[nativeSourceBinding]?:Omit<ModelSourceBinding,"ordinal">})[nativeSourceBinding] : undefined;
}
export function modelSourceBindings(input:unknown):ModelSourceBinding[] {
  if(!Array.isArray(input)) return [];
  return input.flatMap((item,ordinal)=>{const binding=modelSourceInputBinding(item);return binding?[{...binding,ordinal}]:[];});
}


export function nativeModelSourceKeyForToolCall(callId: string | undefined): string | undefined {
  return callId ? modelRequestCapture.getStore()?.toolSourceKeys?.get(callId) : undefined;
}

function bindOutputSourceKeys(capture:ModelRequestCapture|undefined, sourceKey:string, output:readonly unknown[]):void {
  if (!capture) return;
  capture.toolSourceKeys ??= new Map();
  for (const value of output) {
    if (!value || typeof value!=="object") continue;
    const item=value as Record<string,unknown>;
    const sha256=inputDigest(item);
    const binding:InputBinding={kind:"HISTORY_ROW",sourceRef:{owner:"native.runtime.artifact",id:`model-output:${sourceKey}:${sha256}`,sha256},parents:[],retainedSources:[],nativeProducerSourceKey:sourceKey};
    bindModelSourceInput(item,binding);
    const outputs=sourceState(capture).outputs;
    const priorOutput=outputs.get(sha256);
    outputs.set(sha256,priorOutput!==undefined && priorOutput?.nativeProducerSourceKey!==sourceKey?null:binding);
    // The streaming Runner parses function calls through its installed protocol
    // schema, changing property order and dropping owner symbols. Register that
    // exact projection of this output, then the existing provider-id projection.
    // Each alias retains the original byte digest; input is never canonicalized
    // or matched by call id alone.
    const projections=[stripProviderItemId(item as AgentInputItem)];
    if(item.type==="function_call") {
      const parsed=protocol.FunctionCallItem.safeParse(item);
      if(parsed.success)projections.push(parsed.data,stripProviderItemId(parsed.data));
    }
    for(const projected of projections) {
      const projectedSha256=inputDigest(projected);
      if(projectedSha256===sha256)continue;
      const projectedBinding:InputBinding={...binding,sourceRef:{...binding.sourceRef,id:`model-output:${sourceKey}:${sha256}:projection:${projectedSha256}`,sha256:projectedSha256}};
      const priorProjection=outputs.get(projectedSha256);
      outputs.set(projectedSha256,priorProjection!==undefined && priorProjection?.sourceRef.id!==projectedBinding.sourceRef.id?null:projectedBinding);
    }
    const callId=typeof item.callId==="string"?item.callId:typeof item.call_id==="string"?item.call_id:null;
    if(item.type!=="function_call" || !callId) continue;
    const prior=capture.toolSourceKeys.get(callId);
    if(prior && prior!==sourceKey) throw new Error("MODEL_SOURCE_CALL_ID_COLLISION");
    capture.toolSourceKeys.set(callId,sourceKey);
  }
}

/** Observe the final SDK function return, after its actual MCP projection. */
export function recordModelToolProjection(callId:string|undefined,modelName:string,output:unknown):void {
  const capture=modelRequestCapture.getStore();
  if(!capture || !callId) return;
  const tool=sourceState(capture).tools.get(callId);
  if(!tool || tool.source.nativeModelSourceKey!==capture.toolSourceKeys?.get(callId))return;
  tool.projection=toSmartString(output);tool.modelName=modelName;
}

/** SDK continuation objects may be copies. Match only this scope's actual native
 * output bytes or its exact completed call and final text projection. */
function restoreProducedSourceBindings(request:ModelRequest,capture:ModelRequestCapture|undefined):void {
  if(!capture || !Array.isArray(request.input))return;
  const state=sourceState(capture);
  for(const value of request.input) {
    if(!value || typeof value!=="object" || modelSourceInputBinding(value))continue;
    const item=value as Record<string,unknown>;
    const sha256=inputDigest(item),model=state.outputs.get(sha256);
    if(model) {bindModelSourceInput(item,model);continue;}
    if(item.type!=="function_call_result" || item.status!=="completed" || typeof item.callId!=="string")continue;
    const tool=state.tools.get(item.callId);
    if(!tool?.source.nativeModelSourceKey || tool.rawResult===undefined || tool.projection===undefined || item.name!==tool.modelName
      || canonicalModelSourceJson(item.output)!==canonicalModelSourceJson({type:"text",text:tool.projection}))continue;
    bindModelSourceInput(item,{kind:"TOOL_RESULT",sourceRef:{owner:"native.runtime.artifact",id:`tool-projection:${tool.source.rawSourceRef.id}:${sha256}`,sha256},
      parents:[tool.source.rawSourceRef],retainedSources:tool.source.retainedSources,nativeProducerSourceKey:tool.source.nativeModelSourceKey,rawToolSource:tool.source,rawToolResult:tool.rawResult});
  }
}

/** The same agent can re-enter runAgentStream after in-activity compaction. */
export function nextModelContextCaptureIndex(agent: object): number {
  const index = (captureIndices.get(agent) ?? 0) + 1;
  captureIndices.set(agent, index);
  return index;
}

export function withModelRequestCapture<T>(
  capture: ModelRequestCapture | undefined,
  fn: () => T,
): T {
  return capture ? modelRequestCapture.run(capture, fn) : fn();
}

/** Observe the final transport bytes, never reconstruct provider serialization.
 * Tee only while an inspector observer exists. Bound diagnostic memory; retain
 * an explicit unavailable receipt instead of a partial or older payload.
 */
export function captureProviderRequestBody(
  provider: string,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): { init: RequestInit | undefined; captured: Promise<void>; cancel: () => void } {
  const context = modelRequestCapture.getStore();
  const callback = context?.onProviderRequest;
  if (!callback) return { init, captured: Promise.resolve(), cancel: () => {} };
  // Reserve identity at dispatch, not when asynchronous reading finishes.
  const index = context.nextProviderRequestIndex?.();
  const observer = (providerId: string, body: string | null, reason?: string) =>
    callback(providerId, body, reason, index);
  let cancel = () => {};
  let body = init?.body;
  let nextInit = init;
  if (body instanceof ReadableStream) {
    const [sent, inspected] = body.tee();
    nextInit = { ...init, body: sent };
    body = inspected;
  } else if (body == null && input instanceof Request) {
    body = input.clone().body;
  }
  const captured = (async () => {
    const limit = 4 * 1024 * 1024;
    let text: string;
    if (typeof body === "string") {
      if (Buffer.byteLength(body, "utf8") > limit) {
        await observer(provider, null, "Request exceeds the 4 MiB capture limit.");
        return;
      }
      text = body;
    } else if (body instanceof ReadableStream) {
      const reader = body.getReader();
      let cancelled = false;
      cancel = () => {
        cancelled = true;
        void reader.cancel().catch(() => undefined);
      };
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const chunks: string[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > limit) {
            void reader.cancel().catch(() => undefined);
            await observer(provider, null, "Request exceeds the 4 MiB capture limit.");
            return;
          }
          chunks.push(decoder.decode(chunk.value, { stream: true }));
        }
        if (cancelled) return;
        chunks.push(decoder.decode());
        text = chunks.join("");
      } catch {
        void reader.cancel().catch(() => undefined);
        if (!cancelled)
          await observer(provider, null, "The provider body could not be read as UTF-8.");
        return;
      } finally {
        signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
        cancel = () => {};
      }
    } else {
      await observer(provider, null, "This transport body cannot be inspected.");
      return;
    }
    await observer(provider, text);
  })().catch(() => undefined); // Inspection cannot change inference.
  return { init: nextInit, captured, cancel: () => cancel() };
}

export async function notifyModelRequestCapture(request: ModelRequest): Promise<void> {
  const capture = modelRequestCapture.getStore();
  if (!capture) return;
  try {
    // Copy the SDK request immediately. This is not the provider wire body.
    // object after we yield to persistence.
    await capture(snapshotModelRequestPrefix(request));
  } catch {
    // Observational. A failure must never change model execution.
  }
}

function snapshotModelRequestPrefix(request: ModelRequest): ModelRequest {
  return {
    ...request,
    tools: structuredClone(request.tools),
  };
}

export class ModelRequestCaptureModel implements Model {
  constructor(private readonly inner: Model) {}

  async getResponse(request: ModelRequest) {
    const capture = modelRequestCapture.getStore();
    restoreProducedSourceBindings(request,capture);
    rememberPreparedModelRequest(request);
    void notifyModelRequestCapture(request);
    const sourceKey = await capture?.beforeCall?.(request);
    const response = await withModelCallSourceDispatch(capture?.beforeCall, sourceKey, () => this.inner.getResponse(request));
    if (sourceKey) {
      bindOutputSourceKeys(capture,sourceKey,response.output);
      await capture?.callCompleted?.(sourceKey,response.responseId ?? null,response);
    }
    return response;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const capture = modelRequestCapture.getStore();
    restoreProducedSourceBindings(request,capture);
    rememberPreparedModelRequest(request);
    void notifyModelRequestCapture(request);
    const sourceKey = await capture?.beforeCall?.(request);
    const iterator = withModelCallSourceDispatch(capture?.beforeCall, sourceKey, () =>
      this.inner.getStreamedResponse(request)[Symbol.asyncIterator](),
    );
    let finished = false;
    try {
      while (true) {
        const next = await withModelCallSourceDispatch(capture?.beforeCall, sourceKey, () => iterator.next());
        if (next.done) { finished = true; return; }
        const event = next.value;
        const candidate=event.type==="response_done" ? event.response : event.type==="model" && event.event && typeof event.event==="object" && (event.event as Record<string,unknown>).type==="response.completed" ? (event.event as Record<string,unknown>).response : null;
        if(sourceKey && candidate && typeof candidate==="object") {
          const response=candidate as Record<string,unknown>;
          bindOutputSourceKeys(capture,sourceKey,Array.isArray(response.output)?response.output:[]);
          await capture?.callCompleted?.(sourceKey,typeof response.id==="string"?response.id:null,response);
        }
        yield event;
      }
    } finally {
      if (!finished && iterator.return) await withModelCallSourceDispatch(capture?.beforeCall, sourceKey, () => iterator.return!());
    }
  }

  getRetryAdvice(args: Parameters<NonNullable<Model["getRetryAdvice"]>>[0]) {
    return this.inner.getRetryAdvice?.(args);
  }
}

/**
 * Wrap every name-resolved model so Debug capture sees the ModelRequest the
 * provider client actually receives. OpenGeni agents almost always set
 * `agent.model` to a string; wrapping only `agent.model` is a no-op there.
 */
export class ModelRequestCaptureProvider implements ModelProvider {
  constructor(private readonly inner: ModelProvider) {}

  async getModel(modelName?: string): Promise<Model> {
    const model = await this.inner.getModel(modelName);
    if (model instanceof ModelRequestCaptureModel) return model;
    return new ModelRequestCaptureModel(model);
  }
}

/** Runs in the same native call owner before the model-visible projection. */
export async function recordModelToolSource(source:NativeModelToolSource,rawResult?:unknown):Promise<void> {
  const capture=modelRequestCapture.getStore();
  const owned=structuredClone(source);
  const ownedResult=rawResult===undefined?undefined:structuredClone(rawResult);
  await capture?.onModelToolSource?.(source);
  if(capture)sourceState(capture).tools.set(owned.sourceCallId,{source:owned,...(ownedResult===undefined?{}:{rawResult:ownedResult})});
}
