// This build's host extension hooks for the web app's own sign-out and
// workspace-switch paths. The session UI in @opengeni/react reads the same
// hooks from the page's AppHost (app-host.ts).
import {
  signOutAfterHostHook,
  switchWorkspaceAfterHostHook,
} from "@opengeni/react/app/lib/host-lifecycle";
import { currentHostExtension } from "./registry";

/** Runs a native sign-out after the host extension's `onSignOut` (bounded); at once for the stub. */
export function afterHostSignOut<Result>(signOut: () => Promise<Result>): Promise<Result> {
  return signOutAfterHostHook(currentHostExtension().lifecycle, signOut);
}

/** Navigates into `to` after the host extension's `onWorkspaceSwitch(from, to)` (bounded). */
export function afterHostWorkspaceSwitch(from: string, to: string, proceed: () => void): void {
  switchWorkspaceAfterHostHook(currentHostExtension().lifecycle, from, to, proceed);
}
