// A client with no workspace, for pages outside every workspace. It stays a leaf module (only the context and
// React), so the console can mount it in its startup route without pulling the provider's stream and timeline code.
import type { ReactNode } from "react";
import type { SessionClientLike } from "../client";
import { OpenGeniClientContext } from "../session-context";

export type OpenGeniClientProviderProps = {
  client: SessionClientLike;
  children?: ReactNode;
};

/**
 * Supplies only a client, with no workspace, for pages outside every workspace:
 * client-scoped hooks (`useWorkspaces`, `useBillingUsage`) work below it, while
 * workspace-scoped hooks still refuse. It opens no workspace stream. The server
 * authorizes every call on the client's own credentials, as anywhere else.
 */
export function OpenGeniClientProvider({ client, children }: OpenGeniClientProviderProps) {
  return <OpenGeniClientContext.Provider value={client}>{children}</OpenGeniClientContext.Provider>;
}
