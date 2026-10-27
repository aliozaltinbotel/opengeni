import { createBrowserAccountsClient } from "@opengeni/sdk/accounts";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";
import { ApiError, apiBaseUrl, currentManagedActorEpoch, managedActorFetch } from "@/api";

/**
 * Browser client for confirming it's you (`/v1/auth/reauthenticate`) and for
 * the authenticator app that confirmation can ask for (`/v1/auth/totp/*`).
 * Mutations carry the browser session-set proof in dual and broker modes,
 * like the sign-in method changes.
 */

export type ReauthenticationStatus = { password: boolean; totpRequired: boolean };
export type ReauthenticationResult = { authTime: string; amr: string[] };
export type TotpStatus = "none" | "pending" | "enrolled";

export type StepUpApi = {
  reauthenticationStatus(): Promise<ReauthenticationStatus>;
  reauthenticate(input: { password?: string; totp?: string }): Promise<ReauthenticationResult>;
  totpStatus(): Promise<TotpStatus>;
  enrollTotp(input: { password?: string }): Promise<{ totpURI: string }>;
  confirmTotp(code: string): Promise<void>;
  disableTotp(input: { password?: string; code: string }): Promise<void>;
};

function stepUpError(status: number, body: string): ApiError {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested =
      parsed.error && typeof parsed.error === "object"
        ? (parsed.error as Record<string, unknown>)
        : null;
    const code = typeof parsed.code === "string" ? parsed.code : nested?.code;
    return new ApiError(status, body, typeof code === "string" ? { code } : {});
  } catch {
    return new ApiError(status, body);
  }
}

export function createStepUpApi(sessionSetMode: "legacy" | "dual" | "broker"): StepUpApi {
  const actorEpoch = currentManagedActorEpoch();
  const assertActor = () => {
    if (currentManagedActorEpoch() !== actorEpoch)
      throw new DOMException("The browser account changed", "AbortError");
  };
  async function admissionHeaders(): Promise<Record<string, string>> {
    if (sessionSetMode === "legacy") return {};
    const projection = await createBrowserAccountsClient({
      baseUrl: apiBaseUrl,
      fetch: managedActorFetch,
    }).getSessionSet();
    assertActor();
    if (!projection.selectedSlotId || projection.actorEpoch !== actorEpoch)
      throw new DOMException("The browser account changed", "AbortError");
    return {
      "x-opengeni-session-csrf": projection.csrfToken,
      "x-opengeni-actor-epoch": projection.actorEpoch,
    };
  }
  async function request<T>(path: string, body?: unknown): Promise<T> {
    assertActor();
    const response = await managedActorFetch(`${apiBaseUrl}/v1/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        ...(body === undefined ? {} : await admissionHeaders()),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assertActor();
    if (!response.ok) throw stepUpError(response.status, text);
    return JSON.parse(text) as T;
  }
  return {
    reauthenticationStatus: () => request<ReauthenticationStatus>("/reauthenticate"),
    reauthenticate: (input) => request<ReauthenticationResult>("/reauthenticate", input),
    totpStatus: async () => (await request<{ status: TotpStatus }>("/totp")).status,
    enrollTotp: (input) => request<{ totpURI: string }>("/totp/enroll", input),
    confirmTotp: async (code) => {
      await request("/totp/confirm", { code });
    },
    disableTotp: async (input) => {
      await request("/totp/disable", input);
    },
  };
}

/** The setup key an authenticator app asks for when the QR code can't be scanned. */
export function totpSetupKey(totpURI: string): string | null {
  try {
    const url = new URL(totpURI);
    const secret = url.protocol === "otpauth:" ? url.searchParams.get("secret") : null;
    return secret && /^[A-Z2-7]+=*$/u.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

/** The refusal code of a step-up request, when the server named one. */
export function stepUpErrorCode(error: unknown): string | null {
  return error instanceof ApiError && typeof error.code === "string" ? error.code : null;
}
