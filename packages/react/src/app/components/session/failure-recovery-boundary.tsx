import { Component, type ReactNode } from "react";
import { HOST_BOUNDARY_DIAGNOSTICS } from "../../lib/host-boundary-diagnostics";

/** A failed recovery-options chunk must never take the conversation down. */
export class FailureRecoveryBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onError?: (() => void) | undefined; hostDiagnostics?: boolean | undefined },
  { failed: boolean }
> {
  state = { failed: false };
  get [HOST_BOUNDARY_DIAGNOSTICS](): boolean {
    return this.props.hostDiagnostics === true;
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError?.();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
