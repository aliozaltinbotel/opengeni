import {
  ATTACHMENTS_DISABLED,
  SESSION_TOOL_FAMILY_DENIED,
  type SessionToolFamily,
} from "@opengeni/contracts/organization-session-policy";
import {
  AttachmentsDisabledError,
  SessionToolFamilyDeniedError,
  ensureOrganizationSessionPolicyAtEntry,
  organizationSessionToolFamilyGate,
  requireAccessGrant,
  resolveOrganizationSessionPolicy,
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

/**
 * Before stored work that starts sessions later (a schedule, an automation
 * trigger) is created, changed, resumed or run: the organization's policy row
 * exists, so the worker that fires it reads the same answer, and a template
 * that attaches files is refused where attachments are off (whoever asks:
 * the worker refuses it again when it fires).
 */
export async function requireScheduledWorkAdmissible(
  deps: PolicyDeps,
  organizationId: string,
  resources: readonly { kind: string }[] | null | undefined,
): Promise<void> {
  if (!deps.organizationGovernance) return;
  await ensureOrganizationSessionPolicyAtEntry(deps, organizationId);
  if (!resources?.some((resource) => resource.kind === "file")) return;
  await requireWorkspaceAttachmentsAllowed(deps, organizationId);
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
 * whose policy removes one of a route's families, every request is refused
 * after the caller is authenticated (an anonymous caller still gets 401 and
 * learns nothing). `mutatingOnly` keeps reads of existing records, so a
 * policy change never hides what already happened.
 */
type FamilyRoute = {
  path: string;
  families: readonly SessionToolFamily[];
  mutatingOnly: boolean;
};
const ws = "/v1/workspaces/:workspaceId";
const FAMILY_ROUTES: readonly FamilyRoute[] = [
  { path: `${ws}/codemode/*`, families: ["codemode"], mutatingOnly: false },
  { path: `${ws}/browser-sessions`, families: ["browser"], mutatingOnly: true },
  { path: `${ws}/browser-sessions/*`, families: ["browser"], mutatingOnly: true },
  { path: `${ws}/computer-sessions`, families: ["computerUse"], mutatingOnly: true },
  { path: `${ws}/computer-sessions/*`, families: ["computerUse"], mutatingOnly: true },
  {
    path: `${ws}/machines/:enrollmentId/screen-control`,
    families: ["computerUse"],
    mutatingOnly: true,
  },
  // A Connected Machine is both a shell and a desktop.
  { path: `${ws}/enrollments/token`, families: ["shell", "computerUse"], mutatingOnly: true },
  {
    path: `${ws}/enrollments/device/approve`,
    families: ["shell", "computerUse"],
    mutatingOnly: true,
  },
  { path: `${ws}/sessions/:sessionId/terminal/*`, families: ["shell"], mutatingOnly: false },
  { path: `${ws}/sessions/:sessionId/fs/*`, families: ["shell"], mutatingOnly: false },
  { path: `${ws}/sessions/:sessionId/git/*`, families: ["shell"], mutatingOnly: false },
];

/** A person writing into a session's files is attaching them. */
const ATTACHMENT_ROUTES: readonly string[] = [
  `${ws}/sessions/:sessionId/fs/write`,
  `${ws}/sessions/:sessionId/fs/move`,
  `${ws}/sessions/:sessionId/fs/mkdir`,
];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function workspaceOrganization(
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<string | null> {
  // A lookup failure propagates (fail closed); an unknown workspace keeps the
  // route's own answer.
  if (!/^[0-9a-f-]{36}$/iu.test(workspaceId)) return null;
  return (await getWorkspace(deps.db, workspaceId))?.accountId ?? null;
}

/** Registers the family and attachment refusals. Must run before the routes they guard. */
export function registerSessionToolFamilyRouteGuards(app: Hono, deps: ApiRouteDeps): void {
  if (!deps.organizationGovernance) return;
  for (const route of FAMILY_ROUTES) {
    app.use(route.path, async (context, next) => {
      if (route.mutatingOnly && READ_METHODS.has(context.req.method)) return await next();
      const workspaceId = context.req.param("workspaceId") ?? "";
      const organizationId = await workspaceOrganization(deps, workspaceId);
      if (!organizationId) return await next();
      const gate = await organizationSessionToolFamilyGate(deps, organizationId);
      const denied = route.families.find((family) => gate.denies(family));
      if (!denied) return await next();
      await requireAccessGrant(context, deps, workspaceId);
      throw sessionToolFamilyDeniedHttpError(denied);
    });
  }
  for (const path of ATTACHMENT_ROUTES) {
    app.use(path, async (context, next) => {
      const workspaceId = context.req.param("workspaceId") ?? "";
      const organizationId = await workspaceOrganization(deps, workspaceId);
      if (!organizationId) return await next();
      const { policy } = await resolveOrganizationSessionPolicy(deps, organizationId);
      if (policy.attachments === "enabled") return await next();
      const grant = await requireAccessGrant(context, deps, workspaceId);
      // An agent's own writes are its work, not a person's attachment.
      if (grant.principalKind === "agent_attempt") return await next();
      throw attachmentsDisabledHttpError();
    });
  }
}
