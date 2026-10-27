// The host extension's shell providers (its data, copy or scope contexts),
// around both the rail shell and the settings shell, so its pages and nav read
// them in either mode. Without providers (the stub) the children render bare.
import type { ReactNode } from "react";
import { currentHostExtension } from "./registry";

/** Nests the extension's `shellProviders` in order, the first outermost. */
export function HostExtensionProviders({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  return (currentHostExtension().shellProviders ?? []).reduceRight<ReactNode>(
    (inner, Provider) => <Provider workspaceId={workspaceId}>{inner}</Provider>,
    children,
  );
}
