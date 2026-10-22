import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { OrganizationMember } from "@opengeni/contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "../src/database";
import * as database from "../src/database";
import * as memberships from "../src/organization-membership-lifecycle";
import * as authority from "../src/workspace-authority";
import { namedSubjectPersonalWorkspaceId } from "../src/slack-routing-personal-workspace";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const externalSubjectId = "external_user:33333333-3333-4333-8333-333333333333";
const previousSubjectId = "api_key:44444444-4444-4444-8444-444444444444";
const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture(subjectId = externalSubjectId) {
  const member = OrganizationMember.parse({
    id: "55555555-5555-4555-8555-555555555555",
    organizationId: accountId,
    subjectId,
    role: "owner",
    status: "active",
    authorizationRevision: 1,
    personalWorkspaceId: workspaceId,
    revokedAt: null,
    personalRetentionUntil: null,
    createdAt: "2026-10-22T00:00:00Z",
    updatedAt: "2026-10-22T00:00:00Z",
  });
  const lookup = track(
    spyOn(memberships, "listSelfOrganizationMemberships").mockResolvedValue([member]),
  );
  const previous = track(
    spyOn(authority, "rlsSubjectIdOrEmpty").mockResolvedValue(previousSubjectId),
  );
  const execute = mock(async (_query: SQL) => []);
  const db = { execute } as unknown as Database;
  let accountScoped = false;
  const scope = track(
    spyOn(database, "withRlsContext").mockImplementation(async (caller, context, run) => {
      expect(caller).toBe(db);
      expect(context).toEqual({ accountId, workspaceId: null });
      accountScoped = true;
      try {
        return await run(db);
      } finally {
        accountScoped = false;
      }
    }),
  );
  return {
    member,
    lookup,
    previous,
    execute,
    db,
    scope,
    get accountScoped() {
      return accountScoped;
    },
  };
}
function expectRestored(execute: ReturnType<typeof fixture>["execute"]) {
  expect(execute).toHaveBeenCalledTimes(1);
  const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
  expect(query.sql).toBe("select set_config('opengeni.subject_id', $1, true)");
  expect(query.params).toEqual([previousSubjectId]);
}
for (const subjectId of [externalSubjectId, "user:managed-owner"]) {
  test(`named Personal pointer supports authenticated ${subjectId.split(":")[0]} owners`, async () => {
    const { db, lookup, execute } = fixture(subjectId);
    expect(await namedSubjectPersonalWorkspaceId(db, { accountId, subjectId })).toBe(workspaceId);
    expect(lookup).toHaveBeenCalledWith(db, subjectId);
    expectRestored(execute);
  });
}
for (const subjectId of [
  "api_key:key",
  "service:worker",
  "configured:local",
  "user:",
  "external_user:",
]) {
  test(`non-human or empty subject ${subjectId} cannot resolve a Personal pointer`, async () => {
    const { db, lookup, previous, execute } = fixture();
    expect(await namedSubjectPersonalWorkspaceId(db, { accountId, subjectId })).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(previous).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
}
for (const patch of [
  { status: "revoked" as const },
  { status: "suspended" as const },
  { organizationId: workspaceId },
  { personalWorkspaceId: null },
]) {
  test(`external Personal pointer refuses ${JSON.stringify(patch)}`, async () => {
    const { db, member, lookup, execute } = fixture();
    lookup.mockResolvedValue([OrganizationMember.parse({ ...member, ...patch })]);
    expect(
      await namedSubjectPersonalWorkspaceId(db, { accountId, subjectId: externalSubjectId }),
    ).toBeNull();
    expectRestored(execute);
  });
}
test("a live membership guard failure restores scope and preserves its diagnostic", async () => {
  const { db, lookup, execute } = fixture();
  const denied = Object.assign(new Error("membership no longer active"), { code: "42501" });
  lookup.mockRejectedValue(denied);
  execute.mockRejectedValue(new Error("aborted transaction"));
  await expect(
    namedSubjectPersonalWorkspaceId(db, { accountId, subjectId: externalSubjectId }),
  ).rejects.toBe(denied);
  expectRestored(execute);
});

test("external Personal lookup installs its account scope before the native membership guard", async () => {
  const f = fixture();
  f.lookup.mockImplementation(async () => {
    if (!f.accountScoped)
      throw Object.assign(new Error("managed human subject authority required"), { code: "42501" });
    return [f.member];
  });
  expect(
    await namedSubjectPersonalWorkspaceId(f.db, { accountId, subjectId: externalSubjectId }),
  ).toBe(workspaceId);
  expect(f.scope).toHaveBeenCalledTimes(1);
  expect(f.accountScoped).toBe(false);
  expectRestored(f.execute);
});
