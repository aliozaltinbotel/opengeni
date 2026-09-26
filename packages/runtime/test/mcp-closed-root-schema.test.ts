import { describe, expect, test } from "bun:test";
import { mcpToFunctionTool } from "@openai/agents-core";

// Regression for patches/@openai%2Fagents-core@0.14.3.patch (MAINT-P09-160): the non-strict MCP conversion must keep
// an explicitly closed input root closed. Unpatched 0.14.3 (and upstream through 0.18.0) overwrite it with true.
const server = { name: "cendra-pms", cacheToolsList: false, callTool: async () => [] } as never;
const convert = (inputSchema: Record<string, unknown>, strict = false) =>
  mcpToFunctionTool(
    { name: "reservation_read", description: "read", inputSchema } as never,
    server,
    strict,
  ) as unknown as {
    parameters: Record<string, unknown>;
    strict: boolean;
  };

describe("MCP closed-root schema on the non-strict path", () => {
  test("an explicitly closed root stays closed, strict stays false, nothing else changes", () => {
    const inputSchema = {
      type: "object",
      properties: { reservationId: { type: "string" }, note: { type: ["string", "null"] } },
      required: ["reservationId"],
      additionalProperties: false,
    };
    const tool = convert(inputSchema);
    expect(tool.strict).toBe(false);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.parameters.required).toEqual(["reservationId"]);
    expect(tool.parameters.properties).toEqual(inputSchema.properties);
  });

  test("an absent additionalProperties keeps the historical open fallback", () => {
    const tool = convert({ type: "object", properties: { q: { type: "string" } } });
    expect(tool.strict).toBe(false);
    expect(tool.parameters.additionalProperties).toBe(true);
  });

  test("an explicitly open root still takes upstream's strict conversion (the patch touches only the non-strict path)", () => {
    const tool = convert({ type: "object", properties: {}, additionalProperties: true });
    expect(tool.strict).toBe(true);
  });

  test("convertSchemasToStrict=true is unchanged by the patch", () => {
    const tool = convert(
      {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
        additionalProperties: false,
      },
      true,
    );
    expect(tool.strict).toBe(true);
    expect(tool.parameters.additionalProperties).toBe(false);
  });
});
