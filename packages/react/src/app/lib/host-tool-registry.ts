// The session timeline's tool registry: the host's tool cards ahead of the
// built-in renderers. Session-only on purpose: the timeline renderers stay out
// of the page's eager graph, which imports app-host.
import { useMemo, useSyncExternalStore } from "react";

import {
  createDefaultToolRegistry,
  defaultToolRegistry,
  rawTypeOf,
  type ToolCallItem,
  type ToolRegistry,
  type ToolRegistryEntry,
} from "../../timeline";
import { builtInToolRegistryEntries } from "../../timeline/tool-renderers";
import { useAppHost } from "./app-host";

type ToolRegistryLoader = () => Promise<readonly ToolRegistryEntry[]>;

type LoaderStatus = "idle" | "pending" | "loaded" | "failed";

/**
 * One loader's entries across every chat on the page. `settled` is undefined
 * until the loader settles, then the loaded entries (none after a failure); it
 * is the store snapshot, so it changes once.
 */
type LazyEntries = {
  status: LoaderStatus;
  settled: readonly ToolRegistryEntry[] | undefined;
  readonly listeners: Set<() => void>;
  readonly start: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => readonly ToolRegistryEntry[] | undefined;
};

const NO_ENTRIES: readonly ToolRegistryEntry[] = Object.freeze([]);

// Keyed by the loader itself: it runs at most once per page, and a failure is
// final for that loader rather than retried by the next chat that opens.
const lazyEntriesByLoader = new WeakMap<ToolRegistryLoader, LazyEntries>();

function settle(
  state: LazyEntries,
  status: "loaded" | "failed",
  entries: readonly ToolRegistryEntry[],
): void {
  state.status = status;
  state.settled = entries;
  for (const listener of [...state.listeners]) listener();
}

function lazyEntriesOf(loader: ToolRegistryLoader): LazyEntries {
  const known = lazyEntriesByLoader.get(loader);
  if (known) return known;
  const state: LazyEntries = {
    status: "idle",
    settled: undefined,
    listeners: new Set(),
    // Called while a chat renders: it only starts the load, and listeners hear
    // about the result later, from the settled promise.
    start() {
      if (state.status !== "idle") return;
      state.status = "pending";
      new Promise<readonly ToolRegistryEntry[]>((resolve) => resolve(loader()))
        .then((entries) => {
          if (!Array.isArray(entries)) throw new TypeError("not an array");
          settle(state, "loaded", entries);
        })
        .catch(() => {
          // The code only: the loader's error may carry host data.
          console.warn("HOST_TOOL_REGISTRY_LOADER_FAILED");
          settle(state, "failed", NO_ENTRIES);
        });
    },
    subscribe(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    snapshot: () => state.settled,
  };
  lazyEntriesByLoader.set(loader, state);
  return state;
}

function subscribeToNothing(): () => void {
  return () => {};
}

function nothingLoaded(): undefined {
  return undefined;
}

/**
 * Until the loader settles, a call whose raw type or exact name has no entry
 * renders the generic fallback and starts the load: a loaded entry may claim
 * that name, so the call never shows another card first (a built-in leaf
 * card, say) and then changes kind.
 */
function pendingToolRegistry(
  registry: ToolRegistry,
  entries: readonly ToolRegistryEntry[],
  lazy: LazyEntries,
): ToolRegistry {
  const rawTypes = new Set<string>();
  const names = new Set<string>();
  for (const entry of [...entries, ...builtInToolRegistryEntries()]) {
    if (entry.match === "rawType") rawTypes.add(entry.type);
    else names.add(entry.name);
  }
  const isKnown = (item: ToolCallItem): boolean => {
    const rawType = rawTypeOf(item);
    return (rawType !== null && rawTypes.has(rawType)) || names.has(item.name);
  };
  return {
    fallback: registry.fallback,
    resolve(item) {
      if (isKnown(item)) return registry.resolve(item);
      lazy.start();
      return registry.fallback;
    },
  };
}

function hostToolRegistry(entries: readonly ToolRegistryEntry[] | undefined): ToolRegistry {
  return entries && entries.length > 0
    ? createDefaultToolRegistry({ entries: [...entries] })
    : defaultToolRegistry;
}

/**
 * The registry for this app's session timeline. Without host entries it is the
 * shared default registry itself, so the stock timeline renders exactly as
 * before. With a host loader, a new registry replaces it once the loader
 * settles, so open chats redraw their tool calls with the loaded cards.
 */
export function useHostToolRegistry(): ToolRegistry {
  const host = useAppHost();
  const entries = host.toolRegistryEntries;
  const lazy = host.toolRegistryLoader ? lazyEntriesOf(host.toolRegistryLoader) : undefined;
  const loaded = useSyncExternalStore(
    lazy?.subscribe ?? subscribeToNothing,
    lazy?.snapshot ?? nothingLoaded,
    lazy?.snapshot ?? nothingLoaded,
  );
  return useMemo(() => {
    if (!lazy) return hostToolRegistry(entries);
    if (loaded) return hostToolRegistry([...(entries ?? NO_ENTRIES), ...loaded]);
    return pendingToolRegistry(hostToolRegistry(entries), entries ?? NO_ENTRIES, lazy);
  }, [entries, lazy, loaded]);
}
