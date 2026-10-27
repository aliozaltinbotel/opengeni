// The session timeline's tool registry: the host's tool cards ahead of the
// built-in renderers. Session-only on purpose: the timeline renderers stay out
// of the page's eager graph, which imports app-host.
import { useMemo } from "react";

import { createDefaultToolRegistry, defaultToolRegistry, type ToolRegistry } from "../../timeline";
import { useAppHost } from "./app-host";

/**
 * The registry for this app's session timeline. Without host entries it is the
 * shared default registry itself, so the stock timeline renders exactly as
 * before.
 */
export function useHostToolRegistry(): ToolRegistry {
  const entries = useAppHost().toolRegistryEntries;
  return useMemo(
    () =>
      entries && entries.length > 0
        ? createDefaultToolRegistry({ entries: [...entries] })
        : defaultToolRegistry,
    [entries],
  );
}
