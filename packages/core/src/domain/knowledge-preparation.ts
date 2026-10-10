import {
  KnowledgeSavePreparationRequest,
  KnowledgeEntryListRequest,
  type KnowledgeSavePreparationResponse,
} from "@opengeni/contracts";
import {
  getKnowledgeEntry,
  listKnowledgeEntries,
  withRlsContext,
  isTransactionHandle,
  type Database,
  type KnowledgeContext,
} from "@opengeni/db";
import type { DocumentEmbedder } from "@opengeni/documents";
import type { Settings } from "@opengeni/config";
import { paidDocumentEmbedding } from "../billing/limits";
import { searchKnowledgeEntries, knowledgeQueryRetrievalRequest, type KnowledgeQueryExecution } from "./knowledge-search";

// Normal workspaces return the whole map in one call. Larger maps explicitly
// continue at a complete page boundary, never silently omit collections.
const CATALOG_PAGE_SIZE = 25;
const CATALOG_PAGE_BUDGET = 40;
const DESCRIPTION_CHARS = 2000;
const CATALOG_BYTES = 256 * 1024;

export async function prepareKnowledgeSave(
  db: Database,
  context: KnowledgeContext,
  input: KnowledgeSavePreparationRequest,
  embedder: () => DocumentEmbedder,
  services = { get: getKnowledgeEntry, list: listKnowledgeEntries, search: searchKnowledgeEntries },
  settings?: Settings,
  execution?: KnowledgeQueryExecution,
): Promise<KnowledgeSavePreparationResponse> {
  if (isTransactionHandle(db)) throw new Error("KNOWLEDGE_QUERY_REQUIRES_ROOT_DATABASE");
  const request = KnowledgeSavePreparationRequest.parse(input);
  if (context.actor.kind !== "agent" && !(context.actor.kind === "human" && context.actor.review)) {
    throw Object.assign(
      new Error("Preparing Knowledge requires a live agent or human Knowledge reviewer"),
      { code: "42501" },
    );
  }
  let provider: DocumentEmbedder | undefined;
  let queryEmbedding: Promise<number[]> | undefined;
  const sharedEmbedder = (): DocumentEmbedder => {
    provider ??= embedder();
    const current = provider;
    return {
      model: current.model,
      dimensions: current.dimensions,
      embedMany: (texts, completed, dispatch) => current.embedMany(texts, completed, dispatch),
      embedQuery: (query, completed, dispatch) => (queryEmbedding ??= current.embedQuery(query, completed, dispatch)),
    };
  };
  const collections: KnowledgeSavePreparationResponse["collections"] = {
    entries: [],
    complete: true,
    nextCursors: { published: null, needs_review: null },
  };
  // Search is independent of collection placement and always includes the
  // separate unapproved view. No authoring policy or write is invoked here.
  // Preparation returns BOTH views plus a catalog. A charge on the first
  // semantic search would precede the second view and catalog; any later
  // failure would leave no deliverable preparation result. Paid mode uses
  // keyword discovery until a single-operation settlement seam exists.
  const paid = settings != null && paidDocumentEmbedding(settings);
  const authorizedRead = <T>(read: (scoped: Database) => Promise<T>): Promise<T> => execution
    ? withRlsContext(db, context, async scoped => { await execution.authorize(scoped); return read(scoped); }, undefined, "none")
    : read(db);
  const publishedSearch = (searchDb: Database) => services.search(
    searchDb,
    context,
    {
      query: request.query,
      limit: request.limit,
      view: "published",
      ...(paid ? { mode: "keyword" as const } : {}),
    },
    sharedEmbedder,
    paid ? undefined : settings,
    execution,
  );
  // Semantic search owns its short admission/settlement transactions. Keyword
  // reads can stay in the current-authority transaction without provider I/O.
  const published = paid && execution ? await authorizedRead(scoped => services.list(scoped, context, {
    query: request.query, limit: request.limit, view: "published", mode: "keyword",
  })).then(found => ({ ...found, searchMode: "keyword" as const })) : await publishedSearch(db);
  const cachedValues = queryEmbedding && published.searchMode !== "keyword" ? await queryEmbedding : null;
  // One provider occurrence serves both views. Reuse its vector through the
  // installed reader rather than inventing another completed provider call.
  const needsReview = published.searchMode !== "keyword" && queryEmbedding && provider
    ? { ...await authorizedRead(scoped => services.list(scoped, context,
        knowledgeQueryRetrievalRequest(KnowledgeEntryListRequest.parse({ query: request.query, limit: request.limit, view: "needs_review", mode: published.searchMode })),
        { model: provider!.model, values: cachedValues! })), searchMode: published.searchMode }
    : execution ? { ...await authorizedRead(scoped => services.list(scoped, context, {
        query: request.query, limit: request.limit, view: "needs_review", mode: "keyword",
      })), searchMode: "keyword" as const }
    : await services.search(
    db,
    context,
    {
      query: request.query,
      limit: request.limit,
      view: "needs_review",
      ...(published.searchMode === "keyword" ? { mode: "keyword" as const } : {}),
    },
    sharedEmbedder,
    undefined,
    execution,
  );
  const matches = { published, needs_review: needsReview };
  for (const view of ["published", "needs_review"] as const) {
    if (request.collectionCursors && request.collectionCursors[view] === null) continue;
    let cursor = request.collectionCursors?.[view] ?? undefined;
    let bytes = 0;
    for (let pageNumber = 0; pageNumber < CATALOG_PAGE_BUDGET; pageNumber++) {
      const page = await authorizedRead(scoped => services.list(scoped, context, {
        kind: "group",
        view,
        limit: CATALOG_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }));
      const records: Array<Awaited<ReturnType<typeof getKnowledgeEntry>>> = [];
      for (let offset = 0; offset < page.entries.length; offset += 4) {
        records.push(
          ...(await Promise.all(
            page.entries
              .slice(offset, offset + 4)
              .map((summary) => authorizedRead(scoped => services.get(scoped, context, summary.id, { view }))),
          )),
        );
      }
      for (const record of records) {
        // Re-read the current view: an exact historical revision may remain
        // readable after replacement and must not be called the current map.
        if (
          !record ||
          record.archived ||
          record.revision.entry.kind !== "group" ||
          record.revision.outcome !== (view === "published" ? "published" : "pending")
        )
          continue;
        const entry = record.revision.entry;
        const descriptor = {
          id: record.id,
          revisionId: record.revision.id,
          version: record.version,
          scope: record.scope,
          view,
          title: entry.title,
          description: entry.content.slice(0, DESCRIPTION_CHARS),
          descriptionTruncated: entry.content.length > DESCRIPTION_CHARS,
          parentIds: entry.groupIds,
        };
        collections.entries.push(descriptor);
        bytes += Buffer.byteLength(JSON.stringify(descriptor), "utf8");
      }
      cursor = page.nextCursor ?? undefined;
      if (!cursor || bytes >= CATALOG_BYTES) break;
    }
    collections.nextCursors[view] = cursor ?? null;
    if (cursor) collections.complete = false;
  }
  return { collections, matches };
}
