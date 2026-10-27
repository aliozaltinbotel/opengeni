import { useBrowserAccounts } from "@opengeni/react/accounts";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiBaseUrl } from "@/api";
import {
  SIGN_IN_METHOD_ORIGIN_MESSAGE,
  signInMethodsHaveSameOrigin,
} from "@/lib/sign-in-method-origin";
import { ProblemPanel } from "@opengeni/react/app/components/common";
import { PersonalSettingsShell } from "@/components/settings/personal-settings-shell";
import {
  SecurityPageBody,
  SecurityPageHeader,
  SignInMethodsPlaceholder,
  SignInMethodsView,
  providerLabel,
} from "@/components/sign-in-methods";
import { Button } from "@opengeni/react/ui/button";
import { CopyField } from "@opengeni/react/ui/copy-field";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow } from "@opengeni/react/ui/setting-row";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { Notice } from "@opengeni/react/ui/notice";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { SettingRowSkeleton } from "@opengeni/react/ui/setting-row";
import { useBrowserAccountPopup } from "@/components/use-browser-account-popup";
import { usePersonalSecurityContext } from "@/lib/personal-security-context";
import {
  clearSignInChangeFeedback,
  readSignInChangeFeedback,
  retainSignInChangeFeedback,
  signInCallbackError,
  securityReauthenticationPath,
} from "@/lib/sign-in-feedback";
import {
  createSignInMethodsApi,
  type PreparedSignInCommand,
  type SignInChangeResult,
  type SignInCommand,
  type SignInMethods,
} from "@/lib/sign-in-methods-api";
import { signInMethodFailure } from "@/lib/sign-in-method-failure";
import {
  createStepUpApi,
  stepUpErrorCode,
  totpSetupKey,
  type StepUpApi,
  type TotpStatus,
} from "@/lib/step-up-api";

export function PersonalSecurityRoute() {
  const context = usePersonalSecurityContext();
  if (!context || context.clientConfig.auth.mode !== "managedSession") {
    return (
      <ProblemPanel
        title="Sign-in methods unavailable"
        description="Personal sign-in methods are managed by Opengeni only on deployments with managed browser sign-in."
      />
    );
  }
  if (!signInMethodsHaveSameOrigin(apiBaseUrl, window.location.href)) {
    return (
      <PersonalSettingsShell email={context.authSession.user.email}>
        <SecurityPageHeader />
        <SecurityPageBody>
          <Notice tone="failed">
            <p>Account security configuration required</p>
            <p>{SIGN_IN_METHOD_ORIGIN_MESSAGE}</p>
          </Notice>
        </SecurityPageBody>
      </PersonalSettingsShell>
    );
  }
  const mode = context.clientConfig.managedAuthSessionSetMode ?? "dual";
  return mode === "legacy" ? (
    <LegacySecurity key={`${context.authSession.user.id}:${context.accessKeyVersion}`} />
  ) : (
    <BrokerSecurity key={`${context.authSession.user.id}:${context.accessKeyVersion}`} />
  );
}

/** The authenticator app client, only when the deployment offers TOTP. */
function useAuthenticatorAppApi(mode: "legacy" | "dual" | "broker"): StepUpApi | undefined {
  const context = usePersonalSecurityContext()!;
  const enabled = context.clientConfig.managedAuthTotp?.enabled === true;
  const userId = context.authSession.user.id;
  return useMemo(
    () => (enabled ? createStepUpApi(mode) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new actor needs a client bound to its epoch
    [enabled, mode, userId],
  );
}

function LegacySecurity() {
  const context = usePersonalSecurityContext()!;
  const [reauthError, setReauthError] = useState<string | null>(null);
  const authenticatorApp = useAuthenticatorAppApi("legacy");
  return (
    <SecurityController
      mode="legacy"
      authenticatorApp={authenticatorApp}
      userId={context.authSession!.user.id}
      email={context.authSession!.user.email}
      reauthError={reauthError}
      onReauthenticate={() => {
        const returnPath = securityReauthenticationPath(window.location.search);
        // Sign out through the root's established principal transition before
        // presenting login. Never replace a managed cookie behind its back.
        void context
          .handleManagedSignOut()
          .then(() => window.location.assign(returnPath))
          .catch(() =>
            setReauthError(
              "Couldn't finish signing out. Try again before continuing with reauthentication.",
            ),
          );
      }}
    />
  );
}
function BrokerSecurity() {
  const context = usePersonalSecurityContext()!;
  const accounts = useBrowserAccounts();
  const popup = useBrowserAccountPopup();
  const [reauthError, setReauthError] = useState<string | null>(null);
  const authenticatorApp = useAuthenticatorAppApi(
    context.clientConfig.managedAuthSessionSetMode ?? "dual",
  );
  return (
    <SecurityController
      mode={context.clientConfig.managedAuthSessionSetMode ?? "dual"}
      authenticatorApp={authenticatorApp}
      userId={context.authSession!.user.id}
      email={context.authSession!.user.email}
      reauthError={reauthError}
      onReauthenticate={() => {
        const slotId = accounts.projection?.selectedSlotId;
        if (!slotId) {
          setReauthError(
            "Select the account you want to manage, then open Personal settings again.",
          );
          return;
        }
        setReauthError(null);
        popup.open(() => accounts.beginReauth(slotId), {
          onError: () =>
            setReauthError("Couldn't open sign-in. Allow popups for Opengeni and try again."),
          onSettled: () => context.revalidatePrincipalAccess(),
        });
      }}
    />
  );
}

export function SecurityController({
  mode,
  userId,
  email,
  onReauthenticate,
  reauthError,
  api: suppliedApi,
  authenticatorApp,
}: {
  mode: "legacy" | "dual" | "broker";
  userId: string;
  email: string;
  onReauthenticate: () => void;
  reauthError?: string | null;
  api?: ReturnType<typeof createSignInMethodsApi>;
  /** Present only when the deployment offers an authenticator app (TOTP). */
  authenticatorApp?: StepUpApi | undefined;
}) {
  const api = useMemo(
    () => suppliedApi ?? createSignInMethodsApi(mode),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- actor changes invalidate the API's captured epoch even though userId is not a constructor argument
    [mode, suppliedApi, userId],
  );
  const live = useRef(false);
  const owner = useRef(userId);
  const lifecycle = useRef(0);
  const [inventory, setInventory] = useState<SignInMethods | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [requiresAuth, setRequiresAuth] = useState(false);
  const [identityChanged, setIdentityChanged] = useState(false);
  const [uncertain, setUncertain] = useState<PreparedSignInCommand | null>(null);
  const [revision, setRevision] = useState(0);
  const [committed, setCommitted] = useState(false);
  const isCurrent = useCallback(() => live.current && owner.current === userId, [userId]);
  useEffect(() => {
    live.current = true;
    owner.current = userId;
    lifecycle.current += 1;
    let active = true;
    setInventory(null);
    setError(null);
    void api
      .list()
      .then((result) => {
        if (!active || !isCurrent()) return;
        setInventory(result);
        setRequiresAuth(result.freshAuthenticationRequired);
        const receipt = readSignInChangeFeedback();
        if (receipt?.userId === userId && !result.freshAuthenticationRequired) {
          setSuccess(receipt.message);
          clearSignInChangeFeedback();
        }
        const callback = new URLSearchParams(window.location.search).get("signInMethod");
        if (callback === "connected") {
          const usable = result.methods
            .filter((method) => method.connected && method.available)
            .map((method) =>
              method.provider === "credential"
                ? "email and password"
                : providerLabel(method.provider),
            );
          setSuccess(
            usable.length
              ? `Sign-in methods confirmed: ${usable.join(", ")}. You can use these to access your Opengeni account.`
              : "The provider returned to Opengeni, but no usable sign-in method was confirmed. Review the methods below before continuing.",
          );
        }
        if (callback === "error")
          setError(
            signInCallbackError(
              new URLSearchParams(window.location.search).get("error") ?? "unknown",
            ),
          );
      })
      .catch(() => {
        if (active && isCurrent())
          setError(
            "Couldn't load your sign-in methods. Try refreshing, or sign in again if your session expired.",
          );
      });
    return () => {
      active = false;
      live.current = false;
      lifecycle.current += 1;
    };
  }, [api, isCurrent, revision, userId]);

  async function execute(
    command: PreparedSignInCommand,
    acceptedLifecycle = lifecycle.current,
  ): Promise<boolean> {
    try {
      const result = await api.execute<SignInChangeResult | { url: string }>(command);
      if (!isCurrent() || acceptedLifecycle !== lifecycle.current) return false;
      setUncertain(null);
      if ("url" in result) {
        const target = new URL(result.url, window.location.origin);
        if (target.protocol !== "https:" && target.origin !== window.location.origin)
          throw new Error("Invalid provider redirect");
        window.location.assign(target.href);
        return true;
      }
      const changed =
        command.path === "password"
          ? "Your password was saved."
          : `${providerLabel((command.body as { provider: "google" | "github" }).provider)} was disconnected from sign-in.`;
      const notification =
        result.notification === "sent"
          ? ""
          : " The change succeeded, but the security notification could not be confirmed as delivered.";
      const message = `${changed}${notification} Sign in again as ${email} with a remaining sign-in method to continue.`;
      retainSignInChangeFeedback({ userId, email, message: `${changed}${notification}` });
      setSuccess(message);
      setRequiresAuth(true);
      setCommitted(true);
      setError(null);
      return true;
    } catch (caught) {
      if (!isCurrent() || acceptedLifecycle !== lifecycle.current) return false;
      const failure = signInMethodFailure(caught);
      if (failure.kind !== "unknown") {
        setUncertain(null);
        if (failure.kind === "reauth" || failure.kind === "identity_changed") setRequiresAuth(true);
        if (failure.kind === "identity_changed") setIdentityChanged(true);
      } else {
        // Keep the exact body, UUID, revision and admission headers in memory
        // only. A transport failure is not proof the mutation failed.
        setUncertain(command);
      }
      setError(failure.message);
      return false;
    }
  }
  async function mutate(
    path: PreparedSignInCommand["path"],
    fields: { provider: "google" | "github" } | { newPassword: string; currentPassword?: string },
  ) {
    if (!inventory || inFlight.current || requiresAuth || uncertain) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const acceptedLifecycle = lifecycle.current;
    try {
      const body: SignInCommand = {
        operationId: crypto.randomUUID(),
        expectedIdentityId: inventory.identityId,
        expectedIdentityRevision: inventory.identityRevision,
        ...fields,
      };
      const command = await api.prepare(path, body);
      if (!isCurrent() || acceptedLifecycle !== lifecycle.current) return false;
      return await execute(command, acceptedLifecycle);
    } catch {
      if (isCurrent() && acceptedLifecycle === lifecycle.current)
        setError("Couldn't prepare this change. Refresh your methods and try again.");
      return false;
    } finally {
      if (isCurrent() && acceptedLifecycle === lifecycle.current) {
        setBusy(false);
        inFlight.current = false;
      }
    }
  }
  const password = inventory?.methods.find((method) => method.provider === "credential");
  // While a change's result is unknown, keep saying so even after a refresh
  // cleared the message: new changes stay locked until the same request is retried.
  const shownError =
    reauthError ??
    error ??
    (uncertain
      ? "The result of your last change is unknown. Retry the same request, or refresh to check your methods."
      : null);
  return (
    <PersonalSettingsShell email={inventory?.email ?? email}>
      {committed ? (
        <div className="min-w-0">
          <SecurityPageHeader />
          <SecurityPageBody>
            <div className="grid min-w-0 gap-3">
              <div role="status">
                <Notice
                  tone="success"
                  title="Sign-in methods updated"
                  actionLayout="responsive"
                  action={
                    <Button size="sm" className="pointer-coarse:h-11" onClick={onReauthenticate}>
                      Sign in again
                    </Button>
                  }
                >
                  {success}
                </Notice>
              </div>
              {reauthError ? (
                <div role="alert">
                  <Notice tone="failed">{reauthError}</Notice>
                </div>
              ) : null}
            </div>
          </SecurityPageBody>
        </div>
      ) : !inventory ? (
        <div className="min-w-0">
          <SecurityPageHeader />
          <SecurityPageBody>
            <SignInMethodsPlaceholder>
              {error ? (
                <ErrorMessage
                  className="py-4"
                  title="Couldn't load sign-in methods."
                  action={
                    <>
                      <RowButton onClick={() => setRevision((value) => value + 1)}>
                        Try again
                      </RowButton>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="pointer-coarse:h-11"
                        onClick={onReauthenticate}
                      >
                        Sign in again
                      </Button>
                    </>
                  }
                >
                  {error}
                </ErrorMessage>
              ) : (
                <div role="status" aria-label="Loading sign-in methods">
                  <SettingRowSkeleton />
                  <SettingRowSkeleton />
                  <SettingRowSkeleton />
                </div>
              )}
            </SignInMethodsPlaceholder>
          </SecurityPageBody>
        </div>
      ) : (
        <SignInMethodsView
          methods={inventory.methods
            .filter((method) => method.provider !== "credential")
            .map((method) => ({
              provider: method.provider as "google" | "github",
              connected: method.connected,
              available: method.available,
              email: method.connected ? inventory.email : null,
              emailLabel: "Connected · Opengeni account: ",
              handle: null,
              canDisconnect: method.canDisconnect,
              reconnectRequired: method.implicitRelinkingSuppressed,
            }))}
          hasPassword={password?.connected ?? false}
          passwordAvailable={password?.available ?? false}
          busy={busy}
          mutationLocked={uncertain !== null}
          recentAuthRequired={requiresAuth}
          error={shownError}
          errorAction={
            uncertain ? (
              <Button
                size="sm"
                className="pointer-coarse:h-11"
                disabled={busy}
                onClick={() => {
                  if (inFlight.current) return;
                  inFlight.current = true;
                  setBusy(true);
                  void execute(uncertain).finally(() => {
                    if (isCurrent()) {
                      inFlight.current = false;
                      setBusy(false);
                    }
                  });
                }}
              >
                Retry same request
              </Button>
            ) : undefined
          }
          sectionAction={
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || identityChanged}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCwIcon aria-hidden="true" />
              Refresh sign-in methods
            </Button>
          }
          success={success}
          additionalSections={
            authenticatorApp ? (
              <AuthenticatorAppSection
                key={userId}
                api={authenticatorApp}
                hasPassword={password?.connected ?? false}
              />
            ) : undefined
          }
          onReauthenticate={onReauthenticate}
          onConnect={(provider) => {
            void mutate("connect", { provider });
          }}
          onDisconnect={(provider) => mutate("disconnect", { provider })}
          onPassword={(newPassword, currentPassword) =>
            mutate("password", {
              newPassword,
              ...(currentPassword === undefined ? {} : { currentPassword }),
            })
          }
        />
      )}
    </PersonalSettingsShell>
  );
}

type AuthenticatorAppStep =
  | { kind: "idle" }
  | { kind: "password" }
  | { kind: "scan"; totpURI: string }
  | { kind: "disable" };

function authenticatorAppError(error: unknown, hasPassword: boolean): string {
  switch (stepUpErrorCode(error)) {
    case "TOTP_AUTHENTICATION_REQUIRED":
      return hasPassword
        ? "That password didn't match. Check it and try again."
        : "Sign in again, then try within five minutes.";
    case "TOTP_INVALID_CODE":
      return "That code didn't match. Enter the current code from your authenticator app.";
    case "TOTP_LOCKED":
      return "Too many wrong codes. Wait 15 minutes, then try again.";
    case "TOTP_RATE_LIMITED":
      return "Too many attempts. Wait a minute and try again.";
    case "TOTP_ALREADY_ENROLLED":
      return "An authenticator app is already set up. Refresh this page.";
    case "TOTP_ENROLLMENT_NOT_STARTED":
    case "TOTP_NOT_ENROLLED":
      return "Your authenticator app changed in another tab. Refresh this page.";
    default:
      return "Couldn't change your authenticator app. Try again.";
  }
}

/**
 * Set up or turn off the authenticator app that confirms it's you. Shown only
 * when the deployment offers TOTP. Setting it up shows a setup key for the
 * app, then turns it on once the app's first code matches.
 */
export function AuthenticatorAppSection({
  api,
  hasPassword,
}: {
  api: StepUpApi;
  hasPassword: boolean;
}) {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState<AuthenticatorAppStep>({ kind: "idle" });
  const [passwordValue, setPasswordValue] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .totpStatus()
      .then((loaded) => {
        if (active) setStatus(loaded);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [api]);

  function reset(next: AuthenticatorAppStep = { kind: "idle" }) {
    setStep(next);
    setPasswordValue("");
    setCode("");
    setError(null);
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
    } catch (caught) {
      setError(authenticatorAppError(caught, hasPassword));
    } finally {
      setBusy(false);
    }
  }

  const enroll = () =>
    run(async () => {
      const { totpURI } = await api.enrollTotp(hasPassword ? { password: passwordValue } : {});
      reset({ kind: "scan", totpURI });
    });
  const confirm = () =>
    run(async () => {
      await api.confirmTotp(code);
      reset();
      setStatus("enrolled");
      setSuccess(
        "Your authenticator app is on. Opengeni asks for its code when you confirm it's you.",
      );
    });
  const disable = () =>
    run(async () => {
      await api.disableTotp({ ...(hasPassword ? { password: passwordValue } : {}), code });
      reset();
      setStatus("none");
      setSuccess("Your authenticator app is off.");
    });

  const codeField = (id: string) => (
    <Field label="Code from your authenticator app" id={id} required>
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
  );
  const passwordField = (id: string) =>
    hasPassword ? (
      <Field label="Password" id={id} required>
        <TextInput
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
          value={passwordValue}
          onChange={(event) => setPasswordValue(event.target.value)}
        />
      </Field>
    ) : null;
  const formActions = (submitLabel: string, destructive = false) => (
    <div className="mt-5 flex flex-wrap gap-2">
      <Button
        type="submit"
        size="sm"
        variant={destructive ? "destructive" : "default"}
        className="pointer-coarse:h-11"
        disabled={busy}
      >
        {busy ? "Saving…" : submitLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="pointer-coarse:h-11"
        disabled={busy}
        onClick={() => reset()}
      >
        Cancel
      </Button>
    </div>
  );
  const enrolled = status === "enrolled";
  const setupKey = step.kind === "scan" ? totpSetupKey(step.totpURI) : null;

  return (
    <Section
      title="Authenticator app"
      description="Use a code from an app such as 1Password or Google Authenticator when you confirm it's you."
    >
      {loadFailed ? (
        <div role="alert">
          <Notice tone="failed">Couldn't load your authenticator app. Refresh this page.</Notice>
        </div>
      ) : status === null ? (
        <div role="status" aria-label="Loading authenticator app">
          <SettingRowSkeleton />
        </div>
      ) : (
        <>
          <SettingRow
            label="Authenticator app"
            description={enrolled ? "On" : "Not set up"}
            control={
              step.kind !== "idle" ? undefined : enrolled ? (
                <RowButton disabled={busy} onClick={() => reset({ kind: "disable" })}>
                  Turn off
                </RowButton>
              ) : (
                <RowButton
                  disabled={busy}
                  onClick={() => (hasPassword ? reset({ kind: "password" }) : void enroll())}
                >
                  Set up
                </RowButton>
              )
            }
          />
          {step.kind === "password" ? (
            <form
              aria-label="Set up authenticator app"
              className="py-4"
              onSubmit={(event) => {
                event.preventDefault();
                void enroll();
              }}
            >
              <FieldStack className="max-w-md gap-5">
                {passwordField("totp-enroll-password")}
              </FieldStack>
              {formActions("Continue")}
            </form>
          ) : null}
          {step.kind === "scan" ? (
            <form
              aria-label="Turn on authenticator app"
              className="py-4"
              onSubmit={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              <FieldStack className="max-w-md gap-5">
                <p className="text-sm text-fg-muted">
                  Add Opengeni to your authenticator app with this setup key, then enter the code it
                  shows.{" "}
                  <a className="text-fg underline underline-offset-2" href={step.totpURI}>
                    Open in authenticator app
                  </a>
                </p>
                {setupKey ? <CopyField variant="field" label="setup key" value={setupKey} /> : null}
                {codeField("totp-confirm-code")}
              </FieldStack>
              {formActions("Turn on")}
            </form>
          ) : null}
          {step.kind === "disable" ? (
            <form
              aria-label="Turn off authenticator app"
              className="py-4"
              onSubmit={(event) => {
                event.preventDefault();
                void disable();
              }}
            >
              <FieldStack className="max-w-md gap-5">
                {passwordField("totp-disable-password")}
                {codeField("totp-disable-code")}
              </FieldStack>
              {formActions("Turn off", true)}
            </form>
          ) : null}
          {error ? (
            <div role="alert">
              <Notice tone="failed">{error}</Notice>
            </div>
          ) : null}
          {success ? (
            <div role="status">
              <Notice tone="success">{success}</Notice>
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}
