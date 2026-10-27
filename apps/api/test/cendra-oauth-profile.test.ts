import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { resolveMcpOAuthDiscovery, validateHttpUrl } from "../../../packages/network/src/index";
import { buildAuthorizationUrl, chooseMcpAuthorizeScopes } from "../src/integrations/oauth-client";
import {
  assertAuthorizationServerPins,
  builtInOAuthProfileFor,
  defaultOwnershipFor,
} from "../src/integrations/oauth-profiles";

const resource = "https://agentic.cendra.ai/v1/mcp";
const issuer = "https://wealthy-bee-2.clerk.accounts.dev";
const readScopes = ["user:org:read", "cendra:operations:read"];

function cendraProfile() {
  const profile = builtInOAuthProfileFor({ mcpUrl: resource });
  if (!profile) throw new Error("Cendra OAuth profile missing");
  return profile;
}

describe("Cendra Single MCP read OAuth profile", () => {
  async function discoverMetadata(overrides: Record<string, string> = {}) {
    return await resolveMcpOAuthDiscovery({
      resourceUrl: resource,
      challenge: { scheme: "bearer", scope: [] },
      canonicalizeResource: (value) => new URL(value).toString(),
      validateEndpoint: (value, label) => validateHttpUrl(value, { label }),
      fetchMetadata: async ({ kind, url }) => ({
        status: "present",
        url,
        document: kind === "protected_resource"
          ? { resource, authorization_servers: [issuer] }
          : {
              issuer,
              authorization_endpoint: `${issuer}/oauth/authorize`,
              token_endpoint: `${issuer}/oauth/token`,
              code_challenge_methods_supported: ["S256"],
              ...overrides,
            },
      }),
    });
  }

  test("real discovery URL validation preserves the exact reviewed issuer identifier", async () => {
    const discovery = await discoverMetadata();
    const pins = cendraProfile().authorizationServer;
    if (!pins) throw new Error("Cendra authorization server pins missing");
    expect(discovery.authorizationServerMetadata.issuer).toBe(issuer);
    expect(() => assertAuthorizationServerPins(discovery.authorizationServerMetadata, pins)).not.toThrow();
  });

  for (const drift of [
    { issuer: `${issuer}/` },
    { issuer: `${issuer}/other` },
    { issuer: "https://other.example" },
    { issuer: "https://user@wealthy-bee-2.clerk.accounts.dev" },
    { issuer: "http://wealthy-bee-2.clerk.accounts.dev" },
    { authorization_endpoint: "https://other.example/oauth/authorize" },
    { token_endpoint: "https://other.example/oauth/token" },
  ]) {
    test(`discovery and the strict profile reject metadata drift ${JSON.stringify(drift)}`, async () => {
      const pins = cendraProfile().authorizationServer;
      if (!pins) throw new Error("Cendra authorization server pins missing");
      await expect((async () => {
        const discovery = await discoverMetadata(drift);
        assertAuthorizationServerPins(discovery.authorizationServerMetadata, pins);
      })()).rejects.toThrow();
    });
  }

  test("matches only the exact resource with a personal exact connection binding", () => {
    const profile = cendraProfile();
    expect(defaultOwnershipFor(profile)).toBe("personal");
    expect(profile.requiredOwnership?.ownership).toBe("personal");
    // Upstream removed the per-profile `exactMcpBinding` flag: reconnect now matches the exact
    // stored MCP URL for every profile, and this profile still requires the exact resource.
    expect(profile.requireExactMcpUrl?.url).toBe(resource);
    expect(profile.sendResourceParameter).toBe(true);
    expect(profile.providerOAuthDiscovery).toBeUndefined();
    for (const mcpUrl of [
      `${resource}/`, `${resource}?other=1`, `${resource}#other`,
      "https://agentic.cendra.ai/other", "https://other.example/v1/mcp",
    ]) {
      expect(builtInOAuthProfileFor({ mcpUrl, providerDomain: "agentic.cendra.ai" })).toBeNull();
    }
  });

  test("empty native Connect requests and caller or discovery scopes remain read-only", () => {
    for (const requested of [[], ["cendra:onboarding:write"], undefined]) {
      expect(chooseMcpAuthorizeScopes({
        mcpUrl: resource, requested, challenged: ["cendra:onboarding:read"],
        supported: [...readScopes, "cendra:onboarding:write"],
        authorizationServerScopesSupported: ["offline_access"],
      })).toEqual(readScopes);
    }
  });

  test("authorization retains the protected resource, PKCE and human consent redirect", () => {
    const scopes = chooseMcpAuthorizeScopes({
      mcpUrl: resource, requested: [], challenged: undefined, supported: [],
    });
    const url = new URL(buildAuthorizationUrl({
      endpoint: `${issuer}/oauth/authorize`, settings: testSettings(),
      clientId: "reviewed-client", redirectUri: "https://native.example/v1/integrations/oauth/callback",
      state: "signed-state", resource, verifier: "test-pkce-verifier", scopes,
      resourceParameterSupported: cendraProfile().sendResourceParameter,
    }));
    expect(url.origin).toBe(issuer);
    expect(url.searchParams.get("resource")).toBe(resource);
    expect(url.searchParams.get("scope")).toBe(readScopes.join(" "));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  test("requires the exact Clerk issuer and pinned authorization and token origins", () => {
    const pins = cendraProfile().authorizationServer;
    if (!pins) throw new Error("Cendra authorization server pins missing");
    const metadata = {
      issuer, authorizationServer: issuer,
      authorizationEndpoint: `${issuer}/oauth/authorize`, tokenEndpoint: `${issuer}/oauth/token`,
    };
    expect(() => assertAuthorizationServerPins(metadata, pins)).not.toThrow();
    for (const invalid of [
      { ...metadata, issuer: `${issuer}/other` },
      { ...metadata, authorizationServer: `${issuer}/other` },
      { ...metadata, issuer: `${issuer}/` },
      { ...metadata, authorizationEndpoint: "https://other.example/authorize" },
      { ...metadata, tokenEndpoint: "https://other.example/token" },
    ]) expect(() => assertAuthorizationServerPins(invalid, pins)).toThrow(pins.message);
    expect(pins.skipInLocalTest).toBe(false);
  });
});
