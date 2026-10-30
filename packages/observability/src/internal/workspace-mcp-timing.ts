import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkspaceMcpTimingObservation, WorkspaceMcpTimingObserver } from "../mcp-timing";

type HostTiming = { begin: () => { end: () => void } };
export type WorkspaceMcpTimingScope = { current: HostTiming | undefined };
const workspaceTiming = new AsyncLocalStorage<WorkspaceMcpTimingScope>();
const subscribers = new WeakMap<object, Set<WorkspaceMcpTimingObserver>>();

/** Internal transport plumbing; hosts subscribe through Observability. */
export function subscribeWorkspaceMcpTiming(
  owner: object,
  observer: WorkspaceMcpTimingObserver,
): () => void {
  let observers = subscribers.get(owner);
  if (!observers) subscribers.set(owner, (observers = new Set()));
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}
export function hasWorkspaceMcpTimingSubscribers(owner: object): boolean {
  return (subscribers.get(owner)?.size ?? 0) > 0;
}
export function publishWorkspaceMcpTiming(
  owner: object,
  observation: WorkspaceMcpTimingObservation,
): void {
  for (const observer of subscribers.get(owner) ?? []) {
    try {
      const result = observer(observation);
      if (result) void Promise.resolve(result).catch(() => {});
    } catch {
      /* Observer failures never change execution. */
    }
  }
}
/** The shared slot is cleared at response completion, including in inherited work. */
export function withWorkspaceMcpHostTiming<T>(scope: WorkspaceMcpTimingScope, run: () => T): T {
  return workspaceTiming.run(scope, run);
}
export function beginWorkspaceMcpHostHandler(): { end: () => void } | undefined {
  return workspaceTiming.getStore()?.current?.begin();
}
