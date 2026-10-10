import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type AccessContext } from "@opengeni/contracts";
import * as database from "@opengeni/db";
import { accessGrantAuthorizationFromContext, nativeAccessContinuationForAuthorization, requireAccessGrantAuthorization, requireNativeAccessContinuationAuthority, type NativeAccessContinuation } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { requireAccessKey } from "../src/http/auth";

const accessKey = "configured-deployment-access-key";
const delegationSecret = "independent-first-party-delegation-secret";
const accountId = "00000000-0000-4000-8000-000000000101";
const workspaceId = "00000000-0000-4000-8000-000000000102";
const sessionId = "00000000-0000-4000-8000-000000000103";
const turnId = "00000000-0000-4000-8000-000000000104";
const attemptId = "00000000-0000-4000-8000-000000000105";

function protectedApp(options: { delegationSecret?: string } = {}) {
  const app = new Hono();
  app.use(
    "*",
    requireAccessKey(
      testSettings({
        productAccessMode: "configured",
        authRequired: true,
        accessKey,
        delegationSecret: options.delegationSecret,
      }),
    ),
  );
  app.get("/protected", (context) => context.json({ ok: true }));
  app.get("/v1/protected", (context) => context.json({ ok: true }));
  return app;
}

async function attemptBearer(secret: string, expiresAt = Math.floor(Date.now() / 1_000) + 3_600) {
  return await signDelegatedAccessToken(secret, {
    accountId,
    workspaceId,
    subjectId: `sandbox:${attemptId}`,
    subjectLabel: "sandbox Codemode",
    permissions: ["codemode:call"],
    sessionId,
    turnId,
    attemptId,
    executionGeneration: 1,
    principalKind: "agent_attempt",
    exp: expiresAt,
  });
}

describe("configured deployment perimeter authentication", () => {
  test("continues to accept the static deployment key in either supported header", async () => {
    const app = protectedApp({ delegationSecret });
    for (const headers of [
      { "x-opengeni-access-key": accessKey },
      { authorization: `Bearer ${accessKey}` },
    ]) {
      expect((await app.request("/protected", { headers })).status).toBe(200);
    }
  });

  test("admits a valid first-party delegated bearer only to product route authorization", async () => {
    const bearer = await attemptBearer(delegationSecret);
    const app = new Hono();
    app.use(
      "*",
      requireAccessKey(
        testSettings({
          productAccessMode: "configured",
          authRequired: true,
          accessKey,
          delegationSecret,
        }),
      ),
    );
    app.get("/v1/workspaces/:workspaceId/protected", (context) => context.json({ ok: true }));
    app.get("/metrics", (context) => context.text("private metrics"));

    const headers = { authorization: `Bearer ${bearer}` };
    expect(
      (
        await app.request(`/v1/workspaces/${workspaceId}/protected`, {
          headers,
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/metrics", { headers })).status).toBe(401);
  });

  test("rejects forged, expired, malformed, and unsigned delegated bearers", async () => {
    const app = protectedApp({ delegationSecret });
    const bearers = await Promise.all([
      attemptBearer("wrong-delegation-secret"),
      attemptBearer(delegationSecret, 1),
      Promise.resolve("ogd_not-a-token"),
      Promise.resolve("unsigned-delegated-value"),
    ]);
    for (const bearer of bearers) {
      const response = await app.request("/v1/protected", {
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(response.status).toBe(401);
    }
  });

  test("derives delegated signing authority from the configured deployment key when no explicit secret is set", async () => {
    const bearer = await attemptBearer(accessKey);
    const response = await protectedApp().request("/v1/protected", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(response.status).toBe(200);
  });

  test("opens only the enabled OAuth protocol and exact MCP bearer resources", async () => {
    const oauthToken = `ogmcp_at_${"a".repeat(43)}`;
    const enabled = new Hono();
    enabled.use(
      "*",
      requireAccessKey(
        testSettings({
          productAccessMode: "configured",
          authRequired: true,
          accessKey,
          mcpOauthEnabled: true,
          publicBaseUrl: "https://api.example.test",
        }),
      ),
    );
    enabled.all("*", (context) => context.json({ ok: true }));

    for (const path of [
      "/.well-known/oauth-authorization-server",
      `/.well-known/oauth-protected-resource/v1/workspaces/${workspaceId}/mcp`,
      "/oauth/register",
      "/oauth/authorize",
      "/oauth/token",
    ]) {
      expect((await enabled.request(path)).status).toBe(200);
    }
    expect(
      (
        await enabled.request(`/v1/workspaces/${workspaceId}/mcp/docs`, {
          headers: { authorization: `Bearer ${oauthToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await enabled.request(`/v1/workspaces/${workspaceId}/tools/catalog`, {
          headers: { authorization: `Bearer ${oauthToken}` },
        })
      ).status,
    ).toBe(401);

    const disabled = protectedApp({ delegationSecret });
    expect((await disabled.request("/oauth/token")).status).toBe(401);
    expect(
      (
        await disabled.request(`/v1/workspaces/${workspaceId}/mcp`, {
          headers: { authorization: `Bearer ${oauthToken}` },
        })
      ).status,
    ).toBe(401);
  });

  test("admits only the signed Lens browser handoff and authenticated shared webhook paths", async () => {
    const app = new Hono();
    app.use(
      "*",
      requireAccessKey(
        testSettings({
          productAccessMode: "configured",
          authRequired: true,
          accessKey,
        }),
      ),
    );
    app.all("*", (context) => context.json({ ok: true }));

    for (const request of [
      new Request(`http://test/v1/workspaces/${workspaceId}/pr-review/github/connect?state=signed`),
      new Request(
        `http://test/v1/workspaces/${workspaceId}/pr-review/github/installations/select?state=signed`,
      ),
      new Request(
        `http://test/v1/workspaces/${workspaceId}/pr-review/github/installations/42/configure?state=signed`,
      ),
      new Request("http://test/v1/pr-review/github/setup"),
      new Request("http://test/v1/pr-review/github/oauth/callback"),
      new Request("http://test/v1/webhooks/pr-review/github", { method: "POST" }),
    ]) {
      expect((await app.request(request)).status).toBe(200);
    }
    expect(
      (
        await app.request(
          `http://test/v1/workspaces/${workspaceId}/pr-review/github/installations/42`,
        )
      ).status,
    ).toBe(401);
    expect((await app.request("/v1/webhooks/pr-review/github")).status).toBe(401);
  });
});


// Pure canonical-perimeter/issuer checks. No test fixture or DB allocation.
const continuationSpies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of continuationSpies.splice(0)) spy.mockRestore(); });
function configuredContinuationApp(settings: ReturnType<typeof testSettings>) {
  const context: AccessContext = { mode: "configured", subjectId: "configured:key",
    accountGrants: [{ accountId, subjectId: "configured:key", permissions: ["documents:search"] }],
    workspaceGrants: [{ accountId, workspaceId, subjectId: "configured:key", principalKind: "configured_key", permissions: ["documents:search"] }],
    defaultAccountId: accountId, defaultWorkspaceId: workspaceId };
  const bootstrap = spyOn(database, "bootstrapWorkspace").mockResolvedValue(context);
  continuationSpies.push(bootstrap);
  continuationSpies.push(spyOn(database, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(undefined));
  continuationSpies.push(spyOn(database, "withWorkspaceSubjectRls").mockImplementation(async (_db, _workspace, _subject, fn) => fn({} as never)));
  const currentGrant = spyOn(database, "getWorkspaceGrant").mockResolvedValue(context.workspaceGrants[0]!);
  continuationSpies.push(currentGrant);
  const app = new Hono(); app.onError(error => { throw error; }); app.use("*", requireAccessKey(settings));
  for (const path of ["/v1/protected", "/v1/config/client"]) app.get(path, async c => c.json(nativeAccessContinuationForAuthorization(
    await requireAccessGrantAuthorization(c, { db: {} as never, settings }, workspaceId, "documents:search"))));
  return { app, bootstrap, currentGrant, context };
}
test("configured continuation captures actual perimeter and rejects deployment-key/mode changes", async () => {
  const settings = testSettings({ productAccessMode: "configured", authRequired: true, accessKey, delegationSecret: undefined });
  const { app, bootstrap } = configuredContinuationApp(settings);
  const response = await app.request("/v1/protected", { headers: { "x-opengeni-access-key": accessKey } });
  const continuation = await response.json() as NativeAccessContinuation;
  expect(response.status).toBe(200); expect(continuation.kind).toBe("configured");
  expect(JSON.stringify(continuation)).not.toContain(accessKey);
  await requireNativeAccessContinuationAuthority({} as never, settings, continuation, continuation.grant, "documents:search");
  await expect(requireNativeAccessContinuationAuthority({} as never, { ...settings, accessKey: "rotated-deployment-key" }, continuation, continuation.grant, "documents:search")).rejects.toThrow("UNAVAILABLE");
  await expect(requireNativeAccessContinuationAuthority({} as never, { ...settings, authRequired: false }, continuation, continuation.grant, "documents:search")).rejects.toThrow("UNAVAILABLE");
  expect(bootstrap).toHaveBeenCalledTimes(1);
});
test("embedded configured continuation uses current membership without bootstrap reauthorization", async () => {
  const settings = testSettings({ productAccessMode: "configured", authRequired: false, accessKey: undefined, delegationSecret: undefined });
  const { app, bootstrap, currentGrant } = configuredContinuationApp(settings);
  const continuation = await (await app.request("/v1/protected")).json() as NativeAccessContinuation;
  expect(continuation.proof).toBeNull();
  await requireNativeAccessContinuationAuthority({} as never, settings, continuation, continuation.grant, "documents:search");
  currentGrant.mockResolvedValue(null);
  await expect(requireNativeAccessContinuationAuthority({} as never, settings, continuation, continuation.grant, "documents:search")).rejects.toThrow("UNAVAILABLE");
  expect(bootstrap).toHaveBeenCalledTimes(1);
});
test("public exemption and fabricated context cannot mint native continuation", async () => {
  const settings = testSettings({ productAccessMode: "configured", authRequired: true, accessKey, delegationSecret: undefined });
  const { app, context } = configuredContinuationApp(settings);
  expect(await (await app.request("/v1/config/client")).json()).toBeNull();
  expect(nativeAccessContinuationForAuthorization(accessGrantAuthorizationFromContext(structuredClone(context), structuredClone(context.workspaceGrants[0]!)))).toBeNull();
});
test("verified delegated service continuation retains expiry/current issuer and exact claims", async () => {
  const settings = testSettings({ productAccessMode: "configured", authRequired: true, accessKey, delegationSecret });
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const bearer = await signDelegatedAccessToken(delegationSecret, { accountId, workspaceId, subjectId: "service:trusted-host", principalKind: "service", permissions: ["documents:search"], exp: expiresAt });
  const app = new Hono(); app.use("*", requireAccessKey(settings));
  app.get("/v1/protected", async c => c.json(nativeAccessContinuationForAuthorization(await requireAccessGrantAuthorization(c, { db: {} as never, settings }, workspaceId, "documents:search"))));
  const continuation = await (await app.request("/v1/protected", { headers: { authorization: `Bearer ${bearer}` } })).json() as NativeAccessContinuation;
  expect(continuation.expiresAt).toBe(expiresAt); expect(continuation.kind).toBe("delegated");
  expect(JSON.stringify(continuation)).not.toContain(bearer); expect(JSON.stringify(continuation)).not.toContain(delegationSecret);
  await requireNativeAccessContinuationAuthority({} as never, settings, continuation, continuation.grant, "documents:search");
  await expect(requireNativeAccessContinuationAuthority({} as never, { ...settings, delegationSecret: "rotated-issuer" }, continuation, continuation.grant, "documents:search")).rejects.toThrow("UNAVAILABLE");
  const clock = spyOn(Date, "now").mockReturnValue((expiresAt + 1) * 1000); continuationSpies.push(clock);
  await expect(requireNativeAccessContinuationAuthority({} as never, settings, continuation, continuation.grant, "documents:search")).rejects.toThrow("UNAVAILABLE");
  clock.mockRestore();
  await expect(requireNativeAccessContinuationAuthority({} as never, settings, { ...continuation, expiresAt: 1 }, continuation.grant, "documents:search")).rejects.toThrow("UNAVAILABLE");
  await expect(requireNativeAccessContinuationAuthority({} as never, settings, continuation, { ...continuation.grant, subjectId: "different-service" }, "documents:search")).rejects.toThrow("UNAVAILABLE");
});
