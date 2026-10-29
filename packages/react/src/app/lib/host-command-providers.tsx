import { useEffect, useMemo, useState } from "react";
import type { HostExtensionCommandMenuProvider, HostExtensionCommandResult, HostExtensionContext } from "../host-extension";
import { useAppHost } from "./app-host";

export type HostCommandGroup = Readonly<{ id: string; heading: string; items: readonly HostExtensionCommandResult[] }>;
const NONE: readonly HostCommandGroup[] = [];
const NO_PROVIDERS: readonly HostExtensionCommandMenuProvider[] = [];
const TIMEOUT_MS = 1500;
const reportedProviderSets = new WeakSet<readonly HostExtensionCommandMenuProvider[]>();

export function hostCommandHref(path: string, workspaceId: string): string | undefined {
  if (!path.trim() || path !== path.trim() || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || /[\\\u0000-\u001f\u007f-\u009f]/.test(path)) return undefined;
  try {
    const base = new URL(`https://host.invalid/workspaces/${encodeURIComponent(workspaceId)}/`);
    // URL normalization clamps excess parent segments at root, losing that refusal signal.
    const pathname = path.split(/[?#]/, 1)[0] ?? "";
    const absolute = pathname.startsWith("/");
    let depth = absolute ? 0 : base.pathname.split("/").length - 2;
    const segments = pathname.replace(/%2e/gi, ".").split("/");
    for (const segment of absolute ? segments.slice(1) : segments) {
      if (segment === ".") continue;
      if (segment === "..") {
        if (depth === 0) return undefined;
        depth -= 1;
      } else {
        depth += 1;
      }
    }
    const resolved = new URL(path, base);
    if (resolved.origin !== "https://host.invalid" || !resolved.pathname.startsWith("/") || resolved.pathname.startsWith("//")) return undefined;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch { return undefined; }
}

function parsedResult(candidate: unknown, workspaceId: string): HostExtensionCommandResult | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;
  const row = candidate as Readonly<Record<string, unknown>>;
  if (Object.keys(row).some((key) => !["id", "label", "path", "keywords"].includes(key))) return undefined;
  if (typeof row.id !== "string" || !row.id.trim() || typeof row.label !== "string" || !row.label.trim() || typeof row.path !== "string") return undefined;
  const path = hostCommandHref(row.path, workspaceId);
  if (!path) return undefined;
  const keywords: string[] = [];
  if (row.keywords !== undefined) {
    if (!Array.isArray(row.keywords)) return undefined;
    for (const keyword of row.keywords) {
      if (typeof keyword !== "string" || !keyword.trim()) return undefined;
      keywords.push(keyword);
    }
  }
  return { id: row.id, label: row.label, path, ...(row.keywords !== undefined ? { keywords } : {}) };
}

function parsedResults(value: unknown, workspaceId: string): Readonly<{ items: readonly HostExtensionCommandResult[]; invalid: boolean }> {
  if (!Array.isArray(value)) return { items: [], invalid: true };
  const ids = new Set<string>();
  const items: HostExtensionCommandResult[] = [];
  let invalid = false;
  for (const candidate of value) {
    const item = parsedResult(candidate, workspaceId);
    if (!item || ids.has(item.id)) { invalid = true; continue; }
    ids.add(item.id);
    items.push(item);
  }
  return { items, invalid };
}

/** One installed provider set: independent deadlines, cancellation, and one content-free warning. */
export function createHostCommandMenuSearch(providers: readonly HostExtensionCommandMenuProvider[]) {
  const warn = () => {
    if (reportedProviderSets.has(providers)) return;
    reportedProviderSets.add(providers);
    console.warn("HOST_COMMAND_PROVIDER_FAILED");
  };
  return async (query: string, context: HostExtensionContext, signal: AbortSignal): Promise<readonly HostCommandGroup[]> => {
    const groups = await Promise.all(providers.map(async (provider): Promise<HostCommandGroup | null> => {
      if (signal.aborted) return null;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort: () => void = () => undefined;
      const abandon = () => controller.abort();
      signal.addEventListener("abort", abandon, { once: true });
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          rejectAbort = () => reject(new Error("HOST_COMMAND_SEARCH_ABORTED"));
          controller.signal.addEventListener("abort", rejectAbort, { once: true });
          timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        });
        const value: unknown = await Promise.race([Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error("HOST_COMMAND_SEARCH_ABORTED");
          return provider.search(query, context, controller.signal);
        }), deadline]);
        if (signal.aborted) return null;
        const parsed = parsedResults(value, context.workspaceId);
        if (parsed.invalid) warn();
        const items = parsed.items;
        return items.length ? { id: provider.id, heading: provider.heading, items } : null;
      } catch {
        if (!signal.aborted) warn();
        return null;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abandon);
        controller.signal.removeEventListener("abort", rejectAbort);
      }
    }));
    return groups.filter((group): group is HostCommandGroup => group !== null);
  };
}

export function useHostCommandMenuResults(context: HostExtensionContext, query: string, open: boolean, subjectId: string): Readonly<{ groups: readonly HostCommandGroup[]; loading: boolean }> {
  const providers = useAppHost().commandMenuProviders ?? NO_PROVIDERS;
  const search = useMemo(() => createHostCommandMenuSearch(providers), [providers]);
  const { workspaceId, pathname } = context;
  const request = useMemo(() => ({ workspaceId, pathname, query, open, subjectId }), [workspaceId, pathname, query, open, subjectId]);
  const [state, setState] = useState<{ request: typeof request; search: typeof search; groups: readonly HostCommandGroup[] } | null>(null);
  useEffect(() => {
    if (!request.open) return;
    const controller = new AbortController();
    void search(request.query, { workspaceId: request.workspaceId, pathname: request.pathname }, controller.signal).then((groups) => {
      if (!controller.signal.aborted) setState({ request, search, groups });
    });
    return () => controller.abort();
  }, [search, request]);
  const current = open && state?.request === request && state.search === search;
  return { groups: current ? state.groups : NONE, loading: open && !current };
}
