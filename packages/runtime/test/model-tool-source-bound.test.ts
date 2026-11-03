import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { OpenAIResponsesModel, Runner, type AgentInputItem } from "@openai/agents";
import OpenAI from "openai";
import {
  prepareAgentTools,
  buildOpenGeniAgent,
  callModelInputFilterForSettings,
  runAgentStream,
} from "../src/index";
import { testSettings } from "@opengeni/testing";
import {
  ModelRequestCaptureModel,
  withModelRequestCapture,
  bindModelSourceInput,
  modelSourceBindings,
  type ModelRequestCapture,
} from "../src/model-request-capture";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
for (const streaming of [false, true])
  for (const parallel of [false, true])
    test(`bounded successful MCP source retains its exact producer: streaming=${streaming}, mixedBatch=${parallel}`, async () => {
      const raw = {
        content: [
          { type: "text" as const, text: "Synthetic current property. ".repeat(100) },
          { type: "text" as const, text: "Synthetic property details." },
        ],
        structuredContent: { propertyCount: 1 },
      };
      const settings = testSettings({
        modelToolOutputTruncationTokens: 64,
        sandboxBackend: "none",
        webSearchEnabled: false,
        openaiProviderItemIds: "strip",
        mcpServers: [
          { id: "cendra-pms", url: "https://synthetic.invalid/mcp", cacheToolsList: false },
        ],
      });
      const prepared = await prepareAgentTools(
        settings,
        [{ kind: "mcp", id: "cendra-pms", eager: true }],
        {
          accountId: crypto.randomUUID(),
          workspaceId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          executionGeneration: 1,
          localMcpServers: [
            {
              id: "cendra-pms",
              server: {
                name: "cendra-pms",
                cacheToolsList: false,
                connect: async () => {},
                close: async () => {},
                invalidateToolsCache: async () => {},
                listTools: async () =>
                  ["property_calendar_read", "property_read", "reservation_list"].map((name) => ({
                    name,
                    inputSchema: {
                      type: "object",
                      properties: {},
                      required: [],
                      additionalProperties: false,
                    },
                  })),
                callTool: async () => raw.content,
                callToolResult: async (name) => {
                  if (name === "property_calendar_read")
                    throw Object.assign(new Error("Synthetic read refused."), {
                      code: "VALIDATION_ERROR",
                    });
                  return raw;
                },
              },
              modelSourceRefs: () => [],
            },
          ],
        },
      );
      let transports = 0;
      const observations: Array<{
        inputCount: number;
        boundCount: number;
        missingKinds: string[];
      }> = [];
      const capture: ModelRequestCapture = () => {};
      capture.modelToolOutputTruncationTokens = settings.modelToolOutputTruncationTokens;
      let restoreHistorySources: ((items: readonly unknown[]) => void) | undefined;
      capture.callCompleted = (_sourceKey, _responseId, _response, restore) => {
        restoreHistorySources = restore;
      };
      capture.beforeCall = async (request) => {
        const bindings = modelSourceBindings(request.input);
        const missing = (Array.isArray(request.input) ? request.input : []).flatMap(
          (value, ordinal) =>
            bindings.some((b) => b.ordinal === ordinal && b.sourceRef.sha256 === digest(value))
              ? []
              : [value.type ?? "message"],
        );
        observations.push({
          inputCount: Array.isArray(request.input) ? request.input.length : 0,
          boundCount: bindings.length,
          missingKinds: missing,
        });
        if (observations.length === 2 && Array.isArray(request.input)) {
          const ordinal = request.input.findIndex(
            (item) => item.type === "function_call_result" && item.name.endsWith("__property_read"),
          );
          const property = request.input[ordinal];
          if (property?.type !== "function_call_result")
            throw new Error("SYNTHETIC_PROPERTY_RESULT_MISSING");
          const binding = bindings.find((candidate) => candidate.ordinal === ordinal);
          expect(binding?.rawToolSource?.rawSourceRef.sha256).toBe(digest(raw));
          expect(binding?.rawToolResult).toEqual(raw);
          expect(JSON.stringify(property.output)).toContain("tokens truncated");
          const altered = structuredClone(property);
          altered.output = [{ type: "input_text", text: "Synthetic forged replacement" }];
          const foreign = structuredClone(property);
          foreign.callId = "foreign-call";
          restoreHistorySources?.([altered, foreign]);
          expect(modelSourceBindings([altered, foreign])).toEqual([]);
        }
        return `synthetic-source-${observations.length}`;
      };
      const client = new OpenAI({
        apiKey: "synthetic-key",
        baseURL: "https://synthetic.invalid/v1",
        maxRetries: 0,
        fetch: async (_url, init) => {
          transports++;
          const body = JSON.parse(String(init?.body)) as { tools: Array<{ name: string }> };
          const name = (suffix: string) =>
            body.tools.find((t) => t.name.endsWith("__" + suffix))!.name;
          const output =
            transports === 1
              ? [
                  {
                    type: "function_call",
                    id: "fc_property",
                    call_id: "property-call",
                    name: name("property_read"),
                    status: "completed",
                    arguments: "{}",
                  },
                  ...(parallel
                    ? [
                        {
                          type: "function_call",
                          id: "fc_error",
                          call_id: "refused-call",
                          name: name("property_calendar_read"),
                          status: "completed",
                          arguments: "{}",
                        },
                        {
                          type: "function_call",
                          id: "fc_reservation",
                          call_id: "reservation-call",
                          name: name("reservation_list"),
                          status: "completed",
                          arguments: "{}",
                        },
                      ]
                    : []),
                ]
              : [
                  {
                    type: "message",
                    id: "msg_done",
                    role: "assistant",
                    status: "completed",
                    content: [
                      {
                        type: "output_text",
                        text: "Synthetic answer",
                        annotations: [],
                        logprobs: [],
                      },
                    ],
                  },
                ];
          const response = {
            id: `response-${transports}`,
            status: "completed",
            output,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
          const events = [
            {
              type: "response.created",
              response: { id: response.id, status: "in_progress", output: [] },
            },
            ...output.map((item, output_index) => ({
              type: "response.output_item.done",
              item,
              output_index,
            })),
            { type: "response.completed", response },
          ];
          return new Response(
            streaming
              ? events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
              : JSON.stringify(response),
            { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } },
          );
        },
      });
      try {
        const model = new ModelRequestCaptureModel(
          new OpenAIResponsesModel(client, "synthetic-model"),
        );
        const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers }).clone({
          model,
        });
        const initial: AgentInputItem = {
          type: "message",
          role: "user",
          content: "Synthetic current-property question",
        };
        bindModelSourceInput(initial, {
          kind: "HISTORY_ROW",
          sourceRef: {
            owner: "native.runtime.artifact",
            id: "synthetic-initial",
            sha256: digest(initial),
          },
          parents: [],
          retainedSources: [],
        });
        await withModelRequestCapture(capture, async () => {
          const runner = new Runner({ tracingDisabled: true });
          if (streaming) {
            const beforeCall = capture.beforeCall;
            const completed = capture.callCompleted;
            if (!beforeCall || !completed) throw new Error("SYNTHETIC_CAPTURE_HOOK_MISSING");
            const stream = await runAgentStream(
              agent,
              { input: [initial], persistedHistoryCount: 1 },
              settings,
              {
                beforeModelCallSourceReceipt: beforeCall,
                onModelCallSourceCompleted: completed,
              },
            );
            for await (const event of stream) {
              void event;
            }
            await stream.completed;
          } else {
            const filter = callModelInputFilterForSettings(settings);
            await runner.run(agent, [initial], {
              historyOwnership: "external",
              ...(filter ? { callModelInputFilter: filter } : {}),
            });
          }
        });

        expect(observations.length).toBe(2);
        expect(observations[1]?.missingKinds).toEqual([]);
      } finally {
        await prepared.close();
      }
    });
