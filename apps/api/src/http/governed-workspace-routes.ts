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
 * Who is refused: a person (`user:` or `external_user:` subject) with their own
 * credential (browser session, native app credential, personal API key). A
 * token signed with the deployment's delegation secret (the host's service and
 * person tokens, the worker's agent attempts) and machine credentials
 * (organization and workspace keys, the configured key) are the host's or the
 * runtime's own callers and keep each route's own checks. A caller without a
 * grant in the workspace keeps the route's own answer (401, 403 or a public
 * route's token check), so the refusal never tells an outsider anything.
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
 * refused, and so is any operation added later.
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
 * session-bound first-party MCP endpoint, the inbox and its notifications,
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
  // Tool calls of a session: the first-party MCP endpoint checks its session binding.
  { method: "ALL", path: `${ws}/mcp` },
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
  { method: "GET", path: `${ws}/artifact-catalog/*` },
  { method: "GET", path: `${ws}/editable-artifacts` },
  { method: "GET", path: `${ws}/editable-artifacts/*` },
  { method: "GET", path: `${ws}/published-artifacts` },
  { method: "GET", path: `${ws}/published-artifacts/*` },
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
 * governed prefixes, once per method and path, sorted. Middleware entries
 * (`ALL` on a wildcard) are left out; an `ALL` handler stays as `ALL`. A host
 * generates its refusal tests from this table: every row with `allowed: false`
 * answers 403 `WORKSPACE_ROUTE_NOT_ALLOWED` to a person of a governed
 * organization.
 */
export function governedRouteTable(
  routes: readonly Readonly<{ method: string; path: string }>[],
): GovernedRouteTableRow[] {
  const rows = new Map<string, GovernedRouteTableRow>();
  for (const route of routes) {
    if (!isGovernedRoutePrefix(route.path) || route.path.endsWith("/*")) continue;
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

/** A person with their own credential: the callers the default-deny refuses. */
function isPersonWithOwnCredential(grant: AccessGrant): boolean {
  if (grant.metadata?.delegated === true) return false;
  return grant.subjectId.startsWith("user:") || grant.subjectId.startsWith("external_user:");
}

async function workspaceCallerIsPerson(
  context: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<boolean> {
  try {
    return isPersonWithOwnCredential(await requireAccessGrant(context, deps, workspaceId));
  } catch {
    // No grant here (or no credential): the route gives its own answer.
    return false;
  }
}

async function organizationCallerIsPerson(context: Context, deps: ApiRouteDeps): Promise<boolean> {
  try {
    const access = await requireAccessContext(context, deps);
    if (access.workspaceGrants.some((grant) => grant.metadata?.delegated === true)) return false;
    return access.subjectId.startsWith("user:") || access.subjectId.startsWith("external_user:");
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
      const template = registeredHandlerRoutePath(context);
      if (!template || !isGovernedRoutePrefix(template)) return await next();
      const pathname = new URL(context.req.url).pathname;
      if (governedMemberRouteAllowed(method, template, pathname)) return await next();
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
          : await organizationCallerIsPerson(context, deps);
      if (!person) return await next();
      throw workspaceRouteNotAllowedHttpError();
    };
  app.use(`${ws}/*`, guard("workspace"));
  app.use("/v1/organizations/:organizationId/*", guard("organization"));
}
