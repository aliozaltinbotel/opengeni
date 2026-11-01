import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import type { Context } from "hono";
import { requireAccessKey } from "../src/http/auth";

// Boundary unit tests. Real Better Auth/current-session qualification is separate.
function appWithSessionVerifier(options: {
  admitted?: boolean;
  mode?: "managed" | "configured";
  failure?: Error;
} = {}) {
  const calls: string[] = [];
  const app = new Hono();
  app.onError(() => new Response(null, { status: 503 }));
  app.use("*", requireAccessKey(testSettings({
    productAccessMode: options.mode ?? "managed",
    authRequired: true,
    accessKey: "private-deployment-key",
  }), async (context: Context): Promise<boolean> => {
    calls.push(context.req.path);
    if (options.failure) throw options.failure;
    return options.admitted ?? true;
  }));
  for (const path of ["/v1/access/me", "/v1/workspaces", "/v1/organization-memberships", "/metrics", "/protected"]) {
    app.get(path, (context) => context.json({ reached: true }));
  }
  app.get("/v1/forbidden", (context) => context.json({ error: "forbidden" }, 403));
  return { app, calls };
}

const cookie = { cookie: "better-auth.session_token=signed-session" };

describe("managed browser admission at the deployment perimeter", () => {
  test("managed mode without the canonical verifier never admits cookie presence", async () => {
    const app = new Hono();
    app.use("*", requireAccessKey(testSettings({ productAccessMode: "managed", authRequired: true, accessKey: "private-deployment-key" })));
    app.get("/v1/access/me", (context) => context.json({ reached: true }));
    expect((await app.request("/v1/access/me", { headers: cookie })).status).toBe(401);
  });

  test("verified current managed sessions reach all three bootstrap reads without a deployment key", async () => {
    const { app, calls } = appWithSessionVerifier();
    for (const path of ["/v1/access/me", "/v1/workspaces", "/v1/organization-memberships"]) {
      expect((await app.request(path, { headers: cookie })).status).toBe(200);
    }
    expect(calls).toHaveLength(3);
  });

  test("cookie presence without a verified live session grants nothing", async () => {
    const { app, calls } = appWithSessionVerifier({ admitted: false });
    expect((await app.request("/v1/access/me", { headers: cookie })).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("does not attempt session authentication for anonymous requests", async () => {
    const { app, calls } = appWithSessionVerifier();
    expect((await app.request("/v1/access/me")).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("configured deployments cannot acquire a managed cookie lane", async () => {
    const { app, calls } = appWithSessionVerifier({ mode: "configured" });
    expect((await app.request("/v1/access/me", { headers: cookie })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("managed cookies cannot access deployment-only surfaces", async () => {
    const { app, calls } = appWithSessionVerifier();
    for (const path of ["/metrics", "/protected"]) {
      expect((await app.request(path, { headers: cookie })).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("invalid explicit credentials cannot fall back to an ambient cookie", async () => {
    const { app, calls } = appWithSessionVerifier();
    for (const credentials of [{ authorization: "Bearer invalid" }, { "x-opengeni-access-key": "invalid" }, { authorization: "" }, { "x-opengeni-access-key": "" }]) {
      expect((await app.request("/v1/access/me", { headers: { ...cookie, ...credentials } })).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("retains the existing static-key lane without resolving a cookie", async () => {
    const { app, calls } = appWithSessionVerifier();
    expect((await app.request("/metrics", { headers: { ...cookie, "x-opengeni-access-key": "private-deployment-key" } })).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  test("session-store unavailability cannot become positive admission", async () => {
    const { app } = appWithSessionVerifier({ failure: new Error("session store unavailable") });
    expect((await app.request("/v1/access/me", { headers: cookie })).status).toBe(503);
  });

  test("verified identity never replaces the route authorization result", async () => {
    const { app } = appWithSessionVerifier();
    expect((await app.request("/v1/forbidden", { headers: cookie })).status).toBe(403);
  });
});

// A managed cookie lane must not erase the existing discovery challenge on refusal.
test("anonymous workspace MCP refusal retains the protected-resource challenge", async () => {
  const app = new Hono();
  app.use("*", requireAccessKey(testSettings({
    productAccessMode: "managed", authRequired: true, accessKey: "private-deployment-key",
    mcpOauthEnabled: true, publicBaseUrl: "https://runtime.example.test",
  }), async () => false));
  const response = await app.request("https://runtime.example.test/v1/workspaces/11111111-1111-4111-8111-111111111111/mcp");
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer resource_metadata="https://runtime.example.test/.well-known/oauth-protected-resource/v1/workspaces/11111111-1111-4111-8111-111111111111/mcp", scope="mcp:access"',
  );
});
