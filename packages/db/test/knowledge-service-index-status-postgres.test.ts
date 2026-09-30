import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  appendKnowledgeIndexChunks,
  claimKnowledgeIndexJobs,
  completeKnowledgeIndexJob,
  createDb,
  getKnowledgeEntry,
  listKnowledgeEntries,
  saveKnowledgeEntry,
  type KnowledgeContext,
} from "../src";
import { rawRows, withWorkspaceSubjectRls } from "../src/database";

// A service principal (an organization or workspace API key, a configured key, the MCP gateway, or a host's
// in-process service reader) reads published Knowledge. Every source entry on a page gets its index status from
// knowledge_visible_index_status, which re-checks each exact revision through knowledge_entry_read and so resolves
// the actor once per item. knowledge_resolve_actor checks a service actor's subject against opengeni.subject_id and
// then clears it for the rest of the transaction (a service never reads personal Knowledge), so the second item of
// one call was refused 42501 and every list or search whose page held two or more sources answered 403.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const otherWorkspaceId = crypto.randomUUID();
const ownerSubject = `user:${crypto.randomUUID()}`;
const SERVICE_PRINCIPALS = ["service", "api_key", "configured_key", "mcp_gateway"] as const;

const human = (workspace: string, subjectId = ownerSubject): KnowledgeContext => ({
  accountId,
  workspaceId: workspace,
  actor: {
    kind: "human",
    principalKind: "human_session",
    subjectId,
    writeScopes: ["workspace", "personal"],
    settingsScopes: ["workspace", "personal"],
    review: true,
  },
});
const service = (
  principalKind: (typeof SERVICE_PRINCIPALS)[number],
  subjectId = `api_key:${crypto.randomUUID()}`,
  workspace = workspaceId,
): KnowledgeContext => ({
  accountId,
  workspaceId: workspace,
  actor: {
    kind: "service",
    principalKind,
    subjectId,
    writeScopes: [],
    review: false,
    settingsScopes: [],
  },
});

const ids: Record<
  "parkingGuide" | "parkingRules" | "plumbing" | "personalParking" | "otherWorkspace",
  {
    entryId: string;
    revisionId: string;
  }
> = {} as never;

async function saveSource(
  context: KnowledgeContext,
  scope: "workspace" | "personal",
  title: string,
  content: string,
) {
  const receipt = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope,
    entry: {
      kind: "source",
      title,
      content,
      source: { kind: "manual" },
      evidence: [],
      groupIds: [],
      relationships: [],
    },
  });
  return { entryId: receipt.entryId, revisionId: receipt.revisionId };
}

/** Index every queued revision the way the projection worker does (three-dimensional test vectors). */
async function indexAll() {
  for (;;) {
    const claims = await claimKnowledgeIndexJobs(client.db, {
      model: "service-status-test",
      dimensions: 3,
      limit: 20,
    });
    if (!claims.length) return;
    for (const claim of claims) {
      await appendKnowledgeIndexChunks(client.db, claim, claim.nextIndex, [
        {
          index: claim.nextIndex,
          field: "content",
          start: 0,
          end: 4,
          text: "text",
          embedding: [1, 0, 0],
        },
      ]);
      expect((await completeKnowledgeIndexJob(client.db, claim, claim.nextIndex + 1)).status).toBe(
        "ready",
      );
    }
  }
}

/** The status projection called directly, exactly as a Knowledge read's own transaction calls it. */
async function visibleIndexStatus(
  context: KnowledgeContext,
  items: Array<{ entryId: string; revisionId: string }>,
  transactionSubject = context.actor.kind === "agent" ? "" : context.actor.subjectId,
  transactionPrincipal = context.actor.kind === "agent"
    ? "agent_attempt"
    : context.actor.principalKind,
) {
  return withWorkspaceSubjectRls(client.db, context.workspaceId, transactionSubject, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('opengeni.principal_kind', ${transactionPrincipal}, true)`,
    );
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`SELECT knowledge_visible_index_status(${context.accountId}::uuid,${context.workspaceId}::uuid,
        ${JSON.stringify(context.actor)}::jsonb,${JSON.stringify(items)}::jsonb,'published') AS result`,
    );
    return row?.result as Array<{ entryId: string; revisionId: string; status: string }>;
  });
}

/** The SQLSTATE a call was refused with; undefined when it answered. */
const refusedWith = async (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => undefined,
    (error: unknown) => sqlState(error) ?? "NOT_A_DATABASE_REFUSAL",
  );
const sqlState = (error: unknown): string | undefined => {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
};

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-service-index-status");
  if (!acquired) throw new Error("Service Knowledge index status verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Service index status')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Service reads')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${otherWorkspaceId},${accountId},'Another workspace')`;
  ids.parkingGuide = await saveSource(
    human(workspaceId),
    "workspace",
    "Check-in guide",
    "Free street parking in front of the building; the public car park is behind the market.",
  );
  ids.parkingRules = await saveSource(
    human(workspaceId),
    "workspace",
    "House rules",
    "Quiet hours from 22:00. Parking on the pavement is not allowed.",
  );
  ids.plumbing = await saveSource(
    human(workspaceId),
    "workspace",
    "Maintenance contacts",
    "Plumbing: the synthetic plumber visits on weekdays.",
  );
  // Readable by its owner only: a service never reads personal Knowledge, whatever subject it carries.
  ids.personalParking = await saveSource(
    human(workspaceId),
    "personal",
    "My parking notes",
    "Parking permit number and my own parking spot.",
  );
  // Another workspace of the same account: never in this workspace's reads.
  ids.otherWorkspace = await saveSource(
    human(otherWorkspaceId),
    "workspace",
    "Other building",
    "Parking at the other building is underground.",
  );
  await indexAll();
}, 900_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const byId = (entries: Array<{ id: string; indexStatus?: string | undefined }>) =>
  Object.fromEntries(entries.map((entry) => [entry.id, entry.indexStatus ?? null]));

describe("a service principal reads published Knowledge whose page holds several sources", () => {
  for (const principalKind of SERVICE_PRINCIPALS) {
    test(`${principalKind}: a search whose hits hold two sources answers both, indexed`, async () => {
      const found = await listKnowledgeEntries(client.db, service(principalKind), {
        query: "parking",
        mode: "keyword",
        kind: "source",
        scope: "workspace",
        view: "published",
      });
      expect(byId(found.entries)).toEqual({
        [ids.parkingGuide.entryId]: "indexed",
        [ids.parkingRules.entryId]: "indexed",
      });
    });
  }

  test("a search whose hits hold one source answers it, indexed", async () => {
    const found = await listKnowledgeEntries(client.db, service("api_key"), {
      query: "plumbing",
      mode: "keyword",
      kind: "source",
      view: "published",
    });
    expect(byId(found.entries)).toEqual({ [ids.plumbing.entryId]: "indexed" });
  });

  test("an unfiltered list of every source answers each, indexed", async () => {
    const found = await listKnowledgeEntries(client.db, service("service"), {
      kind: "source",
      view: "published",
      limit: 50,
    });
    expect(byId(found.entries)).toEqual({
      [ids.parkingGuide.entryId]: "indexed",
      [ids.parkingRules.entryId]: "indexed",
      [ids.plumbing.entryId]: "indexed",
    });
  });

  test("a human reads the same page (the human branch never consumed its subject)", async () => {
    const found = await listKnowledgeEntries(client.db, human(workspaceId), {
      query: "parking",
      mode: "keyword",
      kind: "source",
      scope: "workspace",
      view: "published",
    });
    expect(byId(found.entries)).toEqual({
      [ids.parkingGuide.entryId]: "indexed",
      [ids.parkingRules.entryId]: "indexed",
    });
  });
});

describe("nothing a service could not read before becomes readable", () => {
  test("another subject's personal source stays invisible, even to a service carrying the owner's subject", async () => {
    for (const subjectId of [ownerSubject, `api_key:${crypto.randomUUID()}`]) {
      const context = service("api_key", subjectId);
      const found = await listKnowledgeEntries(client.db, context, {
        query: "parking",
        mode: "keyword",
        kind: "source",
        view: "published",
      });
      expect(found.entries.map((entry) => entry.id)).not.toContain(ids.personalParking.entryId);
      expect(await getKnowledgeEntry(client.db, context, ids.personalParking.entryId)).toBeNull();
      // The status projection answers nothing for an item the actor may not read.
      expect(await visibleIndexStatus(context, [ids.personalParking])).toEqual([]);
    }
    // Its owner reads it: the entry exists and is indexed.
    expect(
      (await getKnowledgeEntry(client.db, human(workspaceId), ids.personalParking.entryId))
        ?.indexStatus,
    ).toBe("indexed");
  });

  test("another workspace's source stays out of this workspace's reads", async () => {
    const found = await listKnowledgeEntries(client.db, service("api_key"), {
      query: "parking",
      mode: "keyword",
      kind: "source",
      view: "published",
    });
    expect(found.entries.map((entry) => entry.id)).not.toContain(ids.otherWorkspace.entryId);
    expect(
      await getKnowledgeEntry(client.db, service("api_key"), ids.otherWorkspace.entryId),
    ).toBeNull();
    expect(await visibleIndexStatus(service("api_key"), [ids.otherWorkspace])).toEqual([]);
  });

  test("a service actor whose subject or principal differs from the transaction's is still refused", async () => {
    const context = service("api_key", "api_key:claimed");
    expect(
      await refusedWith(visibleIndexStatus(context, [ids.parkingGuide], "api_key:authenticated")),
    ).toBe("42501");
    expect(
      await refusedWith(
        visibleIndexStatus(context, [ids.parkingGuide], "api_key:claimed", "configured_key"),
      ),
    ).toBe("42501");
    // The same actor under its own subject and principal answers.
    expect(
      (await visibleIndexStatus(context, [ids.parkingGuide])).map((item) => item.status),
    ).toEqual(["indexed"]);
  });
});

// The mechanism, pinned. If knowledge_visible_index_status ever resolves a service actor once per call, this test
// fails, and the host's one-item-per-call read in withIndexStatus can return to a single call.
test("the status projection resolves a service actor once per item and so answers one item per call", async () => {
  const context = service("api_key");
  expect(
    (await visibleIndexStatus(context, [ids.parkingGuide])).map((item) => item.status),
  ).toEqual(["indexed"]);
  expect(await refusedWith(visibleIndexStatus(context, [ids.parkingGuide, ids.parkingRules]))).toBe(
    "42501",
  );
});
