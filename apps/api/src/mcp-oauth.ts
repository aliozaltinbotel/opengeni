import { createHash, randomBytes } from "node:crypto";
import {
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  MCP_OAUTH_CONSENT_TTL_SECONDS,
  MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  MCP_OAUTH_SCOPE,
  McpOAuthAuthorizationServerMetadata,
  McpOAuthClientRegistrationRequest,
  McpOAuthClientRegistrationResponse,
  McpOAuthProtectedResourceMetadata,
  McpConnectionDecision,
  McpOAuthTokenResponse,
  OrganizationAccessPolicy,
  OrganizationAccessPreset,
  organizationAccessPresetPermissions,
  type AccessContext,
  type Permission,
  type AccessGrant,
  type ToolGatewayCatalog,
  type ToolGatewayIdentity,
} from "@opengeni/contracts";
import {
  freezeMcpOAuthHostProposal,
  readMcpOAuthHostProposal,
  activeCanonicalHumanLoginBinding,
  getCanonicalHumanIdentityProjection,
  type McpOAuthHostProposal,
  type McpOAuthHostHuman,
  type McpOAuthAuthorizationRequest,
  consumeMcpOAuthAuthorizationRequest,
  createMcpOAuthAuthorizationRequest,
  deleteMcpOAuthAuthorizationRequest,
  exchangeMcpOAuthAuthorizationCode,
  getManagedAccount,
  getMcpOAuthAuthorizationRequest,
  getMcpOAuthClient,
  getWorkspace,
  listSharedWorkspacesForAccount,
  listWorkspacesForSubject,
  McpOAuthClientRegistrationRateLimitError,
  rebindMcpOAuthAuthorizationRequest,
  registerMcpOAuthClient,
  resolveLiveMcpOAuthGrant,
  resolveMcpOAuthAccessToken,
  rotateMcpOAuthRefreshToken,
  setMcpOAuthRequestOrganizationAccess,
  type McpOAuthAccess,
} from "@opengeni/db";
import {
  organizationGovernedByHost,
  hasPermission,
  requireAccessContext,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { requireCanonicalHumanRequestIdentity } from "@opengeni/core/canonical-human-identities";
import { readSessionAuthentication } from "./auth/session-authentication";
import { z } from "zod";
import type { Settings } from "@opengeni/config";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { trustedRequestSourceRateLimitKey, type RequestSourceTrust } from "./http/request-source";
import { isAgentActingAsPerson, requireFullAccessIfAgent } from "./http/acting-person";
import { requireSameOriginBrowserMutation } from "./http/browser-mutation-origin";
import {
  mcpOAuthConsentReadsOnly,
  prepareWorkspaceToolGateway,
  prepareWorkspaceToolGatewayForGrant,
  requireWorkspaceToolGatewayAuthorization,
  workspaceToolDeclaresReadOnly,
  type PreparedWorkspaceToolGateway,
} from "./workspace-tool-gateway";
import { parseRequestBody } from "./http/request-body";
import { requireNativeOrganizationMutation } from "./http/organization-governance";

const CLIENT_PREFIX = "ogmcp_client_";
const REQUEST_PREFIX = "ogmcp_req_";
const CODE_PREFIX = "ogmcp_code_";
const ACCESS_PREFIX = "ogmcp_at_";
const REFRESH_PREFIX = "ogmcp_rt_";
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const WORKSPACE_MCP_PATH = /^\/v1\/workspaces\/([0-9a-f-]{36})\/mcp(?:\/(docs|files))?$/u;

/** One organization MCP server for everyone; the sign-in chooses the organization. */
export const ORGANIZATION_MCP_PATH = "/v1/mcp";

export type McpOAuthResource = {
  resource: string;
  /** Null for the organization server. */
  workspaceId: string | null;
  kind: "all" | "docs" | "files" | "organization";
};

export type McpOAuthRouteAccess = {
  grant: AccessGrant;
  allowedToolIdentities: ToolGatewayIdentity[];
  /** The host tool-set versions recorded at consent, by server id; null when none were. */
  consentedToolSetVersions: Record<string, string> | null;
  /** The access level recorded at consent; null for a consent from before levels existed. */
  consentPreset: OrganizationAccessPreset | null;
};

export function registerMcpOAuthRoutes(app: Hono, deps: ApiRouteDeps): void {
  // RFC 8414 path-aware discovery: MCP clients (Claude among them) ask for the
  // metadata at /.well-known/oauth-authorization-server/<resource path> first
  // and give up on anything but JSON. Serve the same document at both.
  const authorizationServerMetadata = (c: Context) => {
    requireMcpOAuthEnabled(deps);
    const issuer = mcpOAuthIssuer(deps);
    c.header("cache-control", "public, max-age=300");
    return c.json(
      McpOAuthAuthorizationServerMetadata.parse({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [MCP_OAUTH_SCOPE],
        authorization_response_iss_parameter_supported: true,
      }),
    );
  };
  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
  app.get("/.well-known/oauth-authorization-server/*", authorizationServerMetadata);

  app.get("/.well-known/oauth-protected-resource/*", (c) => {
    requireMcpOAuthEnabled(deps);
    const pathname = new URL(c.req.url).pathname.replace(
      "/.well-known/oauth-protected-resource",
      "",
    );
    const resource = parseMcpOAuthResource(deps, `${mcpOAuthIssuer(deps)}${pathname}`);
    c.header("cache-control", "public, max-age=300");
    return c.json(
      McpOAuthProtectedResourceMetadata.parse({
        resource: resource.resource,
        authorization_servers: [mcpOAuthIssuer(deps)],
        scopes_supported: [MCP_OAUTH_SCOPE],
        bearer_methods_supported: ["header"],
      }),
    );
  });

  app.post("/oauth/register", async (c) => {
    requireMcpOAuthEnabled(deps);
    const parsed = McpOAuthClientRegistrationRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return oauthError(c, "invalid_client_metadata", 400);
    let redirectUris: string[];
    try {
      redirectUris = [...new Set(parsed.data.redirect_uris.map(validateRedirectUri))];
    } catch {
      return oauthError(c, "invalid_redirect_uri", 400);
    }
    let client;
    try {
      client = await registerMcpOAuthClient(deps.db, {
        clientId: opaque(CLIENT_PREFIX),
        redirectUris,
        clientName: parsed.data.client_name ?? null,
        grantTypes: parsed.data.grant_types,
        responseTypes: ["code"],
        registrationScopeHash: tokenHash(mcpOAuthRegistrationClientKey(c, deps.settings)),
      });
    } catch (error) {
      if (error instanceof McpOAuthClientRegistrationRateLimitError) {
        c.header("retry-after", "600");
        return oauthError(c, "temporarily_unavailable", 429);
      }
      throw error;
    }
    c.header("cache-control", "no-store");
    return c.json(
      McpOAuthClientRegistrationResponse.parse({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1_000),
        redirect_uris: client.redirectUris,
        ...(client.clientName ? { client_name: client.clientName } : {}),
        ...(parsed.data.application_type ? { application_type: parsed.data.application_type } : {}),
        ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
        token_endpoint_auth_method: "none",
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
      }),
      201,
    );
  });

  app.get("/oauth/authorize", async (c) => {
    requireMcpOAuthEnabled(deps);
    const query = new URL(c.req.url).searchParams;
    const client = await requireAuthorizationClient(deps, query);
    const resource = requireAuthorizationResource(deps, query);
    if (resource.kind === "organization") {
      // The person picks the organization, what the agent can do and where on
      // the web app's sign-in page, which reads and answers this request.
      const web = new URL(deps.settings.webBaseUrl ?? mcpOAuthIssuer(deps));
      let person: { context: AccessContext };
      try {
        person = await requireBrowserPerson(c, deps);
      } catch (error) {
        if (!(error instanceof HTTPException) || error.status !== 401) throw error;
        // Not signed in here yet: sign in on the web app, which returns to
        // this exact authorization request (a same-origin path only).
        const url = new URL(c.req.url);
        c.header("cache-control", "no-store");
        return c.redirect(
          `${web.origin}/connect-agent?authorize=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
          302,
        );
      }
      const accountId =
        person.context.defaultAccountId ?? person.context.accountGrants[0]?.accountId;
      if (!accountId) {
        throw new HTTPException(403, { message: "no organization is available for MCP OAuth" });
      }
      const requestToken = opaque(REQUEST_PREFIX);
      await createMcpOAuthAuthorizationRequest(deps.db, {
        requestHash: tokenHash(requestToken),
        clientId: client.clientId,
        accountId,
        workspaceId: null,
        subjectId: person.context.subjectId,
        resource: resource.resource,
        redirectUri: requireRedirectUri(client.redirectUris, query.get("redirect_uri")),
        codeChallenge: requireCodeChallenge(query),
        state: boundedState(query.get("state")),
        permissions: [],
        toolIdentities: [],
        organizationAccess: DEFAULT_ORGANIZATION_ACCESS(),
        expiresAt: expiresIn(MCP_OAUTH_CONSENT_TTL_SECONDS),
      });
      c.header("cache-control", "no-store");
      return c.redirect(
        `${web.origin}/connect-agent?request=${encodeURIComponent(requestToken)}`,
        302,
      );
    }
    const context = await requireAccessContext(c, deps);
    const workspaces = await listConsentWorkspaces(deps, context);
    if (workspaces.length === 0) {
      throw new HTTPException(403, { message: "no workspace is available for MCP OAuth" });
    }
    const selectedWorkspace =
      workspaces.find((workspace) => workspace.id === resource.workspaceId) ?? workspaces[0]!;
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      selectedWorkspace.id,
      "workspace:read",
    );
    const grant = requireWorkspaceToolGatewayAuthorization(authorization);
    const prepared = await prepareWorkspaceToolGateway(deps, authorization);
    const requestToken = opaque(REQUEST_PREFIX);
    try {
      await createMcpOAuthAuthorizationRequest(deps.db, {
        requestHash: tokenHash(requestToken),
        clientId: client.clientId,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        resource: resource.resource,
        redirectUri: requireRedirectUri(client.redirectUris, query.get("redirect_uri")),
        codeChallenge: requireCodeChallenge(query),
        state: boundedState(query.get("state")),
        permissions: grant.permissions,
        toolIdentities: mcpOAuthConsentToolIdentities(prepared.toolGatewayCatalog),
        organizationAccess: null,
        consentPreset: "full",
        toolSetVersions: consentToolSetVersions(prepared),
        expiresAt: expiresIn(MCP_OAUTH_CONSENT_TTL_SECONDS),
      });
    } finally {
      await prepared.close();
    }
    const governed = await organizationGovernedByHost(deps, grant.accountId);
    const hostProposal =
      governed && deps.mcpOAuthHostConsent
        ? await freezeMcpOAuthHostProposal(deps.db, {
            requestHash: tokenHash(requestToken),
            organizationId: grant.accountId,
            workspaceId: grant.workspaceId,
            subjectId: grant.subjectId,
            human: await requireMcpOAuthHostBrowserHuman(c, deps, grant.subjectId),
          })
        : null;
    const accounts = await consentAccountsForWorkspaces(deps, workspaces);
    c.header(
      "content-security-policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'${hostProposal ? "; connect-src 'self'" : ""}`,
    );
    c.header("cache-control", "no-store");
    return c.html(
      renderMcpOAuthConsentPage({
        clientName: client.clientName ?? "MCP client",
        requestToken,
        accounts,
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          accountId: workspace.accountId,
          name: workspace.name,
          kind: workspace.kind,
        })),
        selectedWorkspaceId: grant.workspaceId,
        permissions: grant.permissions,
        ...(hostProposal ? { hostProposal } : {}),
      }),
    );
  });

  app.post("/oauth/authorize/host-consent", async (c) => {
    requireMcpOAuthEnabled(deps);
    requireSameOriginBrowserMutation(c, deps);
    const body = z
      .object({ form: z.string().min(1).max(65_536) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HTTPException(400, { message: "Invalid consent request" });
    const form = new URLSearchParams(body.data.form);
    if (form.get("decision") !== "approve")
      throw new HTTPException(403, { message: "Explicit approval is required" });
    const requestToken = form.get("request") ?? "";
    const request = requestToken.startsWith(REQUEST_PREFIX)
      ? await getMcpOAuthAuthorizationRequest(deps.db, tokenHash(requestToken))
      : null;
    if (!request || request.workspaceId === null)
      throw new HTTPException(410, { message: "Pending workspace consent is unavailable" });
    const selectedWorkspaceId = form.get("workspace_id") || request.workspaceId;
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      selectedWorkspaceId,
      "workspace:read",
    );
    const grant = requireWorkspaceToolGatewayAuthorization(authorization);
    if (!(await organizationGovernedByHost(deps, grant.accountId)))
      throw new HTTPException(403, { message: "Host consent is unavailable" });
    const before = await readMcpOAuthHostProposal(deps.db, {
      requestHash: request.requestHash,
      organizationId: request.accountId,
    });
    const proposal = await prepareMcpOAuthHostProposal(c, deps, request, form);
    c.header("cache-control", "no-store");
    if (
      !before ||
      !matchesDisplayedMcpOAuthProposal(form, before) ||
      proposal.digest !== before.digest ||
      proposal.revision !== before.revision
    ) {
      return c.html(await renderMcpOAuthHostReview(c, deps, requestToken, proposal, form), 409);
    }
    if (!deps.mcpOAuthHostConsent)
      throw new HTTPException(403, { message: "Host consent is unavailable" });
    const credential = c.req.header(MCP_OAUTH_HOST_CREDENTIAL_HEADER);
    if (!credential)
      throw new HTTPException(401, { message: "Host consent credential is required" });
    await runMcpOAuthHostHandoff(deps.mcpOAuthHostConsent, proposal, credential);
    // A callback acknowledgement is not the HOST command's durable admission.
    const stored = await readMcpOAuthHostProposal(deps.db, {
      requestHash: proposal.requestHash,
      organizationId: proposal.organizationId,
    });
    if (
      !stored?.admitted ||
      stored.digest !== proposal.digest ||
      stored.revision !== proposal.revision ||
      stored.operationId !== proposal.operationId
    ) {
      throw new HTTPException(503, { message: "MCP_OAUTH_HOST_ADMISSION_INDETERMINATE" });
    }
    return c.json({ outcome: "admitted" });
  });

  app.post("/oauth/authorize", async (c) => {
    requireMcpOAuthEnabled(deps);
    const form = new URLSearchParams(await c.req.text());
    const requestToken = form.get("request") ?? "";
    if (!requestToken.startsWith(REQUEST_PREFIX)) {
      return oauthAuthorizeBrowserError(
        c,
        "This authorization request is missing or already used.",
      );
    }
    const request = await getMcpOAuthAuthorizationRequest(deps.db, tokenHash(requestToken));
    if (!request) {
      return oauthAuthorizeBrowserError(
        c,
        "This authorization request expired or was already approved.",
      );
    }
    // Organization sign-ins are answered on the Opengeni page they opened.
    if (request.workspaceId === null) {
      return oauthAuthorizeBrowserError(c, "Answer this sign-in on the Opengeni page it opened.");
    }
    const requestWorkspaceId = request.workspaceId;
    if (form.get("decision") !== "approve") {
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        requestWorkspaceId,
        "workspace:read",
      );
      if (requireWorkspaceToolGatewayAuthorization(authorization).subjectId !== request.subjectId) {
        throw new HTTPException(403, { message: "OAuth consent authority changed" });
      }
      await deleteMcpOAuthAuthorizationRequest(deps.db, request.requestHash);
      return completeAuthorizationRedirect(
        c,
        authorizationRedirect(request.redirectUri, {
          error: "access_denied",
          iss: mcpOAuthIssuer(deps),
          ...(request.state ? { state: request.state } : {}),
        }),
      );
    }
    const selectedWorkspaceId = form.get("workspace_id") || requestWorkspaceId;
    if (!isWorkspaceId(selectedWorkspaceId)) {
      return oauthAuthorizeBrowserError(c, "Choose a workspace before authorizing this client.");
    }
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      selectedWorkspaceId,
      "workspace:read",
    );
    const grant = requireWorkspaceToolGatewayAuthorization(authorization);
    if (grant.subjectId !== request.subjectId) {
      throw new HTTPException(403, {
        message: "OAuth consent authority changed",
      });
    }
    const consent = workspaceConsentAccess(form, grant.permissions);
    if (!consent) {
      return oauthAuthorizeBrowserError(
        c,
        "Choose an access level before authorizing this client.",
      );
    }
    if (deps.mcpOAuthHostConsent && (await organizationGovernedByHost(deps, grant.accountId))) {
      if (
        c.req.header("origin") !== new URL(deps.settings.publicBaseUrl!).origin ||
        c.req.header("sec-fetch-site") !== "same-origin"
      )
        throw new HTTPException(403, { message: "Same-origin browser approval is required" });
      const proposal = await prepareMcpOAuthHostProposal(c, deps, request, form);
      if (!matchesDisplayedMcpOAuthProposal(form, proposal))
        return c.html(
          await renderMcpOAuthHostReview(c, deps, form.get("request") ?? "", proposal, form),
          409,
        );
      const browser = await requireCanonicalHumanRequestIdentity(c, {
        db: deps.db,
        managedAuth: deps.managedAuth,
        managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
        managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
      });
      const code = opaque(CODE_PREFIX);
      const consumed = await consumeMcpOAuthAuthorizationRequest(deps.db, {
        requestHash: request.requestHash,
        subjectId: grant.subjectId,
        codeHash: tokenHash(code),
        codeExpiresAt: expiresIn(MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS),
        hostAdmission: proposal,
        hostBrowserAuthUserId: browser.authUserId,
      });
      if (!consumed)
        throw new HTTPException(403, { message: "Matching HOST consent admission is required" });
      return completeAuthorizationRedirect(
        c,
        authorizationRedirect(consumed.redirectUri, {
          code,
          iss: mcpOAuthIssuer(deps),
          ...(consumed.state ? { state: consumed.state } : {}),
        }),
      );
    }
    // Refused before the request is rebound or a code is issued.
    await requireNativeOrganizationMutation(deps, grant.accountId, "mcp_connection.create");
    if (
      grant.workspaceId !== request.workspaceId ||
      grant.accountId !== request.accountId ||
      consent.preset !== "full" ||
      request.consentPreset !== "full"
    ) {
      // A narrower level freezes what the narrowed grant would list: the
      // same preparation the connection's tokens get.
      const prepared =
        consent.preset === "full"
          ? await prepareWorkspaceToolGateway(deps, authorization)
          : await prepareWorkspaceToolGatewayForGrant(deps, {
              ...grant,
              permissions: consent.permissions,
            });
      try {
        const rebound = await rebindMcpOAuthAuthorizationRequest(deps.db, {
          requestHash: request.requestHash,
          subjectId: grant.subjectId,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          permissions: consent.permissions,
          toolIdentities: mcpOAuthConsentToolIdentities(prepared.toolGatewayCatalog, consent),
          consentPreset: consent.preset,
          toolSetVersions: consentToolSetVersions(prepared),
        });
        if (!rebound) {
          return oauthAuthorizeBrowserError(
            c,
            "This authorization request expired or was already approved.",
          );
        }
      } finally {
        await prepared.close();
      }
    }
    const code = opaque(CODE_PREFIX);
    const consumed = await consumeMcpOAuthAuthorizationRequest(deps.db, {
      requestHash: request.requestHash,
      subjectId: grant.subjectId,
      codeHash: tokenHash(code),
      codeExpiresAt: expiresIn(MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS),
    });
    if (!consumed) {
      return oauthAuthorizeBrowserError(
        c,
        "This authorization request expired or was already approved.",
      );
    }
    return completeAuthorizationRedirect(
      c,
      authorizationRedirect(consumed.redirectUri, {
        code,
        iss: mcpOAuthIssuer(deps),
        ...(consumed.state ? { state: consumed.state } : {}),
      }),
    );
  });

  // The web sign-in page for the organization server reads the pending request…
  app.get("/v1/mcp-connections/requests/:request", async (c) => {
    requireMcpOAuthEnabled(deps);
    const person = await requireBrowserPerson(c, deps);
    const request = await requirePendingOrganizationRequest(deps, c.req.param("request"), person);
    const client = await getMcpOAuthClient(deps.db, request.clientId);
    const organizations = await consentOrganizations(deps, person.context);
    c.header("cache-control", "no-store");
    return c.json({
      client: {
        name: client?.clientName ?? "MCP client",
        host: redirectHost(request.redirectUri),
      },
      person: { name: person.context.subjectLabel ?? null },
      organizations,
      defaultOrganizationId: organizations.some((each) => each.id === request.accountId)
        ? request.accountId
        : (organizations[0]?.id ?? null),
    });
  });

  // …and answers it. Approving returns the agent's redirect with a code.
  app.post("/v1/mcp-connections/requests/:request", async (c) => {
    requireMcpOAuthEnabled(deps);
    requireSameOriginBrowserMutation(c, deps);
    const person = await requireBrowserPerson(c, deps);
    const request = await requirePendingOrganizationRequest(deps, c.req.param("request"), person);
    const parsed = parseRequestBody(McpConnectionDecision, await c.req.json().catch(() => null), {
      status: 400,
      message: "invalid sign-in decision",
    });
    const decision = parsed;
    if (decision.decision === "deny") {
      await deleteMcpOAuthAuthorizationRequest(deps.db, request.requestHash);
      return c.json({
        redirectTo: authorizationRedirect(request.redirectUri, {
          error: "access_denied",
          iss: mcpOAuthIssuer(deps),
          ...(request.state ? { state: request.state } : {}),
        }),
      });
    }
    const organizations = await consentOrganizations(deps, person.context);
    const organization = organizations.find((each) => each.id === decision.organizationId);
    if (!organization) throw new HTTPException(403, { message: "organization is not available" });
    // Refused before the request is bound or a code is issued.
    await requireNativeOrganizationMutation(deps, organization.id, "mcp_connection.create");
    const access = decision.access;
    if (access.workspaceScope.kind === "selected") {
      const reachable = new Set(organization.workspaces.map((workspace) => workspace.id));
      if (access.workspaceScope.workspaceIds.some((id) => !reachable.has(id))) {
        throw new HTTPException(403, { message: "a selected workspace is not available" });
      }
    }
    const bound = await setMcpOAuthRequestOrganizationAccess(deps.db, {
      requestHash: request.requestHash,
      subjectId: person.context.subjectId,
      accountId: organization.id,
      organizationAccess: access,
    });
    const code = opaque(CODE_PREFIX);
    const consumed = bound
      ? await consumeMcpOAuthAuthorizationRequest(deps.db, {
          requestHash: request.requestHash,
          subjectId: person.context.subjectId,
          codeHash: tokenHash(code),
          codeExpiresAt: expiresIn(MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS),
        })
      : null;
    if (!consumed) {
      throw new HTTPException(410, { message: "This sign-in expired or was already answered." });
    }
    return c.json({
      redirectTo: authorizationRedirect(consumed.redirectUri, {
        code,
        iss: mcpOAuthIssuer(deps),
        ...(consumed.state ? { state: consumed.state } : {}),
      }),
    });
  });

  app.post("/oauth/token", async (c) => {
    requireMcpOAuthEnabled(deps);
    const form = new URLSearchParams(await c.req.text());
    const grantType = form.get("grant_type");
    const clientId = form.get("client_id") ?? "";
    const resource = form.get("resource");
    const client = await getMcpOAuthClient(deps.db, clientId);
    if (!client) return oauthError(c, "invalid_client", 401);
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return oauthError(c, "unsupported_grant_type", 400);
    }
    if (!client.grantTypes.includes(grantType)) {
      return oauthError(c, "unauthorized_client", 400);
    }
    const requestedScope = form.get("scope");
    if (requestedScope !== null && requestedScope !== MCP_OAUTH_SCOPE) {
      return oauthError(c, "invalid_scope", 400);
    }
    if (!resource) return oauthError(c, "invalid_target", 400);
    let parsedResource: McpOAuthResource;
    try {
      parsedResource = parseMcpOAuthResource(deps, resource);
    } catch {
      return oauthError(c, "invalid_target", 400);
    }
    const accessToken = opaque(ACCESS_PREFIX);
    const refreshToken = client.grantTypes.includes("refresh_token")
      ? opaque(REFRESH_PREFIX)
      : null;
    const tokenInput = {
      clientId,
      resource: parsedResource.resource,
      accessTokenHash: tokenHash(accessToken),
      accessExpiresAt: expiresIn(MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS),
      refreshExpiresAt: expiresIn(MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS),
    };
    const access =
      grantType === "authorization_code"
        ? await exchangeAuthorizationCode(deps, client.redirectUris, form, {
            ...tokenInput,
            refreshTokenHash: refreshToken ? tokenHash(refreshToken) : null,
          })
        : refreshToken
          ? await rotateRefreshToken(deps, form, {
              ...tokenInput,
              nextRefreshTokenHash: tokenHash(refreshToken),
            })
          : null;
    if (!access) return oauthError(c, "invalid_grant", 400);
    c.header("cache-control", "no-store");
    c.header("pragma", "no-cache");
    return c.json(
      McpOAuthTokenResponse.parse({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        scope: MCP_OAUTH_SCOPE,
      }),
    );
  });
}

export async function resolveMcpOAuthRouteAccess(
  deps: ApiRouteDeps,
  request: Request,
  workspaceId: string,
): Promise<McpOAuthRouteAccess | null> {
  const token = mcpOAuthBearerToken(request);
  if (!token) return null;
  requireMcpOAuthEnabled(deps);
  const access = await resolveMcpOAuthAccessToken(deps.db, tokenHash(token));
  const requestResource = parseMcpOAuthResource(
    deps,
    `${mcpOAuthIssuer(deps)}${new URL(request.url).pathname}`,
  );
  // The client URL is the resource indicator. Consent may bind a different
  // workspace than the path UUID; the token grant is the authorized workspace.
  if (
    !access ||
    requestResource.workspaceId !== workspaceId ||
    access.resource !== requestResource.resource
  ) {
    throw new HTTPException(401, { message: "invalid MCP OAuth access token" });
  }
  const grant = await resolveLiveMcpOAuthGrant(deps.db, access);
  if (!grant)
    throw new HTTPException(401, {
      message: "MCP OAuth authority is no longer active",
    });
  const allowedToolIdentities = access.toolIdentities.filter((identity) =>
    requestResource.kind === "all" ? true : identity.serverId === requestResource.kind,
  );
  return {
    grant,
    allowedToolIdentities,
    consentedToolSetVersions: access.toolSetVersions ?? null,
    consentPreset: access.consentPreset ?? null,
  };
}

export function mcpOAuthBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer +(\S+)$/iu)?.[1];
  if (!token) return null;
  return token.startsWith(ACCESS_PREFIX) ? token : null;
}

export function isMcpOAuthResourcePath(pathname: string): boolean {
  return WORKSPACE_MCP_PATH.test(pathname) || pathname === ORGANIZATION_MCP_PATH;
}

/**
 * The tool identities a consent freezes. Under a read-only level (Read only,
 * or Custom without any permission that changes something) only tools that
 * declare `readOnlyHint: true` (and are not destructive) are kept, so a tool
 * that says nothing about its effects is left out. The connection's tool
 * gateway applies the same rule again on every request
 * (`prepareMcpOAuthWorkspaceToolGateway`).
 */
export function mcpOAuthConsentToolIdentities(
  catalog: ToolGatewayCatalog,
  consent?: WorkspaceConsentAccess,
): ToolGatewayIdentity[] {
  const readOnly = consent !== undefined && mcpOAuthConsentReadsOnly(consent);
  return catalog.entries
    .filter((entry) => !readOnly || workspaceToolDeclaresReadOnly(entry))
    .map((entry) => entry.identity);
}

/** The host tool-set versions a consent records: each used host server's, or null. */
function consentToolSetVersions(
  prepared: Pick<PreparedWorkspaceToolGateway, "hostToolSetVersions">,
): Record<string, string> | null {
  const versions = prepared.hostToolSetVersions;
  return versions && Object.keys(versions).length > 0 ? { ...versions } : null;
}

/** A workspace consent's chosen access level and the grant permissions it leaves. */
export type WorkspaceConsentAccess = {
  preset: OrganizationAccessPreset;
  permissions: Permission[];
};

/**
 * The access level a workspace consent form chose (`access_preset`: `full`,
 * `read_only` or `custom` with `permission` values; absent means `full`, the
 * behaviour before the choice existed), applied to the person's live
 * permissions in the workspace. The result never holds a permission the person
 * lacks, and always keeps `workspace:read`, which the connection needs at all.
 * Null for an unknown level.
 */
export function workspaceConsentAccess(
  form: URLSearchParams,
  live: readonly Permission[],
): WorkspaceConsentAccess | null {
  const preset = OrganizationAccessPreset.safeParse(form.get("access_preset") ?? "full");
  if (!preset.success) return null;
  const chosen =
    preset.data === "full"
      ? null
      : new Set<string>(
          preset.data === "read_only"
            ? organizationAccessPresetPermissions("read_only")
            : form.getAll("permission"),
        );
  const permissions = live.filter(
    (permission) => chosen === null || permission === "workspace:read" || chosen.has(permission),
  );
  return { preset: preset.data, permissions };
}

export function isMcpOAuthPublicProtocolPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname.startsWith("/.well-known/oauth-authorization-server/") ||
    pathname.startsWith("/.well-known/oauth-protected-resource/") ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/authorize" ||
    pathname === "/oauth/authorize/host-consent" ||
    pathname === "/oauth/token"
  );
}

export function mcpOAuthAuthenticateHeader(deps: McpOAuthIssuerDeps, pathname: string): string {
  return `Bearer resource_metadata="${mcpOAuthIssuer(deps)}/.well-known/oauth-protected-resource${pathname}", scope="${MCP_OAUTH_SCOPE}"`;
}

/**
 * The challenge the deployment perimeter adds to its own 401 on an exact
 * workspace MCP resource, so a client refused before the route is reached
 * still discovers the protected-resource metadata (RFC 9728). It is the
 * route's own challenge: the issuer is the configured public base URL and the
 * path is the request's workspace MCP path; no request header contributes.
 * Null when MCP OAuth is off or has no public base URL, or for any other path.
 */
export function workspaceMcpPerimeterChallenge(
  settings: Pick<Settings, "mcpOauthEnabled" | "publicBaseUrl">,
  pathname: string,
): string | null {
  if (!settings.mcpOauthEnabled || !settings.publicBaseUrl) return null;
  if (!WORKSPACE_MCP_PATH.test(pathname)) return null;
  return mcpOAuthAuthenticateHeader({ settings }, pathname);
}

function requireMcpOAuthEnabled(deps: ApiRouteDeps): void {
  if (!deps.settings.mcpOauthEnabled) throw new HTTPException(404, { message: "not found" });
}

type McpOAuthIssuerDeps = { settings: Pick<Settings, "publicBaseUrl"> };

function mcpOAuthIssuer(deps: McpOAuthIssuerDeps): string {
  if (!deps.settings.publicBaseUrl) throw new Error("MCP OAuth public base URL is not configured");
  return new URL(deps.settings.publicBaseUrl).origin;
}

function parseMcpOAuthResource(deps: ApiRouteDeps, value: string): McpOAuthResource {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HTTPException(400, { message: "invalid OAuth resource" });
  }
  const issuer = mcpOAuthIssuer(deps);
  if (
    url.pathname === ORGANIZATION_MCP_PATH &&
    url.origin === issuer &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  ) {
    return {
      resource: `${issuer}${ORGANIZATION_MCP_PATH}`,
      workspaceId: null,
      kind: "organization",
    };
  }
  const match = url.pathname.match(WORKSPACE_MCP_PATH);
  if (url.origin !== issuer || url.username || url.password || url.search || url.hash || !match) {
    throw new HTTPException(400, { message: "invalid OAuth resource" });
  }
  return {
    resource: `${issuer}${url.pathname}`,
    workspaceId: match[1]!,
    kind: match[2] === "docs" ? "docs" : match[2] === "files" ? "files" : "all",
  };
}

async function requireAuthorizationClient(deps: ApiRouteDeps, query: URLSearchParams) {
  if (query.get("response_type") !== "code" || query.get("scope") !== MCP_OAUTH_SCOPE) {
    throw new HTTPException(400, {
      message: "unsupported OAuth authorization request",
    });
  }
  const clientId = query.get("client_id") ?? "";
  const client = await getMcpOAuthClient(deps.db, clientId);
  if (!client || !client.grantTypes.includes("authorization_code")) {
    throw new HTTPException(400, { message: "invalid OAuth client" });
  }
  requireRedirectUri(client.redirectUris, query.get("redirect_uri"));
  requireCodeChallenge(query);
  return client;
}

function requireAuthorizationResource(
  deps: ApiRouteDeps,
  query: URLSearchParams,
): McpOAuthResource {
  const resources = query.getAll("resource");
  if (resources.length !== 1)
    throw new HTTPException(400, { message: "one OAuth resource is required" });
  return parseMcpOAuthResource(deps, resources[0]!);
}

function requireRedirectUri(registered: string[], value: string | null): string {
  if (!value || !registered.includes(value)) {
    throw new HTTPException(400, {
      message: "OAuth redirect_uri is not registered",
    });
  }
  return value;
}

function requireCodeChallenge(query: URLSearchParams): string {
  const challenge = query.get("code_challenge") ?? "";
  if (query.get("code_challenge_method") !== "S256" || !PKCE_CHALLENGE.test(challenge)) {
    throw new HTTPException(400, { message: "PKCE S256 is required" });
  }
  return challenge;
}

async function exchangeAuthorizationCode(
  deps: ApiRouteDeps,
  redirectUris: string[],
  form: URLSearchParams,
  input: {
    clientId: string;
    resource: string;
    accessTokenHash: string;
    refreshTokenHash: string | null;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
  },
) {
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  if (!code.startsWith(CODE_PREFIX) || !PKCE_VERIFIER.test(verifier)) return null;
  const redirectUri = form.get("redirect_uri");
  if (!redirectUri || !redirectUris.includes(redirectUri)) return null;
  for (const candidate of mcpOAuthRedirectUriCandidates(redirectUris, redirectUri)) {
    const access = await exchangeMcpOAuthAuthorizationCode(deps.db, {
      codeHash: tokenHash(code),
      clientId: input.clientId,
      redirectUri: candidate,
      resource: input.resource,
      codeChallenge: pkceChallenge(verifier),
      accessTokenHash: input.accessTokenHash,
      refreshTokenHash: input.refreshTokenHash,
      accessExpiresAt: input.accessExpiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
    });
    if (access) return access;
  }
  return null;
}

export function mcpOAuthRedirectUriCandidates(registered: string[], requested: string): string[] {
  if (!registered.includes(requested)) return [];
  return [requested, ...registered.filter((uri) => uri !== requested)];
}

async function rotateRefreshToken(
  deps: ApiRouteDeps,
  form: URLSearchParams,
  input: {
    clientId: string;
    resource: string;
    accessTokenHash: string;
    nextRefreshTokenHash: string;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
  },
) {
  const refreshToken = form.get("refresh_token") ?? "";
  if (!refreshToken.startsWith(REFRESH_PREFIX)) return null;
  return await rotateMcpOAuthRefreshToken(deps.db, {
    refreshTokenHash: tokenHash(refreshToken),
    ...input,
  });
}

const BLOCKED_REDIRECT_PROTOCOLS = new Set([
  "javascript:",
  "data:",
  "file:",
  "about:",
  "blob:",
  "vbscript:",
]);

function isNativeAppRedirect(url: URL): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:$/u.test(url.protocol) &&
    !BLOCKED_REDIRECT_PROTOCOLS.has(url.protocol) &&
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    Boolean(url.hostname) &&
    url.pathname.startsWith("/") &&
    url.pathname !== "/"
  );
}

function validateRedirectUri(value: string): string {
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !loopback && !isNativeAppRedirect(url))
  ) {
    throw new HTTPException(400, {
      message: "invalid public OAuth redirect URI",
    });
  }
  return url.toString();
}

function boundedState(value: string | null): string | null {
  if (value === null) return null;
  if (!value || new TextEncoder().encode(value).byteLength > 1_024) {
    throw new HTTPException(400, { message: "invalid OAuth state" });
  }
  return value;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function opaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mcpOAuthRegistrationClientKey(c: Context, trust: RequestSourceTrust): string {
  return `mcp-oauth-registration:${trustedRequestSourceRateLimitKey(c, trust)}`;
}

function expiresIn(seconds: number): Date {
  return new Date(Date.now() + seconds * 1_000);
}

function authorizationRedirect(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function completeAuthorizationRedirect(c: Context, redirectTo: string) {
  // Consent posts under CSP form-action 'self'. A 302 to the client's
  // registered redirect_uri (loopback HTTP or a custom scheme) is blocked,
  // so the waiter never receives the code. Return 200 HTML that navigates
  // to the exact requested URI from script and Refresh.
  c.header("cache-control", "no-store");
  c.header(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  c.header("refresh", `0;url=${redirectTo}`);
  return c.html(renderMcpOAuthContinuePage(redirectTo));
}

function oauthAuthorizeBrowserError(c: Context, message: string) {
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
  c.header(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  return c.html(renderMcpOAuthExpiredPage(message), 400);
}

export type McpOAuthConsentAccount = {
  id: string;
  name: string;
};

export type McpOAuthConsentWorkspace = {
  id: string;
  accountId: string;
  name: string;
  kind: "personal" | "shared";
};

export function renderMcpOAuthConsentPage(input: {
  clientName: string;
  requestToken: string;
  accounts: McpOAuthConsentAccount[];
  workspaces: McpOAuthConsentWorkspace[];
  selectedWorkspaceId: string;
  /** The person's permissions in the selected workspace: the Custom level's choices. */
  permissions?: readonly string[];
  hostProposal?: McpOAuthHostProposal;
  consentPreset?: string;
  selectedPermissions?: readonly string[];
  reviewRequired?: boolean;
}): string {
  const selectedWorkspace =
    input.workspaces.find((workspace) => workspace.id === input.selectedWorkspaceId) ??
    input.workspaces[0];
  if (!selectedWorkspace) {
    throw new Error("MCP OAuth consent requires at least one workspace");
  }
  const selectedAccountId = selectedWorkspace.accountId;
  const accountOptions = input.accounts
    .map(
      (account) =>
        `<option value="${escapeHtml(account.id)}"${account.id === selectedAccountId ? " selected" : ""}>${escapeHtml(account.name)}</option>`,
    )
    .join("");
  const workspaceOptions = input.workspaces
    .filter((workspace) => workspace.accountId === selectedAccountId)
    .map(
      (workspace) =>
        `<option value="${escapeHtml(workspace.id)}"${workspace.id === selectedWorkspace.id ? " selected" : ""}>${escapeHtml(consentWorkspaceLabel(workspace))}</option>`,
    )
    .join("");
  const workspacePayload = input.workspaces.map((workspace) => ({
    id: workspace.id,
    accountId: workspace.accountId,
    label: consentWorkspaceLabel(workspace),
  }));
  const customPermissions =
    input.permissions && input.permissions.length > 0
      ? `<details class="custom"><summary>Custom permissions</summary>${input.permissions
          .filter((permission) => permission !== "workspace:read")
          .map(
            (permission) =>
              `<label><input type="checkbox" name="permission" value="${escapeHtml(permission)}"${input.selectedPermissions?.includes(permission) ? " checked" : ""}> <span>${escapeHtml(permission)}</span></label>`,
          )
          .join("")}</details>`
      : "";
  const accessLabel =
    input.hostProposal?.material.consentPreset === "read_only"
      ? "Read only"
      : input.hostProposal?.material.consentPreset === "custom"
        ? "Custom"
        : "Full";
  const hostFields = input.hostProposal
    ? `<input type="hidden" name="host_revision" value="${input.hostProposal.revision}"><input type="hidden" name="host_digest" value="${escapeHtml(input.hostProposal.digest)}">${input.reviewRequired ? '<p role="alert">Access changed. Review the permissions and tools below, then authorize again.</p>' : ""}<p class="note">Current access: <strong>${accessLabel}</strong>. ${input.hostProposal.material.permissions.length} permissions; ${input.hostProposal.material.toolIdentities.length} tools.</p><details${input.reviewRequired ? " open" : ""} style="overflow-wrap:anywhere"><summary>Permissions and tools</summary><p>The selected access and checked custom permissions apply to these tools.</p>${input.hostProposal.material.toolIdentities.length ? `<ul>${input.hostProposal.material.toolIdentities.map((tool) => `<li>${escapeHtml(tool.serverId)}: ${escapeHtml(tool.toolName)}</li>`).join("")}</ul>` : "<p>No tools are currently available for this access.</p>"}</details>`
    : "";
  const body = `<p class="lede"><strong>${escapeHtml(input.clientName)}</strong> wants MCP access to the organization and workspace you choose.</p>
<form method="post" action="/oauth/authorize" onsubmit="var submitter=event.submitter;if(submitter&&submitter.name){var input=document.createElement('input');input.type='hidden';input.name=submitter.name;input.value=submitter.value;this.appendChild(input)}this.querySelectorAll('button').forEach(function(button){button.disabled=true})">
<input type="hidden" name="request" value="${escapeHtml(input.requestToken)}">${hostFields}
<label class="field"><span>Organization</span><select id="organization" name="organization" autocomplete="off">${accountOptions}</select></label>
<label class="field"><span>Workspace</span><select id="workspace_id" name="workspace_id" autocomplete="off">${workspaceOptions}</select></label>
<fieldset class="field levels"><legend>Access</legend>
<label><input type="radio" name="access_preset" value="full"${!input.consentPreset || input.consentPreset === "full" ? " checked" : ""}> <span><strong>Full</strong> Everything you can do in this workspace.</span></label>
<label><input type="radio" name="access_preset" value="read_only"${input.consentPreset === "read_only" ? " checked" : ""}> <span><strong>Read only</strong> Only tools that declare they only read.</span></label>
<label><input type="radio" name="access_preset" value="custom"${input.consentPreset === "custom" ? " checked" : ""}> <span><strong>Custom</strong> Only the permissions you pick below.</span></label>
${customPermissions}
</fieldset>
<p class="note">The grant is limited to tools available in the workspace you authorize. Opengeni rechecks live authority on every request.</p>
<div class="actions"><button class="approve" name="decision" value="approve">Authorize</button><button class="deny" name="decision" value="deny">Deny</button></div>
</form>
<script type="application/json" id="mcp-oauth-workspaces">${jsonForScript(workspacePayload)}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("mcp-oauth-workspaces").textContent);
  var account = document.getElementById("organization");
  var workspace = document.getElementById("workspace_id");
  function sync() {
    var selected = workspace.value;
    var items = data.filter(function (item) { return item.accountId === account.value; });
    workspace.replaceChildren();
    items.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      workspace.appendChild(option);
    });
    if (items.some(function (item) { return item.id === selected; })) workspace.value = selected;
  }
  account.addEventListener("change", sync);${
    input.hostProposal
      ? `
  var form = workspace.form;
  form.onsubmit = async function(event) {
    var submitter = event.submitter;
    if (!submitter || submitter.value !== "approve") return;
    event.preventDefault();
    form.querySelectorAll("button").forEach(function(button) { button.disabled = true; });
    try {
      var fields = new URLSearchParams(new FormData(form));
      fields.set("decision", "approve");
      var minted = await fetch("/v1/auth/host-token?workspace=" + encodeURIComponent(workspace.value), { credentials: "same-origin", cache: "no-store" });
      if (!minted.ok) throw new Error("Sign in again before authorizing.");
      var credential = await minted.json();
      var response = await fetch("/oauth/authorize/host-consent", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "${MCP_OAUTH_HOST_CREDENTIAL_HEADER}": credential.token }, body: JSON.stringify({ form: fields.toString() }) });
      credential = null;
      if (response.status === 409) { var page = await response.text(); document.open(); document.write(page); document.close(); return; }
      if (!response.ok) throw new Error("Authorization could not be confirmed. Review and try again.");
      var decision = document.createElement("input"); decision.type = "hidden"; decision.name = "decision"; decision.value = "approve"; form.appendChild(decision);
      HTMLFormElement.prototype.submit.call(form);
    } catch (_) {
      var message = document.createElement("p"); message.setAttribute("role", "alert"); message.textContent = "Authorization could not be confirmed. Review and try again."; form.prepend(message);
      form.querySelectorAll("button").forEach(function(button) { button.disabled = false; });
    }
  };`
      : ""
  }
})();
</script>`;
  return oauthDocument({
    title: "Authorize MCP access",
    heading: "Authorize this client",
    body,
  });
}

export function renderMcpOAuthContinuePage(redirectTo: string): string {
  return oauthDocument({
    title: "Returning to the app",
    heading: "Returning to the app",
    head: `<meta http-equiv="refresh" content="0;url=${escapeHtml(redirectTo)}">`,
    body: `<p class="lede">Authorization succeeded. You can close this window.</p><script>(function (url) { try { location.replace(url); } catch (error) {} try { location.href = url; } catch (error) {} var frame = document.createElement("iframe"); frame.src = url; frame.style.display = "none"; document.body.appendChild(frame); })(${JSON.stringify(redirectTo)});</script>`,
  });
}

export function renderMcpOAuthExpiredPage(message: string): string {
  return oauthDocument({
    title: "Authorization expired",
    heading: "Authorization expired",
    body: `<p class="lede">${escapeHtml(message)}</p><p class="note">Close this window and start authorization again from the client.</p>`,
  });
}

async function listConsentWorkspaces(deps: ApiRouteDeps, context: AccessContext) {
  const readableWorkspaceIds = [
    ...new Set(
      context.workspaceGrants
        .filter((grant) => hasPermission(grant.permissions, "workspace:read"))
        .map((grant) => grant.workspaceId),
    ),
  ];
  const readableAccountIds = context.accountGrants
    .filter((grant) => hasPermission(grant.permissions, "workspace:read"))
    .map((grant) => grant.accountId);
  const [fromGrants, memberships, shared] = await Promise.all([
    Promise.all(readableWorkspaceIds.map((workspaceId) => getWorkspace(deps.db, workspaceId))),
    listWorkspacesForSubject(deps.db, context.subjectId),
    Promise.all(
      readableAccountIds.map((accountId) => listSharedWorkspacesForAccount(deps.db, accountId)),
    ),
  ]);
  const byId = new Map<string, NonNullable<(typeof fromGrants)[number]>>();
  for (const workspace of [...fromGrants, ...memberships, ...shared.flat()]) {
    if (workspace) byId.set(workspace.id, workspace);
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function consentAccountsForWorkspaces(
  deps: ApiRouteDeps,
  workspaces: Array<{ accountId: string }>,
): Promise<McpOAuthConsentAccount[]> {
  const accountIds = [...new Set(workspaces.map((workspace) => workspace.accountId))];
  return (
    await Promise.all(
      accountIds.map(async (accountId) => {
        const account = await getManagedAccount(deps.db, accountId);
        return { id: accountId, name: account?.name.trim() || "Organization" };
      }),
    )
  ).sort((left, right) => left.name.localeCompare(right.name));
}

function consentWorkspaceLabel(workspace: McpOAuthConsentWorkspace): string {
  const name = workspace.name.trim() || "Workspace";
  return workspace.kind === "personal" ? `${name} (Personal)` : name;
}

function isWorkspaceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function oauthDocument(input: {
  title: string;
  heading: string;
  body: string;
  head?: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title>${input.head ?? ""}<style>${OAUTH_PAGE_CSS}</style></head><body><main><p class="mark">Opengeni</p><h1>${escapeHtml(input.heading)}</h1>${input.body}</main></body></html>`;
}

const OAUTH_PAGE_CSS =
  'html,body{margin:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f4f4f5;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}main{width:min(100%,28rem);background:#fff;border:1px solid #e4e4e7;border-radius:20px;padding:24px}h1{margin:8px 0 0;font-size:22px;line-height:1.3;font-weight:650}p{margin:12px 0 0}strong{font-weight:600}.mark{margin:0;font-size:12px;font-weight:600;color:#71717a}.lede,.note{color:#52525b}.field{display:flex;flex-direction:column;gap:6px;margin-top:16px;font-size:13px;color:#71717a}select{width:100%;border:1px solid #e4e4e7;border-radius:10px;background:#f4f4f5;color:#18181b;padding:10px 12px;font:inherit}.actions{display:flex;gap:12px;margin-top:20px}button{flex:1;min-height:40px;border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer}.approve{background:#18181b;color:#fff}.deny{background:#fff;color:#18181b;border:1px solid #e4e4e7}button:disabled{opacity:0.6;cursor:wait}fieldset{border:0;padding:0;margin:16px 0 0}legend{padding:0;margin-bottom:6px}.levels label{display:flex;gap:8px;align-items:flex-start;color:#18181b;font-size:14px;margin-top:6px}.levels strong{margin-right:4px}.custom{margin-top:8px}.custom summary{cursor:pointer;color:#52525b}.custom label{font-size:13px}@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:#18181b;border-color:#3f3f46}h1{color:#fafafa}.mark{color:#a1a1aa}.lede,.note{color:#a1a1aa}select{background:#27272a;border-color:#3f3f46;color:#fafafa}.approve{background:#fafafa;color:#18181b}.deny{background:#27272a;color:#fafafa;border-color:#3f3f46}.levels label{color:#fafafa}.custom summary{color:#a1a1aa}}';

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function oauthError(c: Context, error: string, status: 400 | 401 | 429) {
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
  return c.json({ error }, status);
}

/* ----------------------------------------------------------------------------
   Organization server sign-in: a person picks the organization, what the agent
   can do and where. The agent then acts as that person, never beyond their
   live access, on every request.
   -------------------------------------------------------------------------- */

/** Read only, every workspace: the least surprising default until the person chooses. */
function DEFAULT_ORGANIZATION_ACCESS(): OrganizationAccessPolicy {
  return {
    preset: "read_only",
    permissions: organizationAccessPresetPermissions("read_only"),
    workspaceScope: { kind: "all" },
  };
}

/**
 * A person signed in to Opengeni in this browser, or an agent with their full
 * access answering a sign-in that person started: never a key, bearer or
 * service. A limited agent can't approve sign-ins, so it can't widen access.
 */
async function requireBrowserPerson(
  c: Context,
  deps: ApiRouteDeps,
): Promise<{ context: AccessContext }> {
  if (isAgentActingAsPerson(c)) {
    requireFullAccessIfAgent(c, "Approving an agent sign-in");
    const context = await requireAccessContext(c, deps);
    if (context.mode !== "managed" || !context.subjectId.startsWith("user:")) {
      throw new HTTPException(403, { message: "Approving an agent sign-in needs a person" });
    }
    return { context };
  }
  if (
    deps.settings.productAccessMode !== "managed" ||
    !c.req.header("cookie") ||
    c.req.header("authorization")
  ) {
    throw new HTTPException(401, { message: "sign in to Opengeni in this browser first" });
  }
  const context = await requireAccessContext(c, deps);
  if (context.mode !== "managed" || !context.subjectId.startsWith("user:")) {
    throw new HTTPException(401, { message: "sign in to Opengeni in this browser first" });
  }
  return { context };
}

async function requirePendingOrganizationRequest(
  deps: ApiRouteDeps,
  requestToken: string,
  person: { context: AccessContext },
) {
  const request = requestToken.startsWith(REQUEST_PREFIX)
    ? await getMcpOAuthAuthorizationRequest(deps.db, tokenHash(requestToken))
    : null;
  if (!request || request.workspaceId !== null) {
    throw new HTTPException(410, { message: "This sign-in expired or was already answered." });
  }
  if (request.subjectId !== person.context.subjectId) {
    throw new HTTPException(403, { message: "This sign-in belongs to someone else." });
  }
  return request;
}

/** Organizations the person belongs to, with what they could hand an agent there. */
async function consentOrganizations(deps: ApiRouteDeps, context: AccessContext) {
  const memberOf = new Set(context.accountGrants.map((grant) => grant.accountId));
  const workspaces = (await listConsentWorkspaces(deps, context)).filter((workspace) =>
    memberOf.has(workspace.accountId),
  );
  const accounts = await consentAccountsForWorkspaces(
    deps,
    [...memberOf].map((accountId) => ({ accountId })),
  );
  const canonical = organizationAccessPresetPermissions("full");
  return accounts.map((account) => {
    const accountGrant = context.accountGrants.find((grant) => grant.accountId === account.id);
    const workspaceGrants = context.workspaceGrants.filter(
      (grant) => grant.accountId === account.id,
    );
    return {
      id: account.id,
      name: account.name,
      workspaces: workspaces
        .filter((workspace) => workspace.accountId === account.id)
        .map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          personal: workspace.kind === "personal",
        })),
      grantable: canonical.filter(
        (permission) =>
          (accountGrant !== undefined && hasPermission(accountGrant.permissions, permission)) ||
          workspaceGrants.some((grant) => hasPermission(grant.permissions, permission)),
      ),
    };
  });
}

function redirectHost(redirectUri: string): string | null {
  try {
    const url = new URL(redirectUri);
    return url.host || url.protocol.replace(/:$/u, "");
  } catch {
    return null;
  }
}

/**
 * The organization connection behind an organization-server bearer, or null
 * when the request carries no MCP OAuth token. Invalid, revoked, expired or
 * workspace-bound tokens are refused.
 */
export async function resolveOrganizationMcpOAuthAccess(
  deps: ApiRouteDeps,
  request: Request,
): Promise<(McpOAuthAccess & { organizationAccess: OrganizationAccessPolicy }) | null> {
  const token = mcpOAuthBearerToken(request);
  if (!token) return null;
  requireMcpOAuthEnabled(deps);
  const access = await resolveMcpOAuthAccessToken(deps.db, tokenHash(token));
  if (
    !access ||
    access.workspaceId !== null ||
    access.organizationAccess === null ||
    access.resource !== `${mcpOAuthIssuer(deps)}${ORGANIZATION_MCP_PATH}`
  ) {
    throw new HTTPException(401, { message: "invalid MCP OAuth access token" });
  }
  return { ...access, organizationAccess: access.organizationAccess };
}

/** Opaque host-only channel; never an Authorization/native authentication header. */
export const MCP_OAUTH_HOST_CREDENTIAL_HEADER = "x-opengeni-host-consent-credential";

async function requireMcpOAuthHostBrowserHuman(
  c: Context,
  deps: ApiRouteDeps,
  subjectId: string,
): Promise<McpOAuthHostHuman> {
  if (!c.req.header("cookie") || c.req.header("authorization") || isAgentActingAsPerson(c))
    throw new HTTPException(401, { message: "A signed-in browser human is required" });
  const human = await requireCanonicalHumanRequestIdentity(c, {
    db: deps.db,
    managedAuth: deps.managedAuth,
    managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
    managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
  });
  if (subjectId !== `user:${human.authUserId}`)
    throw new HTTPException(403, { message: "Consent belongs to another person" });
  const projection = await getCanonicalHumanIdentityProjection(deps.db, human.authUserId);
  const binding = activeCanonicalHumanLoginBinding(projection);
  const authentication = await readSessionAuthentication(deps.db, human);
  if (
    projection.activeIdentity.status !== "active" ||
    !binding ||
    authentication?.identityId !== projection.activeIdentity.id ||
    !authentication.latest
  )
    throw new HTTPException(403, { message: "The browser sign-in changed" });
  return {
    identityId: projection.activeIdentity.id,
    authSessionId: human.authSessionId,
    loginBindingId: binding.id,
    loginBindingRevision: binding.revision,
  };
}
function matchesDisplayedMcpOAuthProposal(
  form: URLSearchParams,
  proposal: McpOAuthHostProposal,
): boolean {
  return (
    form.get("host_revision") === String(proposal.revision) &&
    form.get("host_digest") === proposal.digest
  );
}
async function prepareMcpOAuthHostProposal(
  c: Context,
  deps: ApiRouteDeps,
  request: McpOAuthAuthorizationRequest,
  form: URLSearchParams,
): Promise<McpOAuthHostProposal> {
  const workspaceId = form.get("workspace_id") || request.workspaceId;
  if (!workspaceId || !isWorkspaceId(workspaceId))
    throw new HTTPException(400, { message: "Choose a workspace" });
  const initialHuman = await requireMcpOAuthHostBrowserHuman(c, deps, request.subjectId);
  const authorization = await requireAccessGrantAuthorization(
    c,
    deps,
    workspaceId,
    "workspace:read",
  );
  const grant = requireWorkspaceToolGatewayAuthorization(authorization);
  if (grant.subjectId !== request.subjectId)
    throw new HTTPException(403, { message: "Consent belongs to another person" });
  const consent = workspaceConsentAccess(form, grant.permissions);
  if (!consent) throw new HTTPException(400, { message: "Choose an access level" });
  const prepared =
    consent.preset === "full"
      ? await prepareWorkspaceToolGateway(deps, authorization)
      : await prepareWorkspaceToolGatewayForGrant(deps, {
          ...grant,
          permissions: consent.permissions,
        });
  try {
    if (
      !(await rebindMcpOAuthAuthorizationRequest(deps.db, {
        requestHash: request.requestHash,
        subjectId: grant.subjectId,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        permissions: consent.permissions,
        toolIdentities: mcpOAuthConsentToolIdentities(prepared.toolGatewayCatalog, consent),
        consentPreset: consent.preset,
        toolSetVersions: consentToolSetVersions(prepared),
      }))
    )
      throw new HTTPException(410, { message: "Consent expired or was already answered" });
  } finally {
    await prepared.close();
  }
  // Re-read the browser after catalog/network preparation, including login rebinding.
  const human = await requireMcpOAuthHostBrowserHuman(c, deps, grant.subjectId);
  if (JSON.stringify(human) !== JSON.stringify(initialHuman))
    throw new HTTPException(403, { message: "The browser sign-in changed" });
  const proposal = await freezeMcpOAuthHostProposal(deps.db, {
    requestHash: request.requestHash,
    organizationId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    human,
  });
  if (!proposal)
    throw new HTTPException(410, { message: "Consent expired or was already answered" });
  return proposal;
}
async function renderMcpOAuthHostReview(
  c: Context,
  deps: ApiRouteDeps,
  requestToken: string,
  proposal: McpOAuthHostProposal,
  form: URLSearchParams,
): Promise<string> {
  c.header("cache-control", "no-store");
  c.header(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'",
  );
  const context = await requireAccessContext(c, deps);
  const workspaces = await listConsentWorkspaces(deps, context);
  const clientId = proposal.material.clientId;
  const client = typeof clientId === "string" ? await getMcpOAuthClient(deps.db, clientId) : null;
  const authorization = await requireAccessGrantAuthorization(
    c,
    deps,
    proposal.workspaceId,
    "workspace:read",
  );
  return renderMcpOAuthConsentPage({
    clientName: client?.clientName ?? "MCP client",
    requestToken,
    accounts: await consentAccountsForWorkspaces(deps, workspaces),
    workspaces,
    selectedWorkspaceId: proposal.workspaceId,
    permissions: requireWorkspaceToolGatewayAuthorization(authorization).permissions,
    hostProposal: proposal,
    consentPreset: form.get("access_preset") ?? "full",
    selectedPermissions: form.getAll("permission"),
    reviewRequired: true,
  });
}
/** Fixed errors deliberately discard host exceptions, including credential-bearing messages. */
export async function runMcpOAuthHostHandoff(
  port: NonNullable<ApiRouteDeps["mcpOAuthHostConsent"]>,
  proposal: McpOAuthHostProposal,
  credential: string,
): Promise<void> {
  if (credential.length > 8192)
    throw new HTTPException(401, { message: "Host consent credential is invalid" });
  let expiry: unknown;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(credential.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    expiry = payload && typeof payload === "object" && "exp" in payload ? payload.exp : null;
  } catch {
    expiry = null;
  }
  if (typeof expiry !== "number" || !Number.isFinite(expiry))
    throw new HTTPException(401, { message: "Host consent credential is invalid" });
  const deadlineAt = Math.min(Date.now() + 10_000, expiry * 1000, Date.parse(proposal.expiresAt));
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new HTTPException(401, { message: "Host consent credential expired" });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      port.admit({
        proposal: {
          requestHash: proposal.requestHash,
          organizationId: proposal.organizationId,
          workspaceId: proposal.workspaceId,
          revision: proposal.revision,
          digest: proposal.digest,
          operationId: proposal.operationId,
          expiresAt: proposal.expiresAt,
        },
        readCredential: () => credential,
        signal: controller.signal,
        deadlineAt,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("host consent deadline"));
        }, remaining);
      }),
    ]);
  } catch {
    /* Outcome may have committed: the caller reads only durable admission. */
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
