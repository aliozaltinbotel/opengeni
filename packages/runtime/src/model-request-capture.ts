import type { ModelSourceBinding, NativeModelToolSource } from "@opengeni/contracts";
import { rememberPreparedModelRequest } from "./prepared-compaction-request";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Model, ModelProvider, ModelRequest, StreamEvent } from "@openai/agents";

export type ModelRequestCapture = ((request: ModelRequest) => void | Promise<void>) & {
  /** Authoritative, awaited owner; persistence failure prevents calling the model. */
  beforeCall?: (request: ModelRequest) => Promise<string>;
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
    const callId=typeof item.callId==="string"?item.callId:typeof item.call_id==="string"?item.call_id:null;
    if(item.type!=="function_call" || !callId) continue;
    const prior=capture.toolSourceKeys.get(callId);
    if(prior && prior!==sourceKey) throw new Error("MODEL_SOURCE_CALL_ID_COLLISION");
    capture.toolSourceKeys.set(callId,sourceKey);
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
    rememberPreparedModelRequest(request);
    void notifyModelRequestCapture(request);
    const capture = modelRequestCapture.getStore();
    const sourceKey = await capture?.beforeCall?.(request);
    const response = await this.inner.getResponse(request);
    if (sourceKey) {
      bindOutputSourceKeys(capture,sourceKey,response.output);
      await capture?.callCompleted?.(sourceKey,response.responseId ?? null,response);
    }
    return response;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    rememberPreparedModelRequest(request);
    void notifyModelRequestCapture(request);
    const capture = modelRequestCapture.getStore();
    const sourceKey = await capture?.beforeCall?.(request);
    for await (const event of this.inner.getStreamedResponse(request)) {
      const candidate=event.type==="response_done" ? event.response : event.type==="model" && event.event && typeof event.event==="object" && (event.event as Record<string,unknown>).type==="response.completed" ? (event.event as Record<string,unknown>).response : null;
      if(sourceKey && candidate && typeof candidate==="object") {
        const response=candidate as Record<string,unknown>;
        bindOutputSourceKeys(capture,sourceKey,Array.isArray(response.output)?response.output:[]);
        await capture?.callCompleted?.(sourceKey,typeof response.id==="string"?response.id:null,response);
      }
      yield event;
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
export async function recordModelToolSource(source:NativeModelToolSource):Promise<void> {
  await modelRequestCapture.getStore()?.onModelToolSource?.(source);
}
