import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as database from "@opengeni/db";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import * as dataTools from "../src/site-publishing/agent-data-tools";
import { normalizeSiteAgentSession } from "../src/site-publishing/agent-session";
import type { SiteRuntimeHost } from "../src/site-publishing/runtime";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const lease = await acquireSharedTestDatabase("site-agent-session-host");
  if (!lease) throw new Error("PostgreSQL unavailable");
  shared = lease;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
test("Site data-tool refresh writer preserves host-required eager servers", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "site-host-test",
    accountExternalId: suffix,
    accountName: "Site host",
    workspaceExternalSource: "site-host-test",
    workspaceExternalId: suffix,
    workspaceName: "Site host",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const siteId = crypto.randomUUID();
  const principal = `guest:${suffix}`;
  const now = new Date();
  const host: SiteRuntimeHost = {
    domain: "example.test",
    label: "test",
    hostname: "test.example.test",
    scope: { accountId: grant.accountId, workspaceId: grant.workspaceId },
    site: {
      id: siteId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      title: "Test Site",
      status: "active",
      visibility: "workspace_shared",
      ownerSubjectId: null,
      createdBySubjectId: grant.subjectId,
      currentVersionId: null,
    },
    publication: {
      siteId,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      label: "test",
      access: "public",
      status: "active",
      noindex: true,
      agent: { enabled: true, model: null, instructions: null, tools: null, guestTools: true },
      limitProfile: null,
      invitedEmails: [],
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
      suspendedBySubject: null,
      generation: 1,
      edgeSyncedGeneration: 1,
      scanStatus: "none",
      scanFindings: null,
      scannedVersionId: null,
      scannedAt: null,
      createdBy: grant.subjectId,
      updatedBy: grant.subjectId,
      createdAt: now,
      updatedAt: now,
    },
  };
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Site chat",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    tools: [{ kind: "mcp", id: "host", eager: true }],
    toolPolicy: {
      mode: "workspace_default",
      inheritedFromSessionId: null,
      hostRequiredMcpServerIds: ["host"],
    },
  });
  const resolution = spyOn(dataTools, "resolveSiteAgentDataContext").mockResolvedValue({
    kind: "site",
    siteId,
    viewerKind: "guest",
    viewer: {
      kind: "published_viewer",
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      site: host.site,
      principal,
      guest: true,
    },
    profileKind: "standard",
    guestWrite: async () => null,
  });
  const writer = spyOn(database, "appendSessionEventsWithLockedSessionUpdate").mockImplementation(
    async (_db, _workspace, _session, prepare) => {
      const proposal = await prepare({
        ...session,
        createdBy: { kind: "service", subjectId: `site:${siteId}` },
        metadata: { _opengeniSiteOrigin: { siteId, title: "Test Site" } },
      });
      expect(proposal.update?.toolPolicy?.hostRequiredMcpServerIds).toEqual(["host"]);
      expect(proposal.update?.tools).toContainEqual({ kind: "mcp", id: "host", eager: true });
      return [];
    },
  );
  try {
    await normalizeSiteAgentSession(
      { db: client.db, settings: testSettings(), bus: new MemoryEventBus(), objectStorage: null },
      host,
      { kind: "guest", principal, subjectId: null, name: null, email: null, sessionId: null },
      session.id,
      [],
    );
  } finally {
    resolution.mockRestore();
    writer.mockRestore();
  }
});
