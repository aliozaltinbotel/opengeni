import { deflateSync } from "node:zlib";
import { configuredModels } from "@opengeni/config";
import { consumeInlineImages, readInlineImageDescriptor } from "@opengeni/runtime";
import { listSessionTurns } from "@opengeni/db";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { createActivityTestHarness } from "../../apps/worker/src/activities";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import {
  createDb,
  requireSession,
  getSessionHistoryItems,
  listSessionEvents,
  dbSql,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import { testSettings } from "@opengeni/testing";
import { type InlineImagePart } from "@opengeni/contracts";
const databaseUrl = process.env.PQA_IMAGE_DATABASE_URL!;
const natsUrl = process.env.PQA_IMAGE_NATS_URL!;
if (!databaseUrl || !natsUrl) throw new Error("Exact owned PG17/NATS fixture URLs are required");
const admin = createDb(databaseUrl);
let client: ReturnType<typeof createDb>, bus: EventBus, provider: ReturnType<typeof Bun.serve>;
const requests: Record<string, unknown>[] = [];
const controlCode = "7Q2K9F";
function controlPng(): Buffer {
  const glyphs: Record<string, string[]> = {
    "7": ["111", "001", "010", "010", "010"],
    Q: ["111", "101", "101", "111", "001"],
    "2": ["111", "001", "111", "100", "111"],
    K: ["101", "110", "100", "110", "101"],
    "9": ["111", "101", "111", "001", "111"],
    F: ["111", "100", "110", "100", "100"],
  };
  const scale = 4,
    width = controlCode.length * 4 * scale,
    height = 7 * scale;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const index = Math.floor(x / (4 * scale)),
        column = Math.floor(x / scale) % 4,
        row = Math.floor(y / scale) - 1;
      if (row >= 0 && row < 5 && column < 3 && glyphs[controlCode[index]!]![row]![column] === "1")
        pixels.fill(0, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 1 + x * 3 + 3);
    }
  }
  const chunk = (type: string, bytes: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const head = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    head.writeUInt32BE(bytes.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const photo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII=",
  "base64",
);
const images: InlineImagePart[] = [photo, controlPng()].map((bytes) => ({
  mediaType: "image/png",
  base64: bytes.toString("base64"),
  sha256: createHash("sha256").update(bytes).digest("hex"),
}));
const workflow: SessionWorkflowClient = {
  signalUserMessage: async () => {},
  startRigVerification: async () => {},
  wakeSessionWorkflow: async () => {},
  requestSessionWorkflowWakeDispatch: async () => {},
  signalApprovalDecision: async () => {},
  syncScheduledTask: async () => {},
  deleteScheduledTaskSchedule: async () => {},
  triggerScheduledTask: async () => {},
};
beforeAll(async () => {
  await migrate(databaseUrl);
  await provisionRoles(databaseUrl, {
    appRole: "opengeni_app",
    appPassword: "image-fixture-app",
    rlsStrategy: "force",
  });
  const url = new URL(databaseUrl);
  url.username = "opengeni_app";
  url.password = "image-fixture-app";
  client = createDb(url.toString());
  bus = await createNatsEventBus(natsUrl);
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const hasImages = JSON.stringify(body.input).includes('"input_image"');
      const text = JSON.stringify({
        controlCode: hasImages ? controlCode : null,
        imageUsable: hasImages,
        finding: hasImages ? "MATCHES" : "CANNOT_TELL",
      });
      const item = {
        type: "message",
        id: "msg-test",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
      };
      const response = {
        id: "resp-test",
        object: "response",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 4,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 14,
        },
      };
      return new Response(
        [
          {
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: text,
          },
          {
            type: "response.output_text.done",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            text,
          },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
}, 180_000);
afterAll(async () => {
  provider?.stop(true);
  await bus?.close();
  await client?.close();
  await admin.close();
});
test("real HTTP admission, Core NATS, turn activity and provider input keep inline bytes ephemeral", async () => {
  const settings = testSettings({
    databaseUrl: databaseUrl,
    natsUrl,
    openaiModel: "gpt-5.6-sol",
    openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`,
    mcpServers: [],
  });
  const imageModel = configuredModels(settings).find((model) => model.id === "gpt-5.6-sol")!;
  settings.modelProvidersJson = JSON.stringify([
    {
      id: "inline-proof",
      api: "responses",
      baseUrl: settings.openaiBaseUrl,
      apiKey: "fixture",
      models: [
        {
          id: "text-only-proof",
          capabilities: { ...imageModel.capabilities, inputModalities: ["text"] },
          pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
        },
      ],
    },
  ]);
  const app = createApp({ settings, db: client.db, bus, workflowClient: workflow });
  const context = (await (await app.request("/v1/access/me")).json()) as {
    defaultWorkspaceId: string;
  };
  expect(context.defaultWorkspaceId).toBeTruthy();
  const workspaceId = context.defaultWorkspaceId;
  const path = `/v1/workspaces/${workspaceId}/sessions`;
  const create = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startMode: "realtime",
      tools: [],
      firstPartyMcpTools: [],
      bundledSkillIds: [],
      skills: [],
      memoryScope: "off",
      agentAccess: "session",
      sandboxBackend: "none",
      model: "gpt-5.6-sol",
    }),
  });
  expect(create.status).toBe(202);
  const session = (await create.json()) as { id: string; accountId: string };
  const send = await app.request(`${path}/${session.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "user.message",
      clientEventId: crypto.randomUUID(),
      payload: { text: "Assess the evidence and return the control code.", images },
    }),
  });
  expect(send.status).toBe(202);
  const accepted = (await send.json()) as { payload: Record<string, unknown> };
  expect(accepted.payload.images).toEqual(
    images.map(({ mediaType, sha256, base64 }) => ({
      mediaType,
      sha256,
      byteSize: Buffer.from(base64, "base64").length,
    })),
  );
  const activities = createActivityTestHarness({
    settings,
    db: client.db,
    bus,
    runtime: createProductionAgentRuntime(),
  });
  const result = await activities.runAgentTurn({
    attemptId: crypto.randomUUID(),
    accountId: session.accountId,
    workspaceId,
    sessionId: session.id,
    trigger: { kind: "next" },
    workflowId: `image-${session.id}`,
    workflowRunId: crypto.randomUUID(),
  });
  expect(result.status).toBe("idle");
  expect(requests.length).toBe(1);
  const imageParts = (requests[0]!.input as { content?: { type: string; image_url?: string }[] }[])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "input_image");
  expect(imageParts.length).toBe(images.length);
  expect(
    imageParts.map((part) =>
      createHash("sha256")
        .update(Buffer.from(part.image_url!.split(",")[1]!, "base64"))
        .digest("hex"),
    ),
  ).toEqual(images.map((image) => image.sha256));
  const events = await listSessionEvents(client.db, workspaceId, session.id, 0, 200);
  const history = await getSessionHistoryItems(client.db, workspaceId, session.id);
  expect(events.some((event) => event.type === "turn.completed")).toBe(true);
  expect(
    events
      .filter((event) => event.type === "agent.message.completed")
      .map((event) => event.payload),
  ).toContainEqual(expect.objectContaining({ text: expect.stringContaining(controlCode) }));
  expect((await requireSession(client.db, workspaceId, session.id)).status).toBe("idle");
  const persistence = await admin.db.execute(
    dbSql`select 'events' as source, coalesce(jsonb_agg(to_jsonb(t)), '[]') as data from session_events t where session_id=${session.id} union all select 'history',coalesce(jsonb_agg(to_jsonb(t)), '[]') from session_history_items t where session_id=${session.id} union all select 'debug',coalesce(jsonb_agg(to_jsonb(t)), '[]') from session_attempt_model_context_snapshots t where session_id=${session.id} union all select 'turns',coalesce(jsonb_agg(to_jsonb(t)), '[]') from session_turns t where session_id=${session.id} union all select 'states',coalesce(jsonb_agg(to_jsonb(t)), '[]') from agent_run_states t where session_id=${session.id} union all select 'files',coalesce(jsonb_agg(to_jsonb(t)), '[]') from files t where workspace_id=${workspaceId}`,
  );
  const durable = JSON.stringify([events, history, persistence]);
  for (const image of images) expect(durable).not.toContain(image.base64);
  expect(JSON.stringify(history)).toContain(images[0]!.sha256);
  // A second routed model uses the same API, worker and provider, with image input absent.
  const textCreate = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startMode: "realtime",
      tools: [],
      firstPartyMcpTools: [],
      bundledSkillIds: [],
      memoryScope: "off",
      agentAccess: "session",
      sandboxBackend: "none",
      model: "text-only-proof",
    }),
  });
  expect(textCreate.status).toBe(202);
  const textSession = (await textCreate.json()) as typeof session;
  const textSend = await app.request(`${path}/${textSession.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "user.message",
      payload: { text: "Assess the control image", images },
    }),
  });
  expect(textSend.status).toBe(202);
  await activities.runAgentTurn({
    attemptId: crypto.randomUUID(),
    accountId: session.accountId,
    workspaceId,
    sessionId: textSession.id,
    trigger: { kind: "next" },
    workflowId: `image-${textSession.id}`,
    workflowRunId: crypto.randomUUID(),
  });
  expect(requests.length).toBe(2);
  expect(JSON.stringify(requests[1]!.input)).toContain(
    "Image content omitted because the selected model does not support image input.",
  );
  expect(JSON.stringify(requests[1]!.input)).not.toContain("base64");
  const textEvents = await listSessionEvents(client.db, workspaceId, textSession.id, 0, 200);
  const textOutput = textEvents.find((event) => event.type === "agent.message.completed")!
    .payload as { text: string };
  expect(JSON.parse(textOutput.text).controlCode).not.toBe(controlCode); // The consumer refuses IMAGE_NOT_SEEN.
  // Old public HTTP admission, not just the old schema, refuses images with its installed typed 422.
  const oldRoot = process.env.OPENGENI_OLD_PIN_ROOT;
  if (!oldRoot) throw new Error("old pin checkout required");
  const old = (await import(`${oldRoot}/apps/api/src/app.ts`)) as { createApp: typeof createApp };
  const oldApp = old.createApp({ settings, db: client.db, bus, workflowClient: workflow });
  const oldRefusal = await oldApp.request(`${path}/${session.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "user.message", payload: { text: "Assess", images } }),
  });
  expect(oldRefusal.status).toBe(422);
  // A nonempty tool policy is refused before any bytes are staged or provider work starts.
  settings.mcpServers.push({
    id: "fixture-tool",
    name: "Fixture tool",
    url: "http://127.0.0.1:1/mcp",
    timeoutMs: undefined,
    cacheToolsList: false,
  });
  const toolSession = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startMode: "realtime",
      tools: [{ kind: "mcp", id: "fixture-tool", optional: true }],
      firstPartyMcpTools: [],
      bundledSkillIds: [],
      memoryScope: "off",
      agentAccess: "session",
      sandboxBackend: "none",
    }),
  });
  expect(toolSession.status).toBe(202);
  const forbidden = (await toolSession.json()) as typeof session;
  const refused = await app.request(`${path}/${forbidden.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "user.message", payload: { text: "Assess", images } }),
  });
  expect(refused.status).toBe(422);
  expect(requests.length).toBe(2);
  const [completedTurn] = await listSessionTurns(client.db, workspaceId, session.id, 1);
  const descriptor = readInlineImageDescriptor(completedTurn!.metadata)!;
  await expect(
    consumeInlineImages(
      bus,
      { workspaceId, sessionId: session.id, attemptId: crypto.randomUUID() },
      descriptor,
    ),
  ).rejects.toThrow("UNAVAILABLE");
  console.log(
    "G2_STEP1_INPUT_IMAGE_DIGESTS",
    JSON.stringify(
      images.map(({ mediaType, sha256, base64 }) => ({
        mediaType,
        sha256,
        byteSize: Buffer.from(base64, "base64").length,
      })),
    ),
  );
}, 60_000);
