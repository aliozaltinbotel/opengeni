import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "@/api";
import type { createSignInMethodsApi, SignInMethods } from "@/lib/sign-in-methods-api";
import type { StepUpApi, TotpStatus } from "@/lib/step-up-api";

if (!globalThis.document)
  GlobalRegistrator.register({ url: "https://opengeni.test/reauthenticate" });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@/components/settings/personal-settings-shell", () => ({
  PersonalSettingsShell: ({ email, children }: { email: string; children: ReactNode }) => (
    <div>
      <span>{email}</span>
      {children}
    </div>
  ),
}));
const { ReauthenticateController, safeReauthenticationReturnPath } =
  await import("./reauthenticate");
const { SecurityController } = await import("./personal-security");

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`missing input ${id}`);
  return element;
}

/** Type into a controlled input: set its value, then run React's onChange. */
async function type(id: string, value: string) {
  await act(async () => {
    const element = input(id);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(
      element,
      value,
    );
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey
      ? (element as unknown as Record<string, { onChange?: (event: unknown) => void }>)[propsKey]
      : undefined;
    if (props?.onChange) props.onChange({ target: element, currentTarget: element });
    else element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function click(label: string) {
  await act(async () => {
    const button = [...document.querySelectorAll("button")].find(
      (node) => node.textContent === label || node.getAttribute("aria-label") === label,
    );
    expect(button).toBeDefined();
    button!.click();
  });
}

function stepUpApi(overrides: Partial<StepUpApi> = {}): StepUpApi & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    reauthenticationStatus: async () => ({ password: true, totpRequired: false }),
    reauthenticate: async (body) => {
      calls.push(body);
      return { authTime: new Date().toISOString(), amr: ["pwd"] };
    },
    totpStatus: async (): Promise<TotpStatus> => "none",
    enrollTotp: async () => ({ totpURI: "otpauth://totp/Opengeni:a?secret=JBSWY3DPEHPK3PXP" }),
    confirmTotp: async () => {},
    disableTotp: async () => {},
    ...overrides,
  };
}

test("return paths stay on this origin and fall back to /", () => {
  const origin = "https://opengeni.test";
  expect(safeReauthenticationReturnPath("https://evil.example", origin)).toBe("/");
  expect(safeReauthenticationReturnPath("https://evil.example/workspaces", origin)).toBe("/");
  expect(safeReauthenticationReturnPath("//evil.example/path", origin)).toBe("/");
  expect(safeReauthenticationReturnPath("/\\evil.example", origin)).toBe("/");
  expect(safeReauthenticationReturnPath("javascript:alert(1)", origin)).toBe("/");
  expect(safeReauthenticationReturnPath("/ok\tpath", origin)).toBe("/");
  expect(safeReauthenticationReturnPath(undefined, origin)).toBe("/");
  expect(safeReauthenticationReturnPath("workspaces/1", origin)).toBe("/");
  expect(safeReauthenticationReturnPath("/workspaces/1/settings?tab=access#keys", origin)).toBe(
    "/workspaces/1/settings?tab=access#keys",
  );
});

test("return=https://evil.example is ignored: confirming returns to /", async () => {
  const api = stepUpApi();
  const returned: string[] = [];
  await render(
    <ReauthenticateController
      mode="legacy"
      email="person@example.com"
      returnTo="https://evil.example"
      api={api}
      onSignInAgain={() => {}}
      onReturn={(path) => returned.push(path)}
    />,
  );
  expect(host!.textContent).toContain("Confirm it's you");
  expect(host!.textContent).not.toContain("Authenticator app code");
  await type("reauthenticate-password", "password1234");
  await click("Continue");
  expect(api.calls).toEqual([{ password: "password1234" }]);
  expect(returned).toEqual(["/"]);
});

test("a same-origin return path is followed after confirming with password and code", async () => {
  const api = stepUpApi({
    reauthenticationStatus: async () => ({ password: true, totpRequired: true }),
  });
  const returned: string[] = [];
  await render(
    <ReauthenticateController
      mode="legacy"
      email="person@example.com"
      returnTo="/workspaces/1/settings"
      api={api}
      onSignInAgain={() => {}}
      onReturn={(path) => returned.push(path)}
    />,
  );
  expect(host!.textContent).toContain("Authenticator app code");
  await type("reauthenticate-password", "password1234");
  await click("Continue");
  // The code is required: nothing is sent without it.
  expect(api.calls).toEqual([]);
  expect(input("reauthenticate-code").required).toBe(true);
  await type("reauthenticate-code", "123456");
  await click("Continue");
  expect(api.calls).toEqual([{ password: "password1234", totp: "123456" }]);
  expect(returned).toEqual(["/workspaces/1/settings"]);
});

test("a refused confirmation stays on the page and says what to do", async () => {
  const api = stepUpApi({
    reauthenticate: async () => {
      throw new ApiError(401, "", { code: "REAUTH_FAILED" });
    },
  });
  const returned: string[] = [];
  await render(
    <ReauthenticateController
      mode="legacy"
      email="person@example.com"
      returnTo="/"
      api={api}
      onSignInAgain={() => {}}
      onReturn={(path) => returned.push(path)}
    />,
  );
  await type("reauthenticate-password", "wrong");
  await click("Continue");
  expect(returned).toEqual([]);
  expect(host!.querySelector("[role=alert]")!.textContent).toContain("didn't match");
  expect(input("reauthenticate-password").value).toBe("");
});

test("a deployment without re-authentication says so", async () => {
  const api = stepUpApi({
    reauthenticationStatus: async () => {
      throw new ApiError(404, "", { code: "REAUTH_DISABLED" });
    },
  });
  await render(
    <ReauthenticateController
      mode="legacy"
      email="person@example.com"
      api={api}
      onSignInAgain={() => {}}
    />,
  );
  expect(host!.textContent).toContain("Confirming it's you is unavailable");
});

const inventory: SignInMethods = {
  identityId: "00000000-0000-4000-8000-000000000003",
  email: "person@example.com",
  emailVerified: true,
  identityRevision: 4,
  freshAuthenticationRequired: false,
  methods: [
    {
      provider: "credential",
      connected: true,
      available: true,
      canDisconnect: false,
      implicitRelinkingSuppressed: false,
    },
  ],
};
const signInMethodsApi = {
  list: async () => inventory,
  prepare: async () => {
    throw new Error("unused");
  },
  execute: async () => {
    throw new Error("unused");
  },
} as unknown as ReturnType<typeof createSignInMethodsApi>;

test("with TOTP disabled in settings the authenticator app UI is absent (stock)", async () => {
  await render(
    <SecurityController
      mode="legacy"
      userId="actor-a"
      email="person@example.com"
      api={signInMethodsApi}
      onReauthenticate={() => {}}
    />,
  );
  expect(host!.textContent).toContain("Sign-in methods");
  expect(host!.textContent).not.toContain("Authenticator app");
});

test("with TOTP enabled a person sets up and turns off their authenticator app", async () => {
  const enrolled: unknown[] = [];
  const confirmed: string[] = [];
  const disabled: unknown[] = [];
  const api = stepUpApi({
    enrollTotp: async (body) => {
      enrolled.push(body);
      return { totpURI: "otpauth://totp/Opengeni:person?secret=JBSWY3DPEHPK3PXP&issuer=Opengeni" };
    },
    confirmTotp: async (code) => {
      confirmed.push(code);
    },
    disableTotp: async (body) => {
      disabled.push(body);
    },
  });
  await render(
    <SecurityController
      mode="legacy"
      userId="actor-a"
      email="person@example.com"
      api={signInMethodsApi}
      authenticatorApp={api}
      onReauthenticate={() => {}}
    />,
  );
  expect(host!.textContent).toContain("Authenticator app");
  expect(host!.textContent).toContain("Not set up");
  await click("Set up");
  await type("totp-enroll-password", "password1234");
  await click("Continue");
  expect(enrolled).toEqual([{ password: "password1234" }]);
  expect(host!.textContent).toContain("setup key");
  expect((host!.querySelector("input[readonly]") as HTMLInputElement | null)?.value).toBe(
    "JBSWY3DPEHPK3PXP",
  );
  await type("totp-confirm-code", "123456");
  await click("Turn on");
  expect(confirmed).toEqual(["123456"]);
  expect(host!.textContent).toContain("Your authenticator app is on.");

  await click("Turn off");
  await type("totp-disable-password", "password1234");
  await type("totp-disable-code", "654321");
  const submit = [...host!.querySelectorAll("form button[type=submit]")].find(
    (button) => button.textContent === "Turn off",
  ) as HTMLButtonElement;
  await act(async () => submit.click());
  expect(disabled).toEqual([{ password: "password1234", code: "654321" }]);
  expect(host!.textContent).toContain("Your authenticator app is off.");
});
