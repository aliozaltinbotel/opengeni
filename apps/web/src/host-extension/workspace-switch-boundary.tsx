// The fallback that makes every in-tab workspace change wait on the host
// extension's onWorkspaceSwitch: a raw link into another workspace, back and
// forward, a session deep link or an account switch all pass through the
// workspace route's tenant boundary, where the previous workspace's state
// hands over to the next. The console's own switch functions wait on the hook
// before they navigate; the boundary then sees that switch as done and does
// not call the hook again.
import { useEffect, useRef, useState } from "react";
import { LoadingPanel } from "@opengeni/react/app/components/common";
import { WorkspaceTenantBoundary } from "@opengeni/react/app/components/workspace-tenant-boundary";
import {
  awaitHostWorkspaceSwitch,
  pendingHostWorkspaceSwitch,
  recordHostWorkspaceEntered,
  type HostLifecycle,
} from "@opengeni/react/app/lib/host-lifecycle";
import { currentHostExtension } from "./registry";

/**
 * The tenant boundary, held on "Switching workspace" while the host's
 * onWorkspaceSwitch (bounded) runs for a switch no switch function waited on.
 */
export function HostWorkspaceSwitchBoundary({
  workspaceId,
  stateOwnerWorkspaceId,
  prepareTransition,
  lifecycle = currentHostExtension().lifecycle,
}: {
  workspaceId: string;
  stateOwnerWorkspaceId: string | null;
  prepareTransition: (workspaceId: string) => void;
  lifecycle?: HostLifecycle | undefined;
}) {
  const pending = pendingHostWorkspaceSwitch(lifecycle, workspaceId);
  const [released, setReleased] = useState<string | null>(null);
  const started = useRef<string | null>(null);
  const waiting = pending !== null && released !== pending.key;

  useEffect(() => {
    if (!waiting || pending === null || started.current === pending.key) return;
    const { from, to, key } = pending;
    started.current = key;
    void awaitHostWorkspaceSwitch(lifecycle, from, to).then(() => setReleased(key));
  });

  if (waiting) return <LoadingPanel label="Switching workspace" />;
  return (
    <WorkspaceTenantBoundary
      workspaceId={workspaceId}
      stateOwnerWorkspaceId={stateOwnerWorkspaceId}
      prepareTransition={prepareTransition}
    >
      {null}
    </WorkspaceTenantBoundary>
  );
}

/** Records the workspace the shell shows once its state is ready, for the fallback above. */
export function useHostWorkspaceEntered(
  workspaceId: string,
  ready: boolean,
  lifecycle: HostLifecycle | undefined = currentHostExtension().lifecycle,
): void {
  useEffect(() => {
    if (ready) recordHostWorkspaceEntered(lifecycle, workspaceId);
  }, [lifecycle, ready, workspaceId]);
}
