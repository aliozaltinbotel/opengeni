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

/** Runs `signOut` after the host's `onSignOut`; straight away when the host has none. */
export function signOutAfterHostHook<Result>(
  lifecycle: HostLifecycle | undefined,
  signOut: () => Promise<Result>,
): Promise<Result> {
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
  if (!onWorkspaceSwitch || from === to) {
    proceed();
    return;
  }
  void awaitHostLifecycleHook("onWorkspaceSwitch", () => onWorkspaceSwitch(from, to)).then(proceed);
}
