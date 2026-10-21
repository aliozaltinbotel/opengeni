import { describe, expect, test } from "bun:test";

import {
  managedSelfContextIdentity,
  type ManagedSelfContext,
} from "@opengeni/react/app/lib/managed-self-context";
import {
  authorizedWorkspaceFromList,
  hydrateWorkspaceAccessContext,
  resolveWorkspaceScopeContext,
} from "./workspace-scope-context";
import type { AccessContext, Workspace } from "@opengeni/react/app/types";

const organizationId = "11111111-1111-4111-8111-111111111111";
const sharedWorkspaceId = "22222222-2222-4222-8222-222222222222";
const personalWorkspaceId = "33333333-3333-4333-8333-333333333333";
const subjectId = "user:managed-user";

function workspace(id: string, name: string): Workspace {
  return {
    id,
    accountId: organizationId,
    kind: id === personalWorkspaceId ? "personal" : "shared",
    name,
    slug: null,
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {},
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    defaultRigId: null,
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
  };
}

const shared = workspace(sharedWorkspaceId, "Operations");
const personal = workspace(personalWorkspaceId, "Roadmap");

function access(grantSubjectId = subjectId): AccessContext {
  return {
    mode: "managed",
    subjectId,
    subjectLabel: "Ada",
    defaultAccountId: organizationId,
    defaultWorkspaceId: sharedWorkspaceId,
    accountGrants: [
      {
        accountId: organizationId,
        subjectId,
        permissions: ["account:read"],
        metadata: { accountName: "Northstar" },
      },
    ],
    workspaceGrants: [shared, personal].map((candidate) => ({
      workspaceId: candidate.id,
      accountId: candidate.accountId,
      subjectId: grantSubjectId,
      permissions: ["workspace:read", "sessions:read"],
    })),
  };
}

const selfContext = {
  identity: managedSelfContextIdentity({ credentialGeneration: 7, managedUserId: "managed-user" }),
  memberships: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      organizationId,
      status: "active" as const,
      personalWorkspaceId,
    },
  ],
};

describe("workspace scope context", () => {
  test("requires the server list and exact current-subject/account grant to agree", () => {
    expect(
      authorizedWorkspaceFromList({
        workspaceId: sharedWorkspaceId,
        workspaces: [shared],
        accessContext: access(),
      }),
    ).toEqual(shared);
    expect(
      authorizedWorkspaceFromList({
        workspaceId: sharedWorkspaceId,
        workspaces: [shared],
        accessContext: access("user:someone-else"),
      }),
    ).toBeNull();
    expect(
      authorizedWorkspaceFromList({
        workspaceId: sharedWorkspaceId,
        workspaces: [],
        accessContext: access(),
      }),
    ).toBeNull();
  });

  test("derives Organization, Workspace, and Personal facts from exact server tuples", () => {
    expect(
      resolveWorkspaceScopeContext({
        workspace: shared,
        workspaces: [shared, personal],
        accessContext: access(),
        managedSelfContext: selfContext,
      }),
    ).toEqual({
      organizationId,
      organizationLabel: "Northstar",
      workspaceId: sharedWorkspaceId,
      workspaceLabel: "Operations",
      workspaceKind: "shared",
      personalWorkspaceId,
    });

    expect(
      resolveWorkspaceScopeContext({
        workspace: personal,
        workspaces: [shared, personal],
        accessContext: access(),
        managedSelfContext: selfContext,
      })?.workspaceKind,
    ).toBe("personal");
  });

  test("fails closed for a mismatched grant or principal context", () => {
    expect(
      resolveWorkspaceScopeContext({
        workspace: shared,
        workspaces: [shared, personal],
        accessContext: access("user:someone-else"),
        managedSelfContext: selfContext,
      }),
    ).toBeNull();

    expect(
      resolveWorkspaceScopeContext({
        workspace: shared,
        workspaces: [shared, personal],
        accessContext: access(),
        managedSelfContext: {
          ...selfContext,
          identity: managedSelfContextIdentity({
            credentialGeneration: 8,
            managedUserId: "someone-else",
          }),
        },
      })?.personalWorkspaceId,
    ).toBeNull();
  });

  test("does not infer Personal from names or a pointer that is not authorized", () => {
    expect(
      resolveWorkspaceScopeContext({
        workspace: workspace(sharedWorkspaceId, "Personal"),
        workspaces: [shared],
        accessContext: access(),
        managedSelfContext: selfContext,
      }),
    ).toMatchObject({ workspaceKind: "shared", personalWorkspaceId: null });
  });

  test("a suspended organization membership does not link the canonical Personal workspace", () => {
    const suspended = {
      ...selfContext,
      memberships: [{ ...selfContext.memberships[0]!, status: "suspended" as const }],
    } as unknown as ManagedSelfContext;
    expect(
      resolveWorkspaceScopeContext({
        workspace: personal,
        workspaces: [shared, personal],
        accessContext: access(),
        managedSelfContext: suspended,
      }),
    ).toMatchObject({ workspaceKind: "personal", personalWorkspaceId: null });
  });
});

describe("external workspace access bootstrap", () => {
  const external = () => ({
    ...access(),
    subjectId: "external_user:11111111-1111-4111-8111-111111111111",
    workspaceGrants: [],
    defaultWorkspaceId: null,
  });
  const grant = (context: AccessContext) => ({
    workspaceId: personal.id,
    accountId: personal.accountId,
    subjectId: context.subjectId,
    permissions: ["workspace:read"],
  });
  test("uses the real selected-workspace grant before an external inventory row can become a landing target", async () => {
    const context = external();
    const reads: string[] = [];
    expect(
      authorizedWorkspaceFromList({
        workspaceId: personal.id,
        workspaces: [personal],
        accessContext: context,
      }),
    ).toBeNull();
    const next = await hydrateWorkspaceAccessContext({
      context,
      workspaces: [personal],
      isCurrent: () => true,
      readGrant: async (id) => {
        reads.push(id);
        return grant(context);
      },
    });
    expect(reads).toEqual([personal.id]);
    expect(next.workspaceGrants).toEqual([grant(context)]);
    expect(
      authorizedWorkspaceFromList({
        workspaceId: personal.id,
        workspaces: [personal],
        accessContext: next,
      }),
    ).toEqual(personal);
    expect(context.workspaceGrants).toEqual([]);
  });
  test.each(["subjectId", "accountId", "workspaceId"])(
    "rejects a mismatched %s without publishing a grant",
    async (key) => {
      const context = external();
      await expect(
        hydrateWorkspaceAccessContext({
          context,
          workspaces: [personal],
          isCurrent: () => true,
          readGrant: async () => ({
            ...grant(context),
            [key]: key === "subjectId" ? "user:other" : sharedWorkspaceId,
          }),
        }),
      ).rejects.toThrow();
      expect(context.workspaceGrants).toEqual([]);
    },
  );
  test("never replaces an already exact server grant with an extra lookup", async () => {
    const context = access();
    const next = await hydrateWorkspaceAccessContext({
      context,
      workspaces: [personal],
      isCurrent: () => true,
      readGrant: async () => {
        throw Error("unexpected lookup");
      },
    });
    expect(next).toBe(context);
  });
  test("a principal change during the scoped read refuses the whole projection", async () => {
    const context = external();
    let current = true;
    await expect(
      hydrateWorkspaceAccessContext({
        context,
        workspaces: [personal],
        isCurrent: () => current,
        readGrant: async () => {
          current = false;
          return grant(context);
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(context.workspaceGrants).toEqual([]);
  });
  test("an aborted bootstrap never starts a grant request", async () => {
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    await expect(
      hydrateWorkspaceAccessContext({
        context: external(),
        workspaces: [personal],
        signal: controller.signal,
        isCurrent: () => true,
        readGrant: async () => {
          reads++;
          return {};
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(0);
  });
});
