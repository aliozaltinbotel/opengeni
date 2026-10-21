import { ClerkProvider, SignIn, useAuth } from "@clerk/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { registerExternalAccessTokenSource, registerExternalSignOut } from "./api";
import { LoadingPanel } from "@opengeni/react/app/components/common";

/** The existing console mounts only after its authenticated request source is ready. */
function ClerkSessionBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken, sessionId, signOut } = useAuth();
  const tokenReader = useRef(getToken);
  const signOutSession = useRef(signOut);
  useLayoutEffect(() => {
    tokenReader.current = getToken;
    signOutSession.current = signOut;
  }, [getToken, signOut]);
  const [readySession, setReadySession] = useState<string | null>(null);
  useLayoutEffect(() => {
    const unregister = registerExternalAccessTokenSource(() =>
      isLoaded && isSignedIn ? tokenReader.current() : Promise.resolve(null),
    );
    const unregisterSignOut = registerExternalSignOut(async () => {
      await signOutSession.current();
    });
    setReadySession(isLoaded && isSignedIn ? sessionId : null);
    return () => {
      unregister();
      unregisterSignOut();
    };
  }, [isLoaded, isSignedIn, sessionId]);
  if (!isLoaded) return <LoadingPanel />;
  if (!isSignedIn)
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas p-4">
        <SignIn routing="hash" />
      </main>
    );
  if (readySession !== sessionId) return <LoadingPanel />;
  return children;
}

export function ClerkConsoleAuth({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkSessionBridge>{children}</ClerkSessionBridge>
    </ClerkProvider>
  );
}
