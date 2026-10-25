import { createContext, useContext, type ReactNode } from "react";

/** The external authentication host owns recovery, not native account provisioning. */
const ExternalAuthRecoveryContext = createContext<ReactNode>(null);
export const ExternalAuthRecoveryProvider = ExternalAuthRecoveryContext.Provider;
export function useExternalAuthRecovery(): ReactNode {
  return useContext(ExternalAuthRecoveryContext);
}
