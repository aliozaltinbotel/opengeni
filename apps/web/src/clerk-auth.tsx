import { ClerkProvider, SignIn, useAuth, useOrganizationList } from "@clerk/react";
import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { registerExternalAccessTokenSource, registerExternalSignOut } from "./api";
import { LoadingPanel, ProblemPanel } from "@opengeni/react/app/components/common";
import { Button } from "@opengeni/react/ui/button";
import { Select } from "@opengeni/react/ui/select";
import { t } from "@opengeni/react/app/lib/console-text";
import { useNavigate } from "@tanstack/react-router";
import { ExternalAuthRecoveryProvider } from "./lib/external-auth-recovery";
import { afterHostSignOut } from "@/host-extension/lifecycle";

function renderClerkAccountRecovery(retry: () => void): ReactNode {
  return <ClerkAccountRecovery retry={retry} />;
}

/** Only existing Clerk memberships are offered; this never creates access. */
function ClerkAccountRecovery({ retry }: { retry: () => void }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  const selectId = useId();
  const loading = !isLoaded || userMemberships.isLoading;
  const memberships = userMemberships.data ?? [];
  const listFailed = Boolean(userMemberships.error);
  async function chooseOrganization() {
    if (!setActive || busy || !memberships.some(({ organization }) => organization.id === selected))
      return;
    setBusy(true);
    setActionError(false);
    try {
      await navigate({ to: "/", search: {}, hash: "", replace: true });
      await setActive({ organization: selected });
      retry();
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  }
  async function showMoreOrganizations() {
    setActionError(false);
    try {
      await userMemberships.fetchNext?.();
    } catch {
      setActionError(true);
    }
  }
  async function useAnotherAccount() {
    if (busy) return;
    setBusy(true);
    setActionError(false);
    try {
      await navigate({ to: "/", search: {}, hash: "", replace: true });
      await afterHostSignOut(() => signOut());
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ProblemPanel
      title={t("clerkRecovery.title")}
      description={t("clerkRecovery.description")}
      action={
        <div className="flex w-full min-w-0 flex-col gap-3 text-left">
          {loading ? (
            <p role="status" className="text-sm text-fg-muted">
              {t("clerkRecovery.loading")}
            </p>
          ) : listFailed ? (
            <div role="alert">
              <p className="text-sm text-fg-muted">{t("clerkRecovery.listError")}</p>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void userMemberships.revalidate?.().catch(() => setActionError(true));
                }}
              >
                {t("clerkRecovery.retry")}
              </Button>
            </div>
          ) : memberships.length === 0 ? (
            <p className="text-sm text-fg-muted">{t("clerkRecovery.empty")}</p>
          ) : (
            <>
              <label htmlFor={selectId} className="text-sm font-medium">
                {t("clerkRecovery.organization")}
              </label>
              <Select
                id={selectId}
                value={selected}
                disabled={busy}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="" disabled>
                  {t("clerkRecovery.choose")}
                </option>
                {memberships.map(({ organization }) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </Select>
              {userMemberships.hasNextPage ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || userMemberships.isFetching}
                  onClick={() => {
                    void showMoreOrganizations();
                  }}
                >
                  {t("clerkRecovery.more")}
                </Button>
              ) : null}
              <Button
                type="button"
                disabled={
                  busy || !memberships.some(({ organization }) => organization.id === selected)
                }
                onClick={() => {
                  void chooseOrganization();
                }}
              >
                {t("clerkRecovery.continue")}
              </Button>
            </>
          )}
          {actionError ? (
            <p role="alert" className="text-sm text-status-failed">
              {t("clerkRecovery.actionError")}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              void useAnotherAccount();
            }}
          >
            {t("clerkRecovery.anotherAccount")}
          </Button>
        </div>
      }
    />
  );
}

/** The existing console mounts only after its authenticated request source is ready. */
function ClerkSessionBridge({
  children,
  onPrincipalChange,
}: {
  children: ReactNode;
  onPrincipalChange: () => Promise<void>;
}) {
  const { isLoaded, isSignedIn, getToken, sessionId, userId, orgId, signOut } = useAuth();
  const principal =
    isLoaded && isSignedIn ? JSON.stringify([sessionId, userId, orgId ?? null]) : null;
  const tokenReader = useRef(getToken);
  const signOutSession = useRef(signOut);
  useLayoutEffect(() => {
    tokenReader.current = getToken;
    signOutSession.current = signOut;
  }, [getToken, signOut]);
  const [readySession, setReadySession] = useState<string | null>(null);
  const acceptedPrincipal = useRef<string | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const [resetFailed, setResetFailed] = useState(false);
  useLayoutEffect(() => {
    const unregister = registerExternalAccessTokenSource(() =>
      isLoaded && isSignedIn ? tokenReader.current() : Promise.resolve(null),
    );
    const unregisterSignOut = registerExternalSignOut(async () => {
      await signOutSession.current();
    });
    let active = true;
    setResetFailed(false);
    const accept = () => {
      if (!active) return;
      acceptedPrincipal.current = principal;
      setReadySession(principal);
    };
    if (isLoaded) {
      if (acceptedPrincipal.current !== null && acceptedPrincipal.current !== principal) {
        void onPrincipalChange().then(accept, () => {
          if (active) setResetFailed(true);
        });
      } else accept();
    }
    return () => {
      active = false;
      unregister();
      unregisterSignOut();
    };
  }, [isLoaded, isSignedIn, principal, onPrincipalChange, resetVersion]);
  if (!isLoaded) return <LoadingPanel />;
  if (resetFailed)
    return (
      <ProblemPanel
        title={t("clerkRecovery.resetTitle")}
        description={t("clerkRecovery.actionError")}
        action={
          <Button type="button" onClick={() => setResetVersion((version) => version + 1)}>
            {t("clerkRecovery.retry")}
          </Button>
        }
      />
    );
  if (readySession !== principal) return <LoadingPanel />;
  if (!isSignedIn)
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas p-4">
        <SignIn routing="hash" />
      </main>
    );
  return (
    <ExternalAuthRecoveryProvider value={renderClerkAccountRecovery}>
      <Fragment key={principal}>{children}</Fragment>
    </ExternalAuthRecoveryProvider>
  );
}

export function ClerkConsoleAuth({
  publishableKey,
  children,
  onPrincipalChange,
}: {
  publishableKey: string;
  children: ReactNode;
  onPrincipalChange: () => Promise<void>;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkSessionBridge onPrincipalChange={onPrincipalChange}>{children}</ClerkSessionBridge>
    </ClerkProvider>
  );
}
