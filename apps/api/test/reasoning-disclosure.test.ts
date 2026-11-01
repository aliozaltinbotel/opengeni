import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type SessionEvent } from "@opengeni/contracts";
import type { OrganizationGovernancePort } from "@opengeni/contracts/organization-governance";
import {
  organizationReasoningDisclosure,
  withholdSessionEventReasoning,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  type AccessGrant,
  type DbClient,
} from "@opengeni/db";
import { SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION, type EventBus } from "@opengeni/events";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { registerSessionRoutes } from "../src/routes/sessions";

/**
 * `OrganizationGovernancePort.reasoningDisclosure: "withheld"`: a governed
 * organization's readers never receive the provider's reasoning text, on any
 * server read, while every other organization (and every deployment without
 * the field) is unchanged.
 */
const SECRET = "reasoning-disclosure-test-secret";
const MARKER = "SYNTHETIC-REASONING-MARKER-0001";

const bus = {
  sessionEventDurableFanout: {
    version: SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION,
    subscribeRecovery: () => () => {},
  },
  subscribe: async () => () => {},
  publish: async () => undefined,
} as unknown as EventBus;

type Fixture = { grant: AccessGrant; sessionId: string; authorization: string };

let shared: SharedTestDatabase;
let client: DbClient;
let governed: Fixture;
let ungoverned: Fixture;

function port(disclosure: OrganizationGovernancePort["reasoningDisclosure"]) {
  return {
    governs: ({ organizationId }: { organizationId: string }) =>
      organizationId === governed.grant.accountId,
    decide: () => "refuse" as const,
    ...(disclosure ? { reasoningDisclosure: disclosure } : {}),
  } satisfies OrganizationGovernancePort;
}

function deps(organizationGovernance: OrganizationGovernancePort | null): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: SECRET,
    }),
    db: client.db,
    bus,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    ...(organizationGovernance ? { organizationGovernance } : {}),
  } as unknown as ApiRouteDeps;
}

async function fixture(name: string): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `${name}-account-${suffix}`,
    accountName: `${name} account`,
    workspaceExternalSource: "test",
    workspaceExternalId: `${name}-workspace-${suffix}`,
    workspaceName: `${name} workspace`,
    subjectId: `user:${name}-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Is unit 4 ready for arrival?",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await appendSessionEvents(client.db, grant.workspaceId, session.id, [
    { type: "agent.reasoning.delta", payload: { text: `${MARKER} first` } },
    { type: "agent.reasoning.delta", payload: { text: `${MARKER} second` } },
    { type: "agent.message.completed", payload: { text: "Unit 4 is ready." } },
  ]);
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  return { grant, sessionId: session.id, authorization };
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("reasoning-disclosure");
  if (!acquired) throw new Error("reasoning disclosure tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
  governed = await fixture("reasoning-governed");
  ungoverned = await fixture("reasoning-ungoverned");
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function app(organizationGovernance: OrganizationGovernancePort | null): Hono {
  const hono = new Hono();
  registerSessionRoutes(hono, deps(organizationGovernance));
  return hono;
}

async function listEvents(hono: Hono, who: Fixture, query: string): Promise<SessionEvent[]> {
  const response = await hono.request(
    `http://x/v1/workspaces/${who.grant.workspaceId}/sessions/${who.sessionId}/events?${query}`,
    { headers: { authorization: who.authorization } },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as SessionEvent[];
}

function sseEvents(body: string): SessionEvent[] {
  return body
    .split("\n\n")
    .flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data: ")))
    .map((line) => JSON.parse(line.slice(6)) as SessionEvent);
}

/** Reads the live stream until the final message frame, then disconnects. */
async function streamEvents(hono: Hono, who: Fixture, transport?: string): Promise<SessionEvent[]> {
  const abort = new AbortController();
  const response = await hono.request(
    `http://x/v1/workspaces/${who.grant.workspaceId}/sessions/${who.sessionId}/events/stream?after=0${
      transport ? `&transport=${transport}` : ""
    }`,
    { headers: { authorization: who.authorization }, signal: abort.signal },
  );
  expect(response.status).toBe(200);
  if (transport) return sseEvents(await response.text());
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!sseEvents(text).some((event) => event.type === "agent.message.completed")) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel();
    abort.abort();
  }
  return sseEvents(text);
}

function mcpServer(organizationGovernance: OrganizationGovernancePort | null, who: Fixture) {
  return buildOpenGeniMcpServer(deps(organizationGovernance), who.grant);
}

async function callMcpTool<T>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) throw new Error(`MCP tool returned no text: ${name}`);
  return JSON.parse(text) as T;
}

/** Every read a reader can make of the session's reasoning events. */
async function everyRead(
  organizationGovernance: OrganizationGovernancePort | null,
  who: Fixture,
): Promise<Record<string, SessionEvent[]>> {
  const hono = app(organizationGovernance);
  const reasoning = "includeTypes=agent.reasoning.delta";
  const mcp = mcpServer(organizationGovernance, who);
  return {
    forensic: await listEvents(hono, who, `mode=forensic&payloadMode=full&after=0`),
    forensicReasoningOnly: await listEvents(hono, who, `mode=forensic&after=0&${reasoning}`),
    compact: await listEvents(hono, who, `after=0&compact=true`),
    summary: await listEvents(hono, who, `mode=forensic&payloadMode=summary&after=0`),
    streamBatch: await streamEvents(hono, who, "http1-bounded"),
    streamLive: await streamEvents(hono, who),
    mcpDebug: (
      await callMcpTool<{ events: SessionEvent[] }>(mcp, "session_events", {
        sessionId: who.sessionId,
        view: "debug",
        mode: "forensic",
        payloadMode: "full",
        after: 0,
        direction: "after",
      })
    ).events,
    mcpDebugReasoningOnly: (
      await callMcpTool<{ events: SessionEvent[] }>(mcp, "session_events", {
        sessionId: who.sessionId,
        view: "debug",
        mode: "forensic",
        after: 0,
        direction: "after",
        includeTypes: ["agent.reasoning.delta"],
      })
    ).events,
  };
}

function reasoningEvents(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event) => event.type === "agent.reasoning.delta");
}

describe("reasoning disclosure", () => {
  test("a withheld organization receives no reasoning text over any read, at the same sequences", async () => {
    const reads = await everyRead(port("withheld"), governed);
    for (const [read, events] of Object.entries(reads)) {
      expect({ read, leaked: JSON.stringify(events).includes(MARKER) }).toEqual({
        read,
        leaked: false,
      });
      const reasoning = reasoningEvents(events);
      expect({ read, count: reasoning.length > 0 }).toEqual({ read, count: true });
      for (const event of reasoning)
        expect({ read, text: (event.payload as Record<string, unknown>).text }).toEqual({
          read,
          text: undefined,
        });
    }
    // Cursors are untouched: the reasoning rows keep their place, and the
    // answer still arrives.
    expect(reasoningEvents(reads.forensic!).map((event) => event.sequence)).toEqual(
      reasoningEvents(await listEvents(app(null), governed, "mode=forensic&after=0")).map(
        (event) => event.sequence,
      ),
    );
    for (const events of Object.values(reads).filter((page) =>
      page.some((event) => event.type === "agent.message.completed"),
    ))
      expect(events.find((event) => event.type === "agent.message.completed")?.payload).toEqual({
        text: "Unit 4 is ready.",
      });
    // A coalesced run keeps its numeric coverage and nothing else.
    expect(reasoningEvents(reads.compact!)).toEqual([
      expect.objectContaining({ payload: { coalescedUntil: expect.any(Number) } }),
    ]);
  }, 60_000);

  test("the forensic page says it is not exact when reasoning was withheld", async () => {
    const response = await app(port("withheld")).request(
      `http://x/v1/workspaces/${governed.grant.workspaceId}/sessions/${governed.sessionId}/events?mode=forensic&payloadMode=full&after=0`,
      { headers: { authorization: governed.authorization } },
    );
    expect(response.headers.get("X-OpenGeni-Forensic-Exact")).toBe("false");
  });

  test("an organization the host does not govern keeps the reasoning text", async () => {
    const reads = await everyRead(port("withheld"), ungoverned);
    for (const [read, events] of Object.entries(reads))
      expect({ read, shown: JSON.stringify(events).includes(MARKER) }).toEqual({
        read,
        shown: true,
      });
  }, 60_000);

  test("full, an unset field and no port are the stock behaviour", async () => {
    for (const organizationGovernance of [port("full"), port(undefined), null]) {
      const reads = await everyRead(organizationGovernance, governed);
      for (const [read, events] of Object.entries(reads))
        expect({ read, shown: JSON.stringify(events).includes(MARKER) }).toEqual({
          read,
          shown: true,
        });
    }
  }, 120_000);

  test("the disclosure answer follows the port and the organization", async () => {
    const base = { db: client.db };
    expect(
      await organizationReasoningDisclosure(
        { ...base, organizationGovernance: port("withheld") },
        governed.grant.accountId,
      ),
    ).toBe("withheld");
    expect(
      await organizationReasoningDisclosure(
        { ...base, organizationGovernance: port("withheld") },
        ungoverned.grant.accountId,
      ),
    ).toBe("full");
    expect(
      await organizationReasoningDisclosure(
        { ...base, organizationGovernance: port("full") },
        governed.grant.accountId,
      ),
    ).toBe("full");
    expect(
      await organizationReasoningDisclosure(
        { ...base, organizationGovernance: null },
        governed.grant.accountId,
      ),
    ).toBe("full");
    // A port that breaks its contract fails the read closed.
    await expect(
      organizationReasoningDisclosure(
        {
          ...base,
          organizationGovernance: {
            ...port("withheld"),
            governs: () => Promise.resolve(true) as unknown as boolean,
          },
        },
        governed.grant.accountId,
      ),
    ).rejects.toThrow("must return a boolean");
  });
});

describe("withholdSessionEventReasoning", () => {
  const base = { id: "e", workspaceId: "w", sessionId: "s", occurredAt: "t" };
  test("removes the reasoning text and keeps only numeric coverage", () => {
    expect(
      withholdSessionEventReasoning({
        ...base,
        sequence: 4,
        type: "agent.reasoning.delta",
        payload: { text: MARKER, coalescedUntil: 9, extra: MARKER },
      }),
    ).toEqual({
      ...base,
      sequence: 4,
      type: "agent.reasoning.delta",
      payload: { coalescedUntil: 9 },
    });
    expect(
      withholdSessionEventReasoning({
        ...base,
        sequence: 4,
        type: "agent.reasoning.delta",
        payload: { text: MARKER, coalescedUntil: "9" },
      }).payload,
    ).toEqual({});
  });
  test("returns every other event unchanged", () => {
    const message = {
      ...base,
      sequence: 5,
      type: "agent.message.completed",
      payload: { text: "answer" },
    };
    expect(withholdSessionEventReasoning(message)).toBe(message);
  });
});
