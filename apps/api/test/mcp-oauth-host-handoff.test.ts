import { describe, expect, test } from "bun:test";
import { startApiOrganizationGovernanceOverride } from "../src/index";
import { runMcpOAuthHostHandoff } from "../src/mcp-oauth";
import type { McpOAuthHostProposal } from "@opengeni/db";

const proposal: McpOAuthHostProposal = {
  requestHash: "a".repeat(64),
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  digest: "b".repeat(64),
  operationId: "33333333-3333-4333-8333-333333333333",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  material: {
    clientId: "client",
    organizationId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    subjectId: "user:fixture",
    resource: "https://native.example/v1/mcp",
    redirectUri: "http://127.0.0.1:4444/callback",
    codeChallenge: "x".repeat(43),
    codeChallengeMethod: "S256",
    permissions: ["workspace:read"],
    toolIdentities: [],
    organizationAccess: null,
    consentPreset: "full",
    toolSetVersions: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    human: {
      identityId: "44444444-4444-4444-8444-444444444444",
      authSessionId: "fixture",
      loginBindingId: "55555555-5555-4555-8555-555555555555",
      loginBindingRevision: 1,
    },
  },
};
// Deliberately not an authentication fixture: the wrapper reads only exp to
// REDUCE its deadline. The embedding host must verify the real JWT signature.
const opaqueCredential = (expiresAt: number) =>
  `opaque.${Buffer.from(JSON.stringify({ exp: expiresAt / 1000 })).toString("base64url")}.credential`;

describe("native host consent handoff budget and privacy", () => {
  test("the native API entry forwards the optional port without changing stock composition", () => {
    const port = { async admit() {} };
    expect(startApiOrganizationGovernanceOverride({})).toEqual({});
    expect(startApiOrganizationGovernanceOverride({ mcpOAuthHostConsent: null })).toEqual({
      mcpOAuthHostConsent: null,
    });
    expect(
      startApiOrganizationGovernanceOverride({ mcpOAuthHostConsent: port }).mcpOAuthHostConsent,
    ).toBe(port);
  });
  test("credential is explicit opaque access, absent from serialization and host errors", async () => {
    const token = opaqueCredential(Date.now() + 60_000);
    const start = Date.now();
    await runMcpOAuthHostHandoff(
      {
        async admit(input) {
          expect(input.readCredential()).toBe(token);
          expect(JSON.stringify(input)).not.toContain(token);
          expect(JSON.stringify(input)).not.toContain("material");
          expect(input.deadlineAt).toBeLessThanOrEqual(start + 10_000);
          throw new Error(token);
        },
      },
      proposal,
      token,
    );
    // The uncertain callback outcome itself grants nothing; the route must read admission.
  });
  test("request expiry clamps the aggregate timer and aborts a stalled handoff", async () => {
    const expiry = Date.now() + 30;
    let aborted = false;
    await runMcpOAuthHostHandoff(
      {
        async admit(input) {
          expect(input.deadlineAt).toBeLessThanOrEqual(expiry);
          input.signal.addEventListener("abort", () => {
            aborted = true;
          });
          await new Promise(() => {});
        },
      },
      { ...proposal, expiresAt: new Date(expiry).toISOString() },
      opaqueCredential(Date.now() + 60_000),
    );
    expect(aborted).toBe(true);
  });
  test("expired or malformed opaque credentials dispatch nothing", async () => {
    let dispatched = false;
    const port = {
      async admit() {
        dispatched = true;
      },
    };
    await expect(
      runMcpOAuthHostHandoff(port, proposal, opaqueCredential(Date.now() - 1)),
    ).rejects.toThrow("expired");
    await expect(runMcpOAuthHostHandoff(port, proposal, "service-document")).rejects.toThrow(
      "invalid",
    );
    expect(dispatched).toBe(false);
  });
});
