import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ClientSessionEvent,
  INLINE_IMAGE_MAX_PART_BYTES,
  INLINE_IMAGE_MAX_COUNT,
} from "../src/index";
const bytes = Buffer.from("synthetic image bytes");
const image = {
  mediaType: "image/png",
  base64: bytes.toString("base64"),
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
test("bounded canonical inline image parts are accepted on user.message", () => {
  expect(
    ClientSessionEvent.parse({
      type: "user.message",
      payload: { text: "Assess the image", images: [image] },
    }).payload,
  ).toHaveProperty("images");
});
test("inline images refuse unknown fields, formats, bad base64, digest and bounds", () => {
  for (const bad of [
    { ...image, extra: true },
    { ...image, mediaType: "image/svg+xml" },
    { ...image, base64: image.base64 + "\n" },
    { ...image, sha256: "0".repeat(64) },
    { ...image, base64: "AB==" },
    { ...image, base64: Buffer.alloc(INLINE_IMAGE_MAX_PART_BYTES + 1).toString("base64") },
  ]) {
    expect(
      ClientSessionEvent.safeParse({
        type: "user.message",
        payload: { text: "Assess", images: [bad] },
      }).success,
    ).toBe(false);
  }
  expect(
    ClientSessionEvent.safeParse({
      type: "user.message",
      payload: {
        text: "Assess",
        images: Array.from({ length: INLINE_IMAGE_MAX_COUNT + 1 }, () => image),
      },
    }).success,
  ).toBe(false);
});
