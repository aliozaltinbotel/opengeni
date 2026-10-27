import { Button } from "../../../ui/button";
import { useNativeDestinationVisible } from "../../lib/app-host";

/**
 * Keep token entry, ownership and vault selection in the protected Secrets
 * flow. When the host extension hides Secrets there is no flow to open here,
 * so it only says whether 1Password is connected.
 */
export function OnePasswordCatalogLink({
  workspaceId,
  connected,
  preserveChat = false,
}: {
  workspaceId: string;
  connected: boolean;
  preserveChat?: boolean | undefined;
}) {
  const secretsVisible = useNativeDestinationVisible("secrets");
  if (!secretsVisible) {
    return (
      <p className="text-sm text-fg-muted">
        {connected
          ? "1Password is connected to this workspace."
          : "1Password isn't connected to this workspace."}
      </p>
    );
  }
  const href = `/workspaces/${encodeURIComponent(workspaceId)}/secrets${
    connected ? "" : "?view=connect-1password"
  }`;
  return (
    <Button asChild className="rounded-[10px] pointer-coarse:h-11">
      <a
        href={href}
        target={preserveChat ? "_blank" : undefined}
        rel={preserveChat ? "noopener noreferrer" : undefined}
      >
        {connected ? "Manage 1Password" : "Connect 1Password"}
      </a>
    </Button>
  );
}
