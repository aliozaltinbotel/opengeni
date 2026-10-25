import { createContext, useContext, type ReactNode } from "react";

/** The external authentication host owns recovery, not native account provisioning. */
type ExternalAuthRecovery = (retry: () => void) => ReactNode;
const ExternalAuthRecoveryContext = createContext<ExternalAuthRecovery | null>(null);
export const ExternalAuthRecoveryProvider = ExternalAuthRecoveryContext.Provider;
export function useExternalAuthRecovery(): ExternalAuthRecovery | null {
  return useContext(ExternalAuthRecoveryContext);
}
