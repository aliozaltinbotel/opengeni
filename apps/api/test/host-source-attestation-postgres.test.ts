// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Usage, protocol, type Model, type ModelRequest } from "@openai/agents";
import { NATIVE_HOST_SOURCE_HEADER, signDelegatedAccessToken, verifyHostSourceAttestation, type NativeHostSourceContext } from "@opengeni/contracts";
import type { AppDependencies, ManagedEmailMessage } from "@opengeni/core";
import { createDb, createManagedOrganization, createSession, initializeSessionStartAtomically, claimSessionWorkForAttempt,
  getActiveSessionHistoryItems, readModelCallSourceReceipt, type DbClient } from "@opengeni/db";
import { acquireRestrictedRuntimeTestDatabase, type RestrictedRuntimeTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { ModelRequestCaptureModel, withModelRequestCapture, bindDurableModelHistoryRows, modelSourceBindings, type ModelRequestCapture } from "../../../packages/runtime/src/model-request-capture";
import { withNativeHostSourceInvocation, nativeHostSourceRequestInit } from "../../../packages/runtime/src/host-source-attestation";
import { persistAndAuthorizeModelCallSource } from "../../worker/src/activities/agent-turn/run";
import { createApp } from "../src/app";

const origin = "http://opengeni.test", secret = "q21-native-host-source-test-delegation-secret";
const args = { purpose: "synthetic-draft" }, wireToolName = "host__prepare";
const identity = { serverId: "host", toolName: "prepare" };
const workerSubject = "worker:first-party-mcp";
let fixture: RestrictedRuntimeTestDatabase | null = null, client: DbClient;
let app: ReturnType<typeof createApp>, settings: ReturnType<typeof testSettings>;
let cookie: string, subjectId: string, accountId: string, workspaceId: string, accessToken: string, refreshToken: string, clientId: string;
let scope: { accountId: string; workspaceId: string; sessionId: string; turnId: string; attemptId: string; executionGeneration: number };
let originalProof: string, sourceKey: string, sourceCallId: string;
const sourceCalls: NativeHostSourceContext[] = [], emails: ManagedEmailMessage[] = [];
const json = { "content-type": "application/json" }, browser = { ...json, origin, "sec-fetch-site": "same-origin" };
const resource = () => `${origin}/v1/workspaces/${workspaceId}/mcp`;
const body = (name = wireToolName, value = args) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: value } });
async function invoke(proof = originalProof, name = wireToolName, value = args, bearer = accessToken) {
  const response = await app.request(`/v1/workspaces/${workspaceId}/mcp`, { method: "POST", headers: {
    ...json, accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}`, ...(proof ? { [NATIVE_HOST_SOURCE_HEADER]: proof } : {}),
  }, body: body(name, value) });
  const text = await response.text();
  let output: { error?: unknown; result?: { isError?: boolean } } = {};
  try { output = JSON.parse(text); } catch { /* A non-JSON refusal is still a refusal, never PASS. */ }
  return { status: response.status, allowed: response.status === 200 && output.result !== undefined && !output.error && output.result.isError !== true };
}

beforeAll(async () => {
  fixture = await acquireRestrictedRuntimeTestDatabase("q21-host-source", "public");
  if (!fixture) throw new Error("Q21_REAL_POSTGRES_REQUIRED");
  client = createDb(fixture.appUrl, { searchPath: fixture.schema, max: 8 });
  const roles = await fixture.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`select rolsuper, rolbypassrls from pg_roles where rolname in (${fixture.ownerRole}, 'opengeni_app')`;
  expect(roles).toHaveLength(2); expect(roles.every(role => !role.rolsuper && !role.rolbypassrls)).toBe(true);
  settings = testSettings({ databaseUrl: fixture.appUrl, productAccessMode: "managed", publicBaseUrl: origin,
    betterAuthSecret: "q21-managed-auth-test-secret-at-least-32", delegationSecret: secret, mcpOauthEnabled: true,
    mcpServers: [{ id: "host", url: "https://unused-host.invalid/mcp", cacheToolsList: false }] });
  app = createApp({ settings, db: client.db, bus: new MemoryEventBus(), workflowClient: {} as never,
    managedEmailTransport: { sender: "Native test <auth@example.test>", idempotency: { scope: "q21-email-fixture", retentionSeconds: 86400 },
      async send(message) { emails.push(message); return { status: "sent", providerMessageId: crypto.randomUUID() }; } },
    workspaceToolServers: async ({ grant }) => [{ id: "host", server: { name: "host", cacheToolsList: false, async connect() {}, async close() {}, async invalidateToolsCache() {},
      async listTools() { return [{ name: "prepare", inputSchema: { type: "object", properties: { purpose: { type: "string" } }, required: ["purpose"], additionalProperties: false }, annotations: { readOnlyHint: true } }]; },
      async callTool() { throw new Error("Q21_SOURCE_REQUIRED"); } },
      async callToolWithSource(_tool, _args, source) {
        expect(grant.subjectId).toBe(subjectId); sourceCalls.push(source); return { content: [] };
      } }],
  } satisfies AppDependencies);
  const email = `q21-${crypto.randomUUID()}@example.test`, password = "Synthetic-password-1234";
  const signup = await app.request("/v1/auth/sign-up/email", { method: "POST", headers: json, body: JSON.stringify({ name: "Q21 Human", email, password }) });
  expect(signup.status).toBe(200);
  const delivered = emails.find(message => message.kind === "email_verification" && message.to === email);
  const verification = delivered?.text.match(/https?:\/\/\S+/u)?.[0];
  if (!verification) throw new Error("Q21_NORMAL_VERIFICATION_EMAIL_REQUIRED");
  const verificationUrl = new URL(verification);
  expect([200, 302]).toContain((await app.request(verificationUrl.pathname + verificationUrl.search, { headers: browser })).status);
  const signin = await app.request("/v1/auth/sign-in/email", { method: "POST", headers: json, body: JSON.stringify({ email, password }) });
  expect(signin.status).toBe(200);
  const signed = await signin.json() as { user: { id: string } };
  subjectId = `user:${signed.user.id}`;
  const sessionCookie = signin.headers.getSetCookie().find(value => value.includes("better-auth.session_token="));
  if (!sessionCookie) throw new Error("Q21_NORMAL_BROWSER_SESSION_REQUIRED"); cookie = sessionCookie.split(";", 1)[0]!;
  const organization = await createManagedOrganization(client.db, { subjectId, subjectLabel: email, name: "Q21 synthetic organization", operationId: crypto.randomUUID() });
  accountId = organization.organization.id; workspaceId = organization.workspaceId;
  const registered = await app.request("/oauth/register", { method: "POST", headers: json, body: JSON.stringify({ client_name: "Q21 synthetic client",
    redirect_uris: ["http://127.0.0.1:47613/callback"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }) });
  expect(registered.status).toBe(201); clientId = (await registered.json() as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url"), url = new URL("/oauth/authorize", origin);
  for (const [key, value] of Object.entries({ response_type: "code", scope: "mcp:access", client_id: clientId, redirect_uri: "http://127.0.0.1:47613/callback",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: resource(), state: "q21" })) url.searchParams.set(key, value);
  const consent = await app.request(url.pathname + url.search, { headers: { cookie } });
  expect(consent.status).toBe(200);
  const requestToken = (await consent.text()).match(/ogmcp_req_[A-Za-z0-9_-]+/u)?.[0];
  if (!requestToken) throw new Error("Q21_NATIVE_CONSENT_REQUIRED");
  const approved = await app.request("/oauth/authorize", { method: "POST", headers: { ...browser, cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: requestToken, workspace_id: workspaceId, decision: "approve", access_preset: "full" }) });
  expect(approved.status).toBe(200);
  const destination = approved.headers.get("refresh") ?? await approved.text();
  const code = destination.match(/[?&]code=([^&"\s<]+)/u)?.[1];
  if (!code) throw new Error("Q21_NATIVE_AUTHORIZATION_CODE_REQUIRED");
  const exchanged = await app.request("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: decodeURIComponent(code), code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:47613/callback", resource: resource() }) });
  expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json() as { access_token: string; refresh_token: string }; accessToken = tokens.access_token; refreshToken = tokens.refresh_token;
  expect(accessToken.startsWith("ogmcp_at_")).toBe(true);
  const session = await createSession(client.db, { accountId, workspaceId, initialMessage: "Synthetic source history for a draft", resources: [], metadata: {}, model: "scripted-model",
    reasoningEffort: "low", latencyMode: "standard", sandboxBackend: "none", createdBy: { kind: "subject", subjectId }, createdByContext: {} });
  await initializeSessionStartAtomically(client.db, { accountId, workspaceId, sessionId: session.id, reasoningEffortFallback: "low", createdEventPayload: {} });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, { sessionId: session.id, workflowId: `session-${session.id}`, workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(), attemptId, trigger: { kind: "next" } });
  if (claimed.action !== "claimed") throw new Error("Q21_NORMAL_ATTEMPT_CLAIM_REQUIRED");
  scope = { accountId, workspaceId, sessionId: session.id, turnId: claimed.turn.id, attemptId, executionGeneration: claimed.turn.executionGeneration };
  sourceKey = crypto.randomUUID(); sourceCallId = `call-${crypto.randomUUID()}`;
  const rows = await getActiveSessionHistoryItems(client.db, workspaceId, session.id); expect(rows.length).toBeGreaterThan(0);
  const history = rows.map(row => ({ ...row, item: protocol.ModelItem.parse(row.item) })); bindDurableModelHistoryRows(history);
  const capture: ModelRequestCapture = Object.assign(() => {}, { beforeCall: async (request: ModelRequest) => await persistAndAuthorizeModelCallSource(client.db,
    { ...scope, sourceKey, requestIndex: 1 }, { input: request.input, sourceBindings: modelSourceBindings(request.input), purpose: "AGENT" }) });
  const model: Model = { async getResponse() { return { usage: new Usage(), output: [{ type: "function_call", name: "remote__host__prepare", callId: sourceCallId, arguments: JSON.stringify(args), status: "completed" }] }; },
    getStreamedResponse() { throw new Error("unused"); } };
  await withModelRequestCapture(capture, async () => {
    await new ModelRequestCaptureModel(model).getResponse({ input: history.map(row => row.item), modelSettings: {}, tools: [], handoffs: [], systemInstructions: "", outputType: "text", tracing: false });
    const signedRequest = await withNativeHostSourceInvocation(scope, workerSubject, subjectId, { operationId: crypto.randomUUID(), caller: { kind: "model", subjectId: workerSubject },
      sourceCallId, nativeModelSourceKey: sourceKey }, identity, wireToolName, args, async () =>
      await nativeHostSourceRequestInit(settings, resource(), { method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: body() }));
    originalProof = new Headers(signedRequest?.headers).get(NATIVE_HOST_SOURCE_HEADER)!;
    expect(originalProof.startsWith("ogd4_")).toBe(true);
  });
}, 240_000);

afterAll(async () => { await client?.close(); await fixture?.release(); }, 60_000);

test("real OAuth/current attempt/immutable native source reaches the host hook", async () => {
  const receipt = (await readModelCallSourceReceipt(client.db, { accountId, workspaceId, sessionId: scope.sessionId, sourceKey })).receipt;
  expect(receipt?.complete).toBe(true); expect(receipt?.incompleteReasons).toEqual([]);
  expect(await invoke()).toMatchObject({ status: 200, allowed: true });
  expect(sourceCalls).toHaveLength(1);
  expect(sourceCalls[0]).toMatchObject({ ...scope, nativeModelSourceKey: sourceKey, sourceCallId, receiptId: receipt!.id, receiptDigest: receipt!.digest });
});

test("real HTTP refuses missing/tampered/wrong-purpose and mismatched source, subject, generation, target and input", async () => {
  const claims = await verifyHostSourceAttestation(secret, originalProof); if (!claims) throw new Error("original proof absent");
  const before = sourceCalls.length;
  for (const proof of ["", originalProof + "tampered", await signDelegatedAccessToken(secret, { ...claims, hostSource: undefined }),
    ...await Promise.all([
      { ...claims, executionGeneration: claims.executionGeneration! + 1 },
      ...[{ nativeModelSourceKey: crypto.randomUUID() }, { connectionSubjectId: "user:foreign" }, { toolName: "other" }, { serverId: "other" }]
        .map(change => ({ ...claims, hostSource: { ...claims.hostSource, ...change } })),
    ].map(value => signDelegatedAccessToken(secret, value)))]) expect((await invoke(proof)).allowed).toBe(false);
  expect((await invoke(originalProof, wireToolName, { purpose: "different-input" })).allowed).toBe(false);
  expect((await invoke(originalProof, "host__other")).allowed).toBe(false);
  expect(sourceCalls).toHaveLength(before);
});

test("normal pause withdraws the attempt and refresh replay revokes the ordinary OAuth connection", async () => {
  const before = sourceCalls.length;
  const paused = await app.request(`/v1/workspaces/${workspaceId}/sessions/${scope.sessionId}/control`, { method: "POST", headers: { ...browser, cookie },
    body: JSON.stringify({ action: "pause", clientEventId: crypto.randomUUID() }) });
  expect(paused.status).toBe(200); expect((await invoke()).allowed).toBe(false);
  const refresh = () => app.request("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: resource() }) });
  expect((await refresh()).status).toBe(200); expect((await refresh()).status).toBe(400);
  expect((await invoke()).status).toBe(401); expect(sourceCalls).toHaveLength(before);
});
