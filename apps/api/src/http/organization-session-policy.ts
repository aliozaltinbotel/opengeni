import {
  ATTACHMENTS_DISABLED,
  SESSION_TOOL_FAMILY_DENIED,
  type SessionToolFamily,
} from "@opengeni/contracts/organization-session-policy";
import {
  AttachmentsDisabledError,
  SessionToolFamilyDeniedError,
  organizationSessionToolFamilyGate,
  requireAccessGrant,
  requireOrganizationAttachmentsAllowed,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getWorkspace } from "@opengeni/db";
import type { Hono } from "hono";
import { ApiHttpError } from "./api-error";

type PolicyDeps = Pick<ApiRouteDeps, "db" | "organizationGovernance">;

export function attachmentsDisabledHttpError(): ApiHttpError {
  return new ApiHttpError(403, {
    code: "forbidden",
    message: new AttachmentsDisabledError().message,
    retryable: false,
    outcomeUnknown: false,
    details: { code: ATTACHMENTS_DISABLED },
  });
}

export function sessionToolFamilyDeniedHttpError(family: SessionToolFamily): ApiHttpError {
  return new ApiHttpError(403, {
    code: "forbidden",
    message: new SessionToolFamilyDeniedError(family).message,
    retryable: false,
    outcomeUnknown: false,
    details: { code: SESSION_TOOL_FAMILY_DENIED, family },
  });
}

/** Maps the core refusals onto the API envelope; null for any other error. */
export function organizationSessionPolicyHttpError(error: unknown): ApiHttpError | null {
  if (error instanceof AttachmentsDisabledError) return attachmentsDisabledHttpError();
  if (error instanceof SessionToolFamilyDeniedError)
    return sessionToolFamilyDeniedHttpError(error.family);
  return null;
}

/**
 * Refuses a person's upload into the workspace when its organization's policy
 * turns attachments off. Called after the route authenticated the caller.
 */
export async function requireWorkspaceAttachmentsAllowed(
  deps: PolicyDeps,
  organizationId: string,
): Promise<void> {
  try {
    await requireOrganizationAttachmentsAllowed(deps, organizationId);
  } catch (error) {
    throw organizationSessionPolicyHttpError(error) ?? error;
  }
}

/** The families an organization's policy removes, for the first-party MCP server. */
export async function deniedSessionToolFamiliesForOrganization(
  deps: PolicyDeps,
  organizationId: string,
): Promise<SessionToolFamily[]> {
  if (!deps.organizationGovernance) return [];
  return [...(await organizationSessionToolFamilyGate(deps, organizationId)).deniedFamilies];
}

/**
 * REST surfaces that are a generic tool family themselves. In an organization
 * whose policy removes the family, every request is refused after the caller
 * is authenticated (an anonymous caller still gets 401 and learns nothing).
 * `mutatingOnly` keeps reads of existing records, so a policy change never
 * hides what already happened.
 */
const FAMILY_ROUTES: readonly { path: string; family: SessionToolFamily; mutatingOnly: boolean }[] =
  [
    { path: "/v1/workspaces/:workspaceId/codemode/*", family: "codemode", mutatingOnly: false },
    { path: "/v1/workspaces/:workspaceId/browser-sessions", family: "browser", mutatingOnly: true },
    {
      path: "/v1/workspaces/:workspaceId/browser-sessions/*",
      family: "browser",
      mutatingOnly: true,
    },
    {
      path: "/v1/workspaces/:workspaceId/attached-browsers",
      family: "browser",
      mutatingOnly: true,
    },
    {
      path: "/v1/workspaces/:workspaceId/attached-browsers/*",
      family: "browser",
      mutatingOnly: true,
    },
    {
      path: "/v1/workspaces/:workspaceId/computer-sessions",
      family: "computerUse",
      mutatingOnly: true,
    },
    {
      path: "/v1/workspaces/:workspaceId/computer-sessions/*",
      family: "computerUse",
      mutatingOnly: true,
    },
    {
      path: "/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/*",
      family: "shell",
      mutatingOnly: false,
    },
  ];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Registers the family refusals. Must run before the routes it guards are registered. */
export function registerSessionToolFamilyRouteGuards(app: Hono, deps: ApiRouteDeps): void {
  if (!deps.organizationGovernance) return;
  for (const route of FAMILY_ROUTES) {
    app.use(route.path, async (context, next) => {
      if (route.mutatingOnly && READ_METHODS.has(context.req.method)) return await next();
      const workspaceId = context.req.param("workspaceId") ?? "";
      // A lookup failure propagates (fail closed); an unknown workspace keeps
      // the route's own answer.
      const workspace = /^[0-9a-f-]{36}$/iu.test(workspaceId)
        ? await getWorkspace(deps.db, workspaceId)
        : null;
      if (!workspace) return await next();
      const gate = await organizationSessionToolFamilyGate(deps, workspace.accountId);
      if (!gate.denies(route.family)) return await next();
      await requireAccessGrant(context, deps, workspaceId);
      throw sessionToolFamilyDeniedHttpError(route.family);
    });
  }
}
