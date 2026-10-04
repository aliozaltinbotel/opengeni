import { projectModelInputForCapabilities } from "./model-input";
import {
  InlineImageParts,
  inlineImageMetadata,
  inlineImageContext,
  InlineImageMetadata,
  type InlineImagePart,
  type SessionEvent,
} from "@opengeni/contracts";
import type { CallModelInputFilter, AgentInputItem } from "@openai/agents";
import { z } from "zod";

export const INLINE_IMAGE_LEASE_TTL_MS = 60_000;
export const INLINE_IMAGE_PROCESS_MAX_BYTES = 16 * 1024 * 1024;
const descriptor = z
  .object({ id: z.string().uuid(), images: z.array(InlineImageMetadata).min(1).max(2) })
  .strict();
export type InlineImageDescriptor = z.infer<typeof descriptor>;
export type InlineImageScope = { workspaceId: string; sessionId: string; attemptId: string };
type Bus = {
  request: (
    subject: string,
    payload: Uint8Array,
    opts: { timeoutMs: number },
  ) => Promise<{ data: Uint8Array }>;
  subscribe: (
    workspaceId: string,
    sessionId: string,
    onEvents: (events: Pick<SessionEvent, "type" | "turnId" | "payload">[]) => void,
  ) => Promise<() => void>;
  subscribeRequests: (
    subject: string,
    handler: (request: Uint8Array) => Promise<Uint8Array>,
  ) => () => void;
};
const held = new WeakMap<Bus, { bytes: number; scopes: Set<string> }>();
export function readInlineImageDescriptor(
  metadata: Record<string, unknown>,
): InlineImageDescriptor | null {
  if (metadata.inlineImageInput === undefined) return null;
  const parsed = descriptor.safeParse(metadata.inlineImageInput);
  if (!parsed.success) throw new Error("INLINE_IMAGE_METADATA_INVALID");
  return parsed.data;
}
export async function stageInlineImages(
  bus: Bus,
  scope: { workspaceId: string; sessionId: string },
  images: readonly InlineImagePart[],
  authorize: (scope: InlineImageScope, id: string) => Promise<boolean>,
) {
  const parts = InlineImageParts.parse(images);
  const metadata = inlineImageMetadata(parts);
  const bytes = Buffer.byteLength(JSON.stringify(parts), "utf8");
  const key = `${scope.workspaceId}:${scope.sessionId}`;
  const state = held.get(bus) ?? { bytes: 0, scopes: new Set<string>() };
  held.set(bus, state);
  if (
    state.scopes.has(key) ||
    state.scopes.size >= 32 ||
    state.bytes + bytes > INLINE_IMAGE_PROCESS_MAX_BYTES
  )
    throw new Error("INLINE_IMAGE_MEMORY_EXCEEDED");
  state.scopes.add(key);
  state.bytes += bytes;
  const id = crypto.randomUUID();
  let raw: readonly InlineImagePart[] | null = parts;
  let acceptedTurnId: string | null = null;
  let closed = false;
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopEvents: () => void = () => {};
  const cancel = () => {
    if (closed) return;
    closed = true;
    raw = null;
    if (timer) clearTimeout(timer);
    unsubscribe();
    stopEvents();
    state.bytes -= bytes;
    state.scopes.delete(key);
  };
  timer = setTimeout(cancel, INLINE_IMAGE_LEASE_TTL_MS);
  timer.unref();
  try {
    stopEvents = await bus.subscribe(scope.workspaceId, scope.sessionId, (events) => {
      if (
        events.some(
          (event) =>
            acceptedTurnId !== null &&
            event.turnId === acceptedTurnId &&
            ["turn.failed", "turn.cancelled", "turn.superseded"].includes(event.type),
        )
      )
        cancel();
    });
    if (closed) {
      stopEvents();
      throw new Error("INLINE_IMAGE_INPUT_UNAVAILABLE");
    }
    unsubscribe = bus.subscribeRequests(`opengeni.inline-image.${id}`, async (request) => {
      const parsed = z
        .object({
          workspaceId: z.string().uuid(),
          sessionId: z.string().uuid(),
          attemptId: z.string().uuid(),
        })
        .strict()
        .safeParse(JSON.parse(new TextDecoder().decode(request)));
      if (
        !parsed.success ||
        closed ||
        acceptedTurnId === null ||
        parsed.data.workspaceId !== scope.workspaceId ||
        parsed.data.sessionId !== scope.sessionId
      )
        throw new Error("INLINE_IMAGE_INPUT_UNAVAILABLE");
      try {
        if (!(await authorize(parsed.data, id)) || closed) throw new Error();
      } catch {
        cancel();
        throw new Error("INLINE_IMAGE_INPUT_UNAVAILABLE");
      }
      const response = new TextEncoder().encode(JSON.stringify(raw));
      cancel();
      return response;
    });
  } catch {
    cancel();
    throw new Error("INLINE_IMAGE_TRANSPORT_UNAVAILABLE");
  }
  return {
    descriptor: { id, images: metadata } satisfies InlineImageDescriptor,
    // The existing acceptance transaction binds before commit/fanout. Its
    // persistence retry may replace an uncommitted turn id; no turn can consume
    // bytes until that transaction exposes the exact live attempt.
    bindTurn: (turnId: string): void => {
      if (closed) throw new Error("INLINE_IMAGE_INPUT_UNAVAILABLE");
      acceptedTurnId = z.string().uuid().parse(turnId);
    },
    cancel,
  };
}
export async function consumeInlineImages(
  bus: Bus,
  scope: InlineImageScope,
  metadata: InlineImageDescriptor,
): Promise<InlineImagePart[]> {
  try {
    const response = await bus.request(
      `opengeni.inline-image.${metadata.id}`,
      new TextEncoder().encode(JSON.stringify(scope)),
      { timeoutMs: 5000 },
    );
    const images = InlineImageParts.parse(JSON.parse(new TextDecoder().decode(response.data)));
    if (JSON.stringify(inlineImageMetadata(images)) !== JSON.stringify(metadata.images))
      throw new Error();
    return images;
  } catch {
    throw new Error("INLINE_IMAGE_INPUT_UNAVAILABLE");
  }
}
/** Request clone only: SDK state and durable conversation never contain bytes. */
export function inlineImageInputFilter(
  images: readonly InlineImagePart[],
  metadata: readonly InlineImageMetadata[],
  supportsImageInput = true,
): CallModelInputFilter {
  const marker = inlineImageContext(metadata);
  return ({ modelData }) => {
    const hasMarker = (v: unknown): boolean =>
      typeof v === "string"
        ? v.includes(marker)
        : Array.isArray(v)
          ? v.some(hasMarker)
          : !!v && typeof v === "object" && Object.values(v).some(hasMarker);
    if (!hasMarker(modelData.input)) throw new Error("INLINE_IMAGE_CONTEXT_UNAVAILABLE");
    return {
      ...modelData,
      input: [
        ...modelData.input,
        ...(projectModelInputForCapabilities(
          [
            {
              role: "user",
              content: images.map((image) => ({
                type: "input_image",
                image: `data:${image.mediaType};base64,${image.base64}`,
                detail: "auto",
              })),
            },
          ],
          { supportsImageInput },
        ) as AgentInputItem[]),
      ],
    };
  };
}
