// Where the console opens a workspace: the root redirect and
// `workspaces/$workspaceId/` both land on the host extension's `landing`
// (one of its own pages, checked at registration), else on sessions.
import { Navigate } from "@tanstack/react-router";
import { workspaceLanding } from "@opengeni/react/app/host-extension";

import { currentHostExtension } from "./registry";

/** Redirects to `landing`, a workspace-relative path ("sessions" or an extension page). */
export function LandingRedirect({
  workspaceId,
  landing,
}: {
  workspaceId: string;
  landing: string;
}) {
  if (landing === "sessions")
    return <Navigate to="/workspaces/$workspaceId/sessions" params={{ workspaceId }} replace />;
  // Extension pages are outside the typed route tree (routes.tsx), like their nav links.
  return (
    <Navigate
      to={`/workspaces/$workspaceId/${landing}` as never}
      params={{ workspaceId } as never}
      replace
    />
  );
}

/** Redirects to this build's workspace landing (read at render, after startup). */
export function WorkspaceLandingRedirect({ workspaceId }: { workspaceId: string }) {
  return (
    <LandingRedirect workspaceId={workspaceId} landing={workspaceLanding(currentHostExtension())} />
  );
}
