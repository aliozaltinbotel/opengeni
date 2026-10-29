import { WORKSPACE_ROUTE_NOT_ALLOWED } from "@opengeni/contracts/organization-governance";
import type { AccessGrant, SessionAuthorizationOperation } from "@opengeni/contracts";
import {
  organizationGovernedByHost,
  requireAccessContext,
  requireAccessGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getWorkspace } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { sessionAuthorizationOperationForHttp } from "../routes/sessions";
import { ApiHttpError } from "./api-error";
import { registeredHandlerRoutePath } from "./registered-route-label";

/*
 * Default-deny for people in a host-governed organization's workspaces.
 *
 * A governed organization's people reach `/v1/workspaces/:workspaceId/*` and
 * `/v1/organizations/:organizationId/*` only through the routes listed here.
 * Every other route answers 403 `WORKSPACE_ROUTE_NOT_ALLOWED`, whatever their
 * native permissions say: in such an organization every member holds
 * `workspace:read`, which alone opens dozens of route families (automations,
 * coding subscriptions, integrations, sandbox images...) the host never meant
 * its people to use.
 *
 * Who is refused, in a governed organization:
 * - a person with their own credential: a `user:` (or `external_user:`)
 *   subject behind a browser session, a native app credential or a personal
 *   API key;
 * - a person token signed with the deployment's delegation secret
 *   (`principalKind: "human_session"`): only a host mints those, and its
 *   people get the same allowlist as in their browser.
 *
 * Who keeps each route's own checks: the other delegated tokens (the host's
 * service tokens, the worker's agent attempts), machine credentials
 * (organization and workspace keys, the configured key) and an organization
 * key acting for a person (`asUser`, the `x-opengeni-external-actor` lane,
 * which only an organization key can open): those are the host's or the
 * runtime's own callers. MCP OAuth clients authenticate inside `/mcp` and get
 * that route's own answer. A caller without a grant in the workspace (or, at
 * organization scope, without a grant in the organization) keeps the route's
 * own answer (401, 403, 404 or a public route's token check), so the refusal
 * never tells an outsider anything. A request under the guarded prefixes that
 * resolves to no registered handler is refused for a person too (fail closed).
 *
 * The host opts in with `OrganizationGovernancePort.memberRouteAccess:
 * "allowlist"`. Without it (or without a bound port) nothing is registered,
 * and an organization the port does not govern is unchanged.
 */

/**
 * The session operations a person may use in a governed workspace: reading the
 * session, messages and control, answers to tools and questions, and their own
 * organizing. Session-addressed routes whose operation is outside this set
 * (files, terminal, git, viewers, realtime, tool policy, model and account
 * choice, MCP credentials, retention, deletion, visibility, forks...) are
 * refused, and so is any operation added later. The routes in
 * `GOVERNED_MEMBER_SESSION_ROUTE_DENIALS` are refused even though their
 * operation is in this set.
 */
export const GOVERNED_MEMBER_SESSION_OPERATIONS: readonly SessionAuthorizationOperation[] =
  Object.freeze([
    "session.read",
    "session.events.read",
    "session.stream.read",
    "session.stream.acknowledge",
    "session.turns.read",
    "session.creation_receipt.read",
    "session.queue.read",
    "session.lineage.read",
    "session.goal.read",
    "session.human_input.read",
    "session.composer.read",
    "session.append",
    "session.steer",
    "session.cancel",
    "session.control",
    "session.queue.control",
    "session.composer.write",
    "session.context.write",
    "session.first_party_mcp.call",
    "session.approval.write",
    "session.human_input.write",
    "session.goal.write",
    "session.title.write",
    "session.pin.write",
    "session.attention.write",
    "session.archive.write",
    "session.feedback.write",
  ]);

export type GovernedRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";
export type GovernedRouteEntry = Readonly<{ method: GovernedRouteMethod; path: string }>;

const ws = "/v1/workspaces/:workspaceId";
const SESSION_PREFIX = `${ws}/sessions/:sessionId`;

/**
 * The workspace routes, outside one session's own routes, a person in a
 * governed workspace may use: the workspace itself, the session list and
 * session creation, the composer's reads, the workspace live streams, the
 * inbox and its notifications,
 * documents, Knowledge and Skills (under their own permissions), feedback on a
 * session, and artifact reads. Paths are the registered Hono templates.
 */
export const GOVERNED_MEMBER_WORKSPACE_ROUTES: readonly GovernedRouteEntry[] = Object.freeze([
  { method: "GET", path: ws },
  { method: "GET", path: `${ws}/access/grant` },
  // Sessions: list and create (each session's own routes follow the operation set above).
  { method: "GET", path: `${ws}/sessions` },
  { method: "POST", path: `${ws}/sessions` },
  { method: "GET", path: `${ws}/session-tenancy/capabilities` },
  { method: "GET", path: `${ws}/session-message-search` },
  { method: "GET", path: `${ws}/new-session-draft` },
  { method: "PUT", path: `${ws}/new-session-draft` },
  // The composer's model list and the person's own usage.
  { method: "GET", path: `${ws}/models` },
  { method: "GET", path: `${ws}/model-catalog` },
  { method: "GET", path: `${ws}/usage/me` },
  { method: "GET", path: `${ws}/allowance/state` },
  // Live updates of the session list and its sessions.
  { method: "GET", path: `${ws}/control-events` },
  { method: "GET", path: `${ws}/control-events/stream` },
  { method: "GET", path: `${ws}/live-events/stream` },
  // Not `/mcp`: for a person's own credential it is the whole workspace tool
  // gateway (as `tools/*`); sessions reach their tools through the worker's
  // delegated tokens, which the default-deny does not refuse.
  // The inbox and its notifications.
  { method: "ALL", path: `${ws}/inbox/*` },
  // Documents, Knowledge and Skills: each route checks its own permission.
  { method: "ALL", path: `${ws}/documents` },
  { method: "ALL", path: `${ws}/documents/*` },
  { method: "ALL", path: `${ws}/knowledge/*` },
  { method: "ALL", path: `${ws}/skills` },
  { method: "ALL", path: `${ws}/skills/*` },
  // Feedback on a session (`session.feedback.write` inside the route).
  { method: "GET", path: `${ws}/feedback` },
  { method: "POST", path: `${ws}/feedback` },
  // Artifact reads.
  { method: "GET", path: `${ws}/artifacts/*` },
  { method: "POST", path: `${ws}/artifacts/:artifactId/playback-source` },
  { method: "GET", path: `${ws}/artifact-catalog` },
  { method: "GET", path: `${ws}/editable-artifacts` },
  { method: "GET", path: `${ws}/editable-artifacts/*` },
  { method: "GET", path: `${ws}/published-artifacts` },
  { method: "GET", path: `${ws}/published-artifacts/*` },
]);

/**
 * Session routes refused to a person in a governed workspace although their
 * operation is in `GOVERNED_MEMBER_SESSION_OPERATIONS`: they reuse a generic
 * operation (`session.read`, `session.control`) for a subject the allowlist
 * otherwise closes (coding-subscription accounts, model and account choice,
 * background processes, sandbox recovery, operator access). Paths are the
 * registered Hono templates.
 */
export const GOVERNED_MEMBER_SESSION_ROUTE_DENIALS: readonly GovernedRouteEntry[] = Object.freeze([
  { method: "GET", path: `${SESSION_PREFIX}/codex-accounts` },
  { method: "GET", path: `${SESSION_PREFIX}/model-account` },
  { method: "GET", path: `${SESSION_PREFIX}/background-commands` },
  { method: "DELETE", path: `${SESSION_PREFIX}/background-commands/:commandId` },
  { method: "GET", path: `${SESSION_PREFIX}/sandbox-recovery` },
  { method: "POST", path: `${SESSION_PREFIX}/sandbox-recovery` },
  { method: "GET", path: `${SESSION_PREFIX}/admin-access` },
]);

/**
 * Organization routes a person in a governed organization may use. None: the
 * host administers its organizations, and every organization route is an
 * administration or a setting.
 */
export const GOVERNED_MEMBER_ORGANIZATION_ROUTES: readonly GovernedRouteEntry[] = Object.freeze([]);

function templateMatches(pattern: string, template: string): boolean {
  if (pattern === template) return true;
  if (!pattern.endsWith("/*")) return false;
  const prefix = pattern.slice(0, -1);
  return template.startsWith(prefix) && template.length > prefix.length;
}

function entryAllows(entry: GovernedRouteEntry, method: string, template: string): boolean {
  return (
    (entry.method === "ALL" || entry.method === method.toUpperCase()) &&
    templateMatches(entry.path, template)
  );
}

/** The value standing in for a session id when a template, not a URL, is classified. */
const TEMPLATE_SESSION_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Whether a person in a governed organization may use the route registered as
 * `template` with `method`. `pathname` (the request URL's path), when given,
 * classifies a session route by its real session id; otherwise the template's
 * own segments are classified.
 */
export function governedMemberRouteAllowed(
  method: string,
  template: string,
  pathname?: string,
): boolean {
  if (template === SESSION_PREFIX || template.startsWith(`${SESSION_PREFIX}/`)) {
    if (GOVERNED_MEMBER_SESSION_ROUTE_DENIALS.some((entry) => entryAllows(entry, method, template)))
      return false;
    const segments = template.split("/");
    const at = segments.indexOf(":sessionId");
    const sessionId = pathname?.split("/")[at] ?? TEMPLATE_SESSION_ID;
    const path = pathname ?? template.replace(":sessionId", TEMPLATE_SESSION_ID);
    const operation = sessionAuthorizationOperationForHttp(method, path, sessionId);
    return operation !== null && GOVERNED_MEMBER_SESSION_OPERATIONS.includes(operation);
  }
  const entries = template.startsWith("/v1/organizations/")
    ? GOVERNED_MEMBER_ORGANIZATION_ROUTES
    : GOVERNED_MEMBER_WORKSPACE_ROUTES;
  return entries.some((entry) => entryAllows(entry, method, template));
}

export type GovernedRouteTableRow = Readonly<{
  method: string;
  path: string;
  allowed: boolean;
}>;

/** Whether a registered route sits under a prefix the default-deny covers. */
export function isGovernedRoutePrefix(path: string): boolean {
  return (
    path === ws ||
    path.startsWith(`${ws}/`) ||
    path === "/v1/organizations/:organizationId" ||
    path.startsWith("/v1/organizations/:organizationId/")
  );
}

/**
 * The default-deny's decision for every route `app.routes` lists under the
 * governed prefixes, once per method and path, sorted. Middleware entries are
 * left out; an `ALL` handler (wildcard ones included) stays as `ALL`. A host
 * generates its refusal tests from this table: every row with `allowed: false`
 * answers 403 `WORKSPACE_ROUTE_NOT_ALLOWED` to a person of a governed
 * organization.
 */
export function governedRouteTable(
  routes: readonly Readonly<{ method: string; path: string; handler?: unknown }>[],
): GovernedRouteTableRow[] {
  const rows = new Map<string, GovernedRouteTableRow>();
  for (const route of routes) {
    if (!isGovernedRoutePrefix(route.path) || isMiddleware(route)) continue;
    const key = `${route.method} ${route.path}`;
    if (rows.has(key)) continue;
    rows.set(key, {
      method: route.method,
      path: route.path,
      allowed: governedMemberRouteAllowed(route.method, route.path),
    });
  }
  return [...rows.values()].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );
}

/**
 * A middleware entry of `app.routes` (arity two: `(context, next)`), the rule
 * `registeredHandlerRoutePath` uses; without a handler, a `/*` template.
 */
function isMiddleware(route: Readonly<{ path: string; handler?: unknown }>): boolean {
  return typeof route.handler === "function"
    ? route.handler.length >= 2
    : route.path.endsWith("/*");
}

export function workspaceRouteNotAllowedHttpError(): ApiHttpError {
  return new ApiHttpError(403, {
    code: "forbidden",
    message: "This is not available in an organization its host application manages.",
    retryable: false,
    outcomeUnknown: false,
    details: { code: WORKSPACE_ROUTE_NOT_ALLOWED },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const PERSON_SUBJECT = /^(?:user|external_user):/u;

/**
 * An organization key acting for a person (`asUser`). The header always routes
 * resolution to the organization-key lane (and refuses any other credential),
 * so a resolved request that carries it came through an organization key.
 */
function isOrganizationKeyActingForPerson(context: Context): boolean {
  return context.req.header("x-opengeni-external-actor") !== undefined;
}

/** Whether a resolved grant is one of the callers the default-deny refuses. */
export function governedRouteCallerIsPerson(
  grant: Pick<AccessGrant, "subjectId" | "principalKind" | "metadata">,
): boolean {
  // A delegated token: only a host-minted person token is a person.
  if (grant.metadata?.delegated === true) return grant.principalKind === "human_session";
  return PERSON_SUBJECT.test(grant.subjectId);
}

async function workspaceCallerIsPerson(
  context: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<boolean> {
  try {
    const grant = await requireAccessGrant(context, deps, workspaceId);
    return !isOrganizationKeyActingForPerson(context) && governedRouteCallerIsPerson(grant);
  } catch {
    // No grant here (or no credential): the route gives its own answer.
    return false;
  }
}

async function organizationCallerIsPerson(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
): Promise<boolean> {
  try {
    const access = await requireAccessContext(context, deps);
    if (isOrganizationKeyActingForPerson(context)) return false;
    // No grant in this organization: the route's own answer, so the refusal
    // never tells an outsider the organization exists or is governed.
    const inOrganization =
      access.accountGrants.some((grant) => grant.accountId === organizationId) ||
      access.workspaceGrants.some((grant) => grant.accountId === organizationId);
    if (!inOrganization) return false;
    const delegated = access.workspaceGrants.find((grant) => grant.metadata?.delegated === true);
    if (delegated) return governedRouteCallerIsPerson(delegated);
    return PERSON_SUBJECT.test(access.subjectId);
  } catch {
    return false;
  }
}

/**
 * Registers the default-deny. Must run before the routes it guards. A read of
 * the organization and a port answer happen only for a route outside the
 * allowlist; a lookup or port failure fails the request (closed).
 */
export function registerGovernedWorkspaceRouteGuards(app: Hono, deps: ApiRouteDeps): void {
  if (deps.organizationGovernance?.memberRouteAccess !== "allowlist") return;
  const guard =
    (scope: "workspace" | "organization") =>
    async (context: Context, next: () => Promise<void>): Promise<Response | void> => {
      const method = context.req.method;
      if (method === "OPTIONS") return await next();
      // No registered handler under the guarded prefixes is refused for a
      // person too (fail closed); an allowed route returns before any read.
      const template = registeredHandlerRoutePath(context);
      const pathname = new URL(context.req.url).pathname;
      if (
        template &&
        isGovernedRoutePrefix(template) &&
        governedMemberRouteAllowed(method, template, pathname)
      )
        return await next();
      const id =
        scope === "workspace"
          ? (context.req.param("workspaceId") ?? "")
          : (context.req.param("organizationId") ?? "");
      if (!UUID.test(id)) return await next();
      const organizationId =
        scope === "workspace" ? ((await getWorkspace(deps.db, id))?.accountId ?? null) : id;
      if (!organizationId || !(await organizationGovernedByHost(deps, organizationId)))
        return await next();
      const person =
        scope === "workspace"
          ? await workspaceCallerIsPerson(context, deps, id)
          : await organizationCallerIsPerson(context, deps, id);
      if (!person) return await next();
      throw workspaceRouteNotAllowedHttpError();
    };
  app.use(`${ws}/*`, guard("workspace"));
  app.use("/v1/organizations/:organizationId/*", guard("organization"));
}
