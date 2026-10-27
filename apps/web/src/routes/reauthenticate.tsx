// Confirm it's you: a signed-in person proves who they are again before a
// sensitive change, then returns to the page that asked. `?return=` names that
// page; only a same-origin path is followed, anything else returns to `/`.
// Registered behind the managed sign-in gate, like Personal security: it needs
// the selected managed person, never a workspace grant.
import { useBrowserAccounts } from "@opengeni/react/accounts";
import { ProblemPanel } from "@opengeni/react/app/components/common";
import { Button } from "@opengeni/react/ui/button";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { Notice } from "@opengeni/react/ui/notice";
import { SettingRowSkeleton } from "@opengeni/react/ui/setting-row";
import { Loader2Icon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useBrowserAccountPopup } from "@/components/use-browser-account-popup";
import { usePersonalSecurityContext } from "@/lib/personal-security-context";
import {
  createStepUpApi,
  stepUpErrorCode,
  type ReauthenticationStatus,
  type StepUpApi,
} from "@/lib/step-up-api";

/**
 * The page to return to: a path on this origin, or `/`. Absolute URLs,
 * protocol-relative `//host` paths and backslash tricks never leave the site.
 */
export function safeReauthenticationReturnPath(
  raw: unknown,
  currentOrigin: string = window.location.origin,
): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || /^\/[/\\]/u.test(raw)) return "/";
  if (raw.includes("\\") || [...raw].some((character) => character.charCodeAt(0) < 0x20)) {
    return "/";
  }
  try {
    const url = new URL(raw, currentOrigin);
    return url.origin === currentOrigin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

export function reauthenticationPath(returnPath: string): string {
  return `/reauthenticate?${new URLSearchParams({ return: returnPath }).toString()}`;
}

export function ReauthenticateRoute({ returnTo }: { returnTo?: string | undefined }) {
  const context = usePersonalSecurityContext();
  if (!context || context.clientConfig.auth.mode !== "managedSession") {
    return (
      <ProblemPanel
        title="Confirming it's you is unavailable"
        description="Opengeni confirms who you are only on deployments with managed browser sign-in."
      />
    );
  }
  const mode = context.clientConfig.managedAuthSessionSetMode ?? "legacy";
  return mode === "legacy" ? (
    <LegacyReauthenticate key={context.authSession.user.id} returnTo={returnTo} />
  ) : (
    <BrokerReauthenticate key={context.authSession.user.id} returnTo={returnTo} />
  );
}

function LegacyReauthenticate({ returnTo }: { returnTo?: string | undefined }) {
  const context = usePersonalSecurityContext()!;
  const [signInError, setSignInError] = useState<string | null>(null);
  return (
    <ReauthenticateController
      mode="legacy"
      email={context.authSession.user.email}
      returnTo={returnTo}
      signInError={signInError}
      onSignInAgain={() => {
        const again = reauthenticationPath(safeReauthenticationReturnPath(returnTo));
        void context
          .handleManagedSignOut()
          .then(() => window.location.assign(again))
          .catch(() => setSignInError("Couldn't finish signing out. Try again."));
      }}
    />
  );
}

function BrokerReauthenticate({ returnTo }: { returnTo?: string | undefined }) {
  const context = usePersonalSecurityContext()!;
  const accounts = useBrowserAccounts();
  const popup = useBrowserAccountPopup();
  const [signInError, setSignInError] = useState<string | null>(null);
  return (
    <ReauthenticateController
      mode={context.clientConfig.managedAuthSessionSetMode ?? "dual"}
      email={context.authSession.user.email}
      returnTo={returnTo}
      signInError={signInError}
      onSignInAgain={() => {
        const slotId = accounts.projection?.selectedSlotId;
        if (!slotId) {
          setSignInError("Select the account you want to confirm, then try again.");
          return;
        }
        setSignInError(null);
        popup.open(() => accounts.beginReauth(slotId), {
          onError: () =>
            setSignInError("Couldn't open sign-in. Allow popups for Opengeni and try again."),
          onSettled: () => context.revalidatePrincipalAccess(),
        });
      }}
    />
  );
}

function failureMessage(error: unknown, status: ReauthenticationStatus): string {
  switch (stepUpErrorCode(error)) {
    case "REAUTH_FAILED":
      return status.password
        ? "That password or code didn't match. Check them and try again."
        : "We couldn't confirm it's you. Sign in again, then continue within five minutes.";
    case "REAUTH_TOTP_REQUIRED":
      return "Enter the code from your authenticator app.";
    case "REAUTH_RATE_LIMITED":
      return "Too many attempts. Wait a minute and try again.";
    case "REAUTH_SESSION_REQUIRED":
      return "Your session ended. Sign in again to continue.";
    default:
      return "We couldn't confirm it's you. Try again.";
  }
}

function assignLocation(path: string): void {
  window.location.assign(path);
}

export function ReauthenticateController({
  mode,
  email,
  returnTo,
  signInError,
  onSignInAgain,
  api: suppliedApi,
  onReturn = assignLocation,
}: {
  mode: "legacy" | "dual" | "broker";
  email: string;
  returnTo?: string | undefined;
  signInError?: string | null | undefined;
  onSignInAgain: () => void;
  api?: StepUpApi | undefined;
  onReturn?: ((path: string) => void) | undefined;
}) {
  const api = useMemo(() => suppliedApi ?? createStepUpApi(mode), [mode, suppliedApi]);
  const returnPath = safeReauthenticationReturnPath(returnTo);
  const [status, setStatus] = useState<ReauthenticationStatus | null>(null);
  const [loadFailure, setLoadFailure] = useState<"unavailable" | "failed" | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .reauthenticationStatus()
      .then((loaded) => {
        if (active) setStatus(loaded);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setLoadFailure(stepUpErrorCode(caught) === "REAUTH_DISABLED" ? "unavailable" : "failed");
      });
    return () => {
      active = false;
    };
  }, [api]);

  async function submit() {
    if (!status || busy) return;
    setError(null);
    if (status.password && !password) {
      setError("Enter your password.");
      return;
    }
    if (status.totpRequired && !/^\d{6}$/u.test(code)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    try {
      await api.reauthenticate({
        ...(status.password ? { password } : {}),
        ...(status.totpRequired ? { totp: code } : {}),
      });
      setPassword("");
      setCode("");
      setConfirmed(true);
      onReturn(returnPath);
    } catch (caught) {
      setPassword("");
      setCode("");
      setError(failureMessage(caught, status));
    } finally {
      setBusy(false);
    }
  }

  if (loadFailure === "unavailable") {
    return (
      <ProblemPanel
        title="Confirming it's you is unavailable"
        description="This deployment doesn't ask you to confirm who you are again. Go back and continue."
      />
    );
  }

  return (
    <section className="og-page-glow flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <ShieldCheckIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold">Confirm it's you</h1>
            <p className="text-sm break-words text-fg-subtle">
              Signed in as {email}. Confirm to continue.
            </p>
          </div>
        </div>
        {confirmed ? (
          <div role="status">
            <Notice tone="success">Confirmed. Taking you back.</Notice>
          </div>
        ) : loadFailure === "failed" ? (
          <div role="alert">
            <Notice tone="failed">
              Couldn't load this page. Refresh it, or sign in again if your session ended.
            </Notice>
          </div>
        ) : !status ? (
          <div role="status" aria-label="Loading">
            <SettingRowSkeleton />
          </div>
        ) : (
          <form
            aria-label="Confirm it's you"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FieldStack className="gap-5">
              {status.password ? (
                <Field label="Password" id="reauthenticate-password" required>
                  <TextInput
                    type="password"
                    autoComplete="current-password"
                    required
                    autoFocus
                    disabled={busy}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              ) : (
                <p className="text-sm text-fg-muted">
                  Your account signs in with Google or GitHub. Sign in again, then continue within
                  five minutes.
                </p>
              )}
              {status.totpRequired ? (
                <Field
                  label="Authenticator app code"
                  id="reauthenticate-code"
                  required
                  hint="The 6-digit code your authenticator app shows for Opengeni."
                >
                  <TextInput
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    disabled={busy}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/gu, ""))}
                  />
                </Field>
              ) : null}
            </FieldStack>
            {error || signInError ? (
              <div role="alert" className="mt-4">
                <Notice tone="failed">{error ?? signInError}</Notice>
              </div>
            ) : null}
            <Button type="submit" className="mt-4 w-full" disabled={busy}>
              {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
              Continue
            </Button>
            {status.password ? null : (
              <Button
                type="button"
                variant="outline"
                className="mt-2 w-full"
                disabled={busy}
                onClick={onSignInAgain}
              >
                Sign in again
              </Button>
            )}
          </form>
        )}
      </div>
    </section>
  );
}
