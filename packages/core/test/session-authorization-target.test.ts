import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  SessionAuthorizationTarget,
  type AccessGrant,
  type SessionAuthorizationDecision,
} from "@opengeni/contracts";
import * as database from "@opengeni/db";
import {
  requireSessionAuthorization,
  requireSessionAuthorizationListScope,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  withSessionAuthorizationReadReuse,
} from "../src/session-authorization";

const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const rootSessionId = crypto.randomUUID();
const subjectId = "user:reader";
const db = {} as database.Database;
const grant: AccessGrant = {
  accountId,
  workspaceId,
  subjectId,
  principalKind: "human_session",
  permissions: ["sessions:read"],
};
const input = { sessionId, operation: "session.read", surface: "http" } as const;

function targetFacts(
  overrides: Partial<NonNullable<database.SessionAuthorizationFacts["target"]>> = {},
): NonNullable<database.SessionAuthorizationFacts["target"]> {
  return {
    sessionId,
    accountId,
    rootSessionId,
    authorityEpoch: 1,
    visibility: "user_private",
    ownerSubjectId: subjectId,
    siteId: null,
    siteAccessRootId: null,
    siteViewerPrincipal: null,
    siteOwnerSubjectId: null,
    agentAccess: "workspace",
    scopeSubjectId: null,
    memoryScope: "off",
    slackAccess: null,
    ...overrides,
  };
}

let facts: ReturnType<typeof spyOn<typeof database, "getSessionAuthorizationFacts">>;
let fullSession: ReturnType<typeof spyOn<typeof database, "getSession">>;
const authorizeSession = mock(
  async (): Promise<SessionAuthorizationDecision> => ({ allowed: true }),
);
const deps = {
  db,
  sessionAuthorization: {
    authorizeSession,
    resolveListScope: async () => ({ kind: "all" as const }),
  },
};

beforeEach(() => {
  authorizeSession.mockReset();
  authorizeSession.mockResolvedValue({ allowed: true });
  facts = spyOn(database, "getSessionAuthorizationFacts").mockResolvedValue({
    target: targetFacts(),
    caller: null,
  });
  fullSession = spyOn(database, "getSession").mockRejectedValue(
    new Error("Target authorization must not expand the full chat"),
  );
});
afterEach(() => mock.restore());

test("the authorization target carries owner and visibility", async () => {
  const result = await requireSessionAuthorization(deps, grant, input);
  expect(result?.target).toEqual({
    sessionId,
    rootSessionId,
    ownerSubjectId: subjectId,
    visibility: "user_private",
  });
  expect(authorizeSession).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId,
      workspaceId,
      target: { sessionId, rootSessionId, ownerSubjectId: subjectId, visibility: "user_private" },
    }),
  );
  expect(facts).toHaveBeenCalledTimes(1);
  expect(facts).toHaveBeenCalledWith(db, { accountId, workspaceId, sessionId, caller: undefined });
  expect(fullSession).not.toHaveBeenCalled();
});

test("a hidden target or wrong account is refused before the host is called", async () => {
  for (const target of [null, targetFacts({ accountId: crypto.randomUUID() })]) {
    facts.mockResolvedValue({ target, caller: null });
    await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
      SessionAuthorizationDeniedError,
    );
  }
  expect(authorizeSession).not.toHaveBeenCalled();
});

test("host denial and host failure still refuse the request", async () => {
  authorizeSession.mockResolvedValue({ allowed: false, reason: "forbidden" });
  await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
    SessionAuthorizationDeniedError,
  );
  authorizeSession.mockRejectedValue(new Error("host unavailable"));
  await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
    SessionAuthorizationUnavailableError,
  );
});

test("an agent attempt's caller and target come from the same single read", async () => {
  // The browser and computer routes authorize an agent acting on its own session.
  const callerId = sessionId;
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const agentGrant: AccessGrant = {
    ...grant,
    principalKind: "agent_attempt",
    metadata: { sessionId: callerId, turnId, attemptId, executionGeneration: 1 },
  };
  const caller: database.SessionAuthorizationFacts["caller"] = {
    session: {
      accountId,
      rootSessionId,
      parentSessionId: null,
      agentAccess: "workspace",
      scopeSubjectId: null,
    },
    turn: {
      id: turnId,
      executionGeneration: 1,
      initiator: { kind: "subject", subjectId },
      initiatorContext: {},
      initiatingHumanSubjectId: subjectId,
    },
  };
  facts.mockResolvedValue({ target: targetFacts(), caller });
  const result = await requireSessionAuthorization(deps, agentGrant, input);
  expect(result?.actor).toMatchObject({ kind: "agent_attempt", callerSessionId: callerId });
  expect(facts).toHaveBeenCalledTimes(1);
  expect(facts).toHaveBeenCalledWith(db, {
    accountId,
    workspaceId,
    sessionId,
    caller: { sessionId: callerId, attemptId },
  });

  const durableViewer = {
    callerRootSessionId: rootSessionId,
    agentAccess: "session" as const,
    scopeSubjectId: subjectId,
  };
  facts.mockResolvedValue({
    target: targetFacts(),
    caller: {
      ...caller,
      session: { ...caller.session!, agentAccess: "session", scopeSubjectId: subjectId },
    },
  });
  for (const kind of ["owned", "owned_or_shared"] as const) {
    const scopedDeps = {
      ...deps,
      sessionAuthorization: {
        ...deps.sessionAuthorization,
        resolveListScope: async () => ({
          kind,
          subjectId: "host:chosen-person",
          agentAccessViewer: { ...durableViewer, agentAccess: "workspace" as const },
        }),
      },
    };
    expect(await requireSessionAuthorizationListScope(scopedDeps, agentGrant, "http")).toEqual({
      kind,
      subjectId: "host:chosen-person",
      agentAccessViewer: durableViewer,
    });
  }

  // A target the caller cannot see is not found, whatever the caller's state.
  facts.mockResolvedValue({ target: null, caller });
  await expect(requireSessionAuthorization(deps, agentGrant, input)).rejects.toMatchObject({
    reason: "not_found",
  });
  // A turn that is no longer live, or a different generation, is stale.
  for (const stale of [
    { ...caller, turn: null },
    { ...caller, turn: { ...caller.turn!, executionGeneration: 2 } },
    { ...caller, session: { ...caller.session!, accountId: crypto.randomUUID() } },
  ]) {
    facts.mockResolvedValue({ target: targetFacts(), caller: stale });
    await expect(requireSessionAuthorization(deps, agentGrant, input)).rejects.toMatchObject({
      reason: "caller_stale",
    });
  }
  expect(fullSession).not.toHaveBeenCalled();
});

test("read reuse stays request-scoped and stops at the handoff", async () => {
  await withSessionAuthorizationReadReuse(async (reuse) => {
    await requireSessionAuthorization(deps, grant, input);
    facts.mockResolvedValue({ target: null, caller: null });
    await requireSessionAuthorization(deps, grant, input);
    expect(facts).toHaveBeenCalledTimes(1);
    reuse.handOffToToolDispatch();
    await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
      SessionAuthorizationDeniedError,
    );
  });
  await expect(requireSessionAuthorization(deps, grant, input)).rejects.toBeInstanceOf(
    SessionAuthorizationDeniedError,
  );
  expect(facts).toHaveBeenCalledTimes(3);
});

test("an old host contract is unchanged", async () => {
  expect(SessionAuthorizationTarget.parse({ sessionId, rootSessionId })).toEqual({
    sessionId,
    rootSessionId,
  });
  expect(await requireSessionAuthorizationListScope(deps, grant, "http")).toEqual({ kind: "all" });
  const oldHost = {
    db,
    sessionAuthorization: {
      authorizeSession: async ({
        target,
      }: {
        target: { sessionId: string; rootSessionId: string };
      }): Promise<SessionAuthorizationDecision> =>
        target.sessionId === sessionId
          ? { allowed: true }
          : { allowed: false, reason: "not_found" },
      resolveListScope: async () => ({
        kind: "scoped" as const,
        rootSessionIds: [rootSessionId],
        sessionIds: [],
      }),
    },
  };
  expect((await requireSessionAuthorization(oldHost, grant, input))?.target.sessionId).toBe(
    sessionId,
  );
  expect(await requireSessionAuthorizationListScope(oldHost, grant, "http")).toEqual({
    kind: "scoped",
    rootSessionIds: [rootSessionId],
    sessionIds: [],
  });
});

test("host ownership scopes retain the trusted subject and reject malformed subjects", async () => {
  for (const kind of ["owned", "owned_or_shared"] as const) {
    const scopedDeps = {
      ...deps,
      sessionAuthorization: {
        ...deps.sessionAuthorization,
        resolveListScope: async () => ({ kind, subjectId: "external:host-person" }),
      },
    };
    expect(
      await requireSessionAuthorizationListScope(
        scopedDeps,
        { ...grant, principalKind: "service", subjectId: "technical-agent" },
        "http",
      ),
    ).toEqual({ kind, subjectId: "external:host-person" });
    for (const invalid of [
      "",
      " ",
      "user:bad\u0000subject",
      "user:bad\nsubject",
      "x".repeat(1025),
      null,
      7,
    ]) {
      const resolveListScope = mock(deps.sessionAuthorization.resolveListScope);
      resolveListScope.mockResolvedValue({ kind, subjectId: invalid } as never);
      const invalidDeps = {
        ...deps,
        sessionAuthorization: { ...deps.sessionAuthorization, resolveListScope },
      };
      // The host port is an untrusted runtime boundary; exercise parsing before any database listing.
      await expect(
        requireSessionAuthorizationListScope(invalidDeps, grant, "http"),
      ).rejects.toBeInstanceOf(SessionAuthorizationUnavailableError);
    }
  }
});

test("stock console without an extension is unchanged", async () => {
  const stockDependencies = { db };
  facts.mockResolvedValue({
    target: targetFacts({ visibility: "workspace_shared", ownerSubjectId: null }),
    caller: null,
  });
  expect(await requireSessionAuthorization(stockDependencies, grant, input)).toBeNull();
  facts.mockResolvedValue({ target: targetFacts(), caller: null });
  expect(
    (await requireSessionAuthorization(stockDependencies, grant, input))?.target,
  ).toMatchObject({ sessionId, ownerSubjectId: subjectId, visibility: "user_private" });
  facts.mockResolvedValue({
    target: targetFacts({ ownerSubjectId: "user:another-member" }),
    caller: null,
  });
  await expect(requireSessionAuthorization(stockDependencies, grant, input)).rejects.toMatchObject({
    reason: "forbidden",
  });
  expect(authorizeSession).not.toHaveBeenCalled();
});
