// The console waits on a host extension's lifecycle hooks before signing out
// and before switching workspace (HostExtension["lifecycle"]). A hook is
// bounded: one that rejects, throws or is still running after the timeout is
// logged as HOST_LIFECYCLE_HOOK_FAILED and the action goes on, so a host can
// never keep a person signed in or in a workspace. Without a hook the action
// runs at once, as in the stock console.
import type { HostExtension } from "../host-extension";

export type HostLifecycle = NonNullable<HostExtension["lifecycle"]>;
export type HostLifecycleHookName = keyof HostLifecycle;

/** How long the console waits for a lifecycle hook before going on without it. */
export const HOST_LIFECYCLE_HOOK_TIMEOUT_MS = 5_000;
export const HOST_LIFECYCLE_HOOK_FAILED = "HOST_LIFECYCLE_HOOK_FAILED";

/** Waits for `run`, at most `timeoutMs`. Never rejects; a failure or timeout is logged. */
export async function awaitHostLifecycleHook(
  hook: HostLifecycleHookName,
  run: () => Promise<void>,
  timeoutMs: number = HOST_LIFECYCLE_HOOK_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(run)
        .then(() => "done" as const),
      timedOut,
    ]);
    if (outcome === "timeout") {
      console.error(HOST_LIFECYCLE_HOOK_FAILED, { hook, reason: "timeout", timeoutMs });
    }
  } catch (error) {
    console.error(HOST_LIFECYCLE_HOOK_FAILED, { hook, reason: "rejected", error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the console last told a host about workspaces: the workspace whose
 * shell it last entered, and the switch a switch function already waited on.
 * The workspace route's fallback (`pendingHostWorkspaceSwitch`) uses it to
 * hook every other in-tab workspace change (a raw link, back and forward, a
 * deep link, an account switch) exactly once. Keyed by the host's lifecycle
 * object, so two hosts on one page never share it.
 */
type WorkspaceSwitchLedger = { entered: string | null; notified: string | null };
const SWITCH_LEDGERS = new WeakMap<HostLifecycle, WorkspaceSwitchLedger>();

function switchLedger(lifecycle: HostLifecycle): WorkspaceSwitchLedger {
  const existing = SWITCH_LEDGERS.get(lifecycle);
  if (existing) return existing;
  const created: WorkspaceSwitchLedger = { entered: null, notified: null };
  SWITCH_LEDGERS.set(lifecycle, created);
  return created;
}

function switchKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

/** Records that the console's shell is now showing `workspaceId`. */
export function recordHostWorkspaceEntered(
  lifecycle: HostLifecycle | undefined,
  workspaceId: string,
): void {
  if (!lifecycle?.onWorkspaceSwitch) return;
  const ledger = switchLedger(lifecycle);
  ledger.entered = workspaceId;
  ledger.notified = null;
}

/**
 * The switch the workspace route must still wait on before it shows `to`:
 * from the workspace last entered, unless a switch function already waited
 * on that same switch. Null without a hook, on first entry, or when nothing
 * is left to wait on. Reads only, so it is safe during render.
 */
export function pendingHostWorkspaceSwitch(
  lifecycle: HostLifecycle | undefined,
  to: string,
): Readonly<{ from: string; to: string; key: string }> | null {
  if (!lifecycle?.onWorkspaceSwitch) return null;
  const ledger = SWITCH_LEDGERS.get(lifecycle);
  const from = ledger?.entered ?? null;
  if (from === null || from === to) return null;
  const key = switchKey(from, to);
  return ledger?.notified === key ? null : { from, to, key };
}

/** Waits (bounded) for the host's `onWorkspaceSwitch(from, to)`. Never rejects. */
export function awaitHostWorkspaceSwitch(
  lifecycle: HostLifecycle | undefined,
  from: string,
  to: string,
): Promise<void> {
  const onWorkspaceSwitch = lifecycle?.onWorkspaceSwitch;
  if (!onWorkspaceSwitch) return Promise.resolve();
  return awaitHostLifecycleHook("onWorkspaceSwitch", () => onWorkspaceSwitch(from, to));
}

/** Runs `signOut` after the host's `onSignOut`; straight away when the host has none. */
export function signOutAfterHostHook<Result>(
  lifecycle: HostLifecycle | undefined,
  signOut: () => Promise<Result>,
): Promise<Result> {
  // The next person to sign in in this tab does not switch from this one's workspace.
  if (lifecycle?.onWorkspaceSwitch) switchLedger(lifecycle).entered = null;
  const onSignOut = lifecycle?.onSignOut;
  if (!onSignOut) return signOut();
  return awaitHostLifecycleHook("onSignOut", onSignOut).then(signOut);
}

/**
 * Calls `proceed` (the navigation into `to`) after the host's
 * `onWorkspaceSwitch(from, to)`; synchronously when the host has none or the
 * workspace does not change.
 */
export function switchWorkspaceAfterHostHook(
  lifecycle: HostLifecycle | undefined,
  from: string,
  to: string,
  proceed: () => void,
): void {
  const onWorkspaceSwitch = lifecycle?.onWorkspaceSwitch;
  if (!lifecycle || !onWorkspaceSwitch || from === to) {
    proceed();
    return;
  }
  void awaitHostLifecycleHook("onWorkspaceSwitch", () => onWorkspaceSwitch(from, to)).then(() => {
    // The workspace route must not wait on this switch a second time.
    switchLedger(lifecycle).notified = switchKey(from, to);
    proceed();
  });
}
