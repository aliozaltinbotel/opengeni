import { expect, test } from "bun:test";
import type { AccessGrant, SessionAuthorizationPort } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import {
  requireSessionCreateAuthorization,
  SessionCreateAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
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
