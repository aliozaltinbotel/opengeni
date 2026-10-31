import { expect, test } from "bun:test";
import type { AccessGrant, SessionAuthorizationPort } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import {
  requireSessionCreateAuthorization,
  SessionCreateAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  withSessionCreateHostDeadline,
} from "../src/session-authorization";
const grant: AccessGrant = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  subjectId: "user:creator",
  principalKind: "human_session",
  permissions: ["sessions:create"],
};
const port: SessionAuthorizationPort = {
  authorizeSession: async () => ({ allowed: true }),
  resolveListScope: async () => ({ kind: "all" }),
  authorizeSessionCreate: async () => ({
    allowed: true,
    requiredToolServers: [{ id: "internal" }],
  }),
};
test("create decision retains the authenticated actor and configured internal required tools", async () => {
  const result = await requireSessionCreateAuthorization(
    { db: {} as Database, sessionAuthorization: port },
    grant,
    "core",
    [{ id: "internal" }],
  );
  expect(result?.decision).toEqual({ allowed: true, requiredToolServers: [{ id: "internal" }] });
  expect(result?.actor).toMatchObject({ kind: "subject", subjectId: grant.subjectId });
});
test("unknown host-required tools make the entire create decision unreadable", async () => {
  await expect(
    requireSessionCreateAuthorization(
      { db: {} as Database, sessionAuthorization: port },
      grant,
      "core",
      [],
    ),
  ).rejects.toBeInstanceOf(SessionAuthorizationUnavailableError);
});

test("create denial has a distinct envelope identity from source-session denial", async () => {
  await expect(
    requireSessionCreateAuthorization(
      {
        db: {} as Database,
        sessionAuthorization: {
          ...port,
          authorizeSessionCreate: async () => ({ allowed: false, reason: "revoked" }),
        },
      },
      grant,
      "http",
      [],
    ),
  ).rejects.toBeInstanceOf(SessionCreateAuthorizationDeniedError);
});

test("legacy create authorization methods retain their port receiver", async () => {
  const receiverPort = {
    marker: "host-port",
    ...port,
    async authorizeSessionCreate() {
      if (this.marker !== "host-port") throw new Error("receiver lost");
      return { allowed: true as const };
    },
  };
  await expect(
    requireSessionCreateAuthorization(
      { db: {} as Database, sessionAuthorization: receiverPort },
      grant,
      "http",
      [],
    ),
  ).resolves.toMatchObject({ decision: { allowed: true } });
});

test("create hooks receive request-local proof without projecting its credential", async () => {
  const creator = {
    principalKind: "human_session" as const,
    readCredential: async () => "test-proof",
  };
  let received: unknown;
  await requireSessionCreateAuthorization(
    {
      db: {} as Database,
      sessionAuthorization: {
        ...port,
        authorizeSessionCreate: async (input) => {
          received = input.creator;
          return { allowed: true };
        },
      },
    },
    grant,
    "http",
    [],
    creator,
  );
  expect(received).toBe(creator);
  expect(JSON.stringify(received)).not.toContain("test-proof");
});

test.each(["service", "api_key", "configured_key", undefined] as const)(
  "create classification preserves %s instead of promoting its subject to human",
  async (principalKind) => {
    let received: unknown;
    await requireSessionCreateAuthorization(
      {
        db: {} as Database,
        sessionAuthorization: {
          ...port,
          authorizeSessionCreate: async (input) => {
            received = input.creator;
            return { allowed: true };
          },
        },
      },
      { ...grant, principalKind },
      "core",
    );
    expect(received).toEqual({ principalKind: principalKind ?? null });
  },
);

test("non-human or mismatched grant provenance cannot carry human credential proof", async () => {
  for (const principalKind of ["service", "configured_key", undefined] as const) {
    await expect(
      requireSessionCreateAuthorization(
        { db: {} as Database, sessionAuthorization: port },
        { ...grant, principalKind },
        "http",
        [],
        { principalKind: principalKind ?? null, readCredential: async () => "fake" },
      ),
    ).rejects.toBeInstanceOf(SessionAuthorizationUnavailableError);
  }
  await expect(
    requireSessionCreateAuthorization(
      { db: {} as Database, sessionAuthorization: port },
      grant,
      "http",
      [],
      { principalKind: "service" },
    ),
  ).rejects.toBeInstanceOf(SessionAuthorizationUnavailableError);
});

test("create callback failures discard credential-bearing host exceptions", async () => {
  const failure = await withSessionCreateHostDeadline(async () => {
    throw new Error("fake-private-credential");
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SessionAuthorizationUnavailableError);
  expect(String(failure)).not.toContain("fake-private-credential");
  expect((failure as Error).cause).toBeUndefined();
});
