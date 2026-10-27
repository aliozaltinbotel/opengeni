import { expect, test } from "bun:test";

import { signInAuthenticationMethod } from "../src/auth/session-authentication";

test("only a password or Google/GitHub sign-in endpoint is an authentication", () => {
  expect(signInAuthenticationMethod("/sign-in/email", "credential")).toBe("pwd");
  expect(signInAuthenticationMethod("/sign-up/email", "credential")).toBe("pwd");
  expect(signInAuthenticationMethod("/callback/:id", "google")).toBe("oauth");
  expect(signInAuthenticationMethod("/callback/:id", "github")).toBe("oauth");
  expect(signInAuthenticationMethod("/callback/:id", "test-oidc")).toBeNull();
  expect(signInAuthenticationMethod("/callback/:id", undefined)).toBeNull();
  expect(signInAuthenticationMethod("/verify-email", "credential")).toBeNull();
  expect(signInAuthenticationMethod("/two-factor/verify-totp", "credential")).toBeNull();
  expect(signInAuthenticationMethod(undefined, "credential")).toBeNull();
});
