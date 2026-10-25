// Browser fixture only: real native App/bridge with emulated Clerk memberships.
import { useSyncExternalStore, type ReactNode } from "react";
const scenario = new URLSearchParams(window.location.search).get("membershipState");
let principal = {
  isLoaded: true,
  isSignedIn: true,
  sessionId: "fixture-session",
  userId: "fixture-person",
  orgId: "refused",
};
const listeners = new Set<() => void>();
function update(next: typeof principal) {
  principal = next;
  for (const listener of listeners) listener();
}
const getToken = async () => `fixture-token:${principal.orgId}`;
const signOut = async () => update({ ...principal, isSignedIn: false });
export function ClerkProvider({ children }: { children: ReactNode }) {
  return children;
}
export function SignIn() {
  return (
    <main>
      <h1>Sign in</h1>
      <p>Local Clerk sign-in fixture</p>
    </main>
  );
}
export function useAuth() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => principal,
  );
  return { ...current, getToken, signOut };
}
export function useOrganizationList() {
  useAuth();
  return {
    isLoaded: scenario !== "loading",
    setActive: async ({ organization }: { organization: string }) => {
      if (!["allowed", "refused"].includes(organization))
        throw new Error("fixture membership refused");
      update({ ...principal, orgId: organization });
    },
    userMemberships: {
      data:
        scenario === "empty"
          ? []
          : [
              { organization: { id: "refused", name: "Current organization" } },
              { organization: { id: "allowed", name: "Existing organization with access" } },
            ],
      isLoading: scenario === "loading",
      isFetching: false,
      error: scenario === "error" ? new Error("private fixture discovery failure") : null,
      hasNextPage: false,
      fetchNext: () => {},
      revalidate: async () => {},
    },
  };
}
