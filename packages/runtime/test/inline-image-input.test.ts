import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CallModelInputFilter } from "@openai/agents";
import {
  SessionEvent,
  inlineImageContext,
  inlineImageMetadata,
  type InlineImagePart,
} from "@opengeni/contracts";
import {
  inlineImageInputFilter,
  stageInlineImages,
  consumeInlineImages,
} from "../src/inline-image-input";
import { MemoryEventBus } from "@opengeni/testing";
const parts: InlineImagePart[] = ["photo", "control"].map((text) => ({
  mediaType: "image/png",
  base64: Buffer.from(text).toString("base64"),
  sha256: createHash("sha256").update(text).digest("hex"),
}));
const scope = {
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
};
test("one-use handoff refuses wrong scope/current attempt and leaves no reusable copy", async () => {
  const bus = new MemoryEventBus();
  const lease = await stageInlineImages(
    bus,
    scope,
    parts,
    async (candidate) => candidate.attemptId === scope.attemptId,
  );
  await expect(
    consumeInlineImages(bus, { ...scope, workspaceId: crypto.randomUUID() }, lease.descriptor),
  ).rejects.toThrow("UNAVAILABLE");

  expect(inlineImageMetadata(await consumeInlineImages(bus, scope, lease.descriptor))).toEqual(
    inlineImageMetadata(parts),
  );
  await expect(consumeInlineImages(bus, scope, lease.descriptor)).rejects.toThrow("UNAVAILABLE");
  const again = await stageInlineImages(bus, scope, parts, async () => true);
  again.cancel();
  await expect(consumeInlineImages(bus, scope, again.descriptor)).rejects.toThrow("UNAVAILABLE");
  const invalid = await stageInlineImages(bus, scope, parts, async () => false);
  await expect(consumeInlineImages(bus, scope, invalid.descriptor)).rejects.toThrow("UNAVAILABLE");
  await bus.close();
});
test("provider-only injection leaves original history intact and uses existing omission text", async () => {
  const metadata = inlineImageMetadata(parts);
  const input = [
    { role: "user", content: [{ type: "input_text", text: inlineImageContext(metadata) }] },
  ];
  const args = { modelData: { input } } as Parameters<CallModelInputFilter>[0];
  const result = await inlineImageInputFilter(parts, metadata)(args);
  expect(JSON.stringify(result)).toContain("input_image");
  expect(JSON.stringify(input)).not.toContain("base64");
  const omitted = await inlineImageInputFilter(parts, metadata, false)(args);
  expect(JSON.stringify(omitted)).toContain(
    "Image content omitted because the selected model does not support image input.",
  );
  expect(JSON.stringify(omitted)).not.toContain("base64");
  expect(() =>
    inlineImageInputFilter(
      parts,
      metadata,
    )({ modelData: { input: [] } } as Parameters<CallModelInputFilter>[0]),
  ).toThrow("CONTEXT_UNAVAILABLE");
});

test("expiry frees the memory scope and makes recovery fail closed", async () => {
  const bus = new MemoryEventBus();
  const lease = await stageInlineImages(bus, scope, parts, async () => true);
  await Bun.sleep(60_050);
  await expect(consumeInlineImages(bus, scope, lease.descriptor)).rejects.toThrow("UNAVAILABLE");
  const replacement = await stageInlineImages(bus, scope, parts, async () => true);
  replacement.cancel();
  await bus.close();
}, 65_000);

test("terminal cancellation/failure releases the pending image scope", async () => {
  const bus = new MemoryEventBus();
  for (const type of ["turn.cancelled", "turn.failed", "turn.superseded"] as const) {
    const lease = await stageInlineImages(bus, scope, parts, async () => true);
    await bus.publish(scope.workspaceId, scope.sessionId, [
      SessionEvent.parse({
        id: crypto.randomUUID(),
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        sequence: 1,
        type,
        payload: {},
        occurredAt: new Date().toISOString(),
      }),
    ]);
    await expect(consumeInlineImages(bus, scope, lease.descriptor)).rejects.toThrow("UNAVAILABLE");
  }
  const again = await stageInlineImages(bus, scope, parts, async () => true);
  await expect(stageInlineImages(bus, scope, parts, async () => true)).rejects.toThrow(
    "MEMORY_EXCEEDED",
  );
  again.cancel();
  await bus.close();
});
