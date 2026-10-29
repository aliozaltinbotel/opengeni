import { Suspense, type ReactNode } from "react";
import type { HostExtension } from "../host-extension";
import { useAppHost } from "../lib/app-host";
import { FailureRecoveryBoundary } from "./session/failure-recovery-boundary";

/** One installed host component's failure cannot hide or disable the native view. */
export function guardHostSessionIndicator(Indicator: NonNullable<HostExtension["sessionIndicator"]>): NonNullable<HostExtension["sessionIndicator"]> {
  let reported = false;
  const warn = () => {
    if (reported) return;
    reported = true;
    console.warn("HOST_SESSION_INDICATOR_FAILED");
  };
  return function GuardedIndicator(props) {
    return <FailureRecoveryBoundary key={`${props.workspaceId}:${props.sessionId ?? ""}`} fallback={null} onError={warn} hostDiagnostics><Suspense fallback={null}><Indicator {...props} /></Suspense></FailureRecoveryBoundary>;
  };
}

/** Outside composer pills, with no native dismiss action; stock renders its children unchanged. */
export function HostSessionIndicatorFrame({ workspaceId, sessionId, children }: {
  workspaceId: string;
  sessionId: string | null;
  children: ReactNode;
}) {
  const Indicator = useAppHost().sessionIndicator;
  if (!Indicator) return children;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"><div className="shrink-0" data-host-session-indicator><Indicator workspaceId={workspaceId} sessionId={sessionId} /></div>{children}</div>;
}
