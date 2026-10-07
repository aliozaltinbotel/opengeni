import { expect, test } from "bun:test";
import { CreateFileUploadRequest, CreateSessionRequest, FileResourceRef } from "../src";
const id = "00000000-0000-4000-8000-000000000001";
test("image opt-in is literal and preserves the immutable output bound", () => {
  expect(FileResourceRef.parse({ kind: "file", fileId: id, asImage: true }).asImage).toBe(true);
  expect(FileResourceRef.safeParse({ kind: "file", fileId: id, asImage: false }).success).toBe(false);
  expect(CreateSessionRequest.parse({ initialMessage: "Inspect the images", maxOutputTokens: 400 }).maxOutputTokens).toBe(400);
  for (const value of [0, -1, 0.5, "400"]) expect(CreateSessionRequest.safeParse({ initialMessage: "Inspect the images", maxOutputTokens: value }).success).toBe(false);
  expect(CreateFileUploadRequest.parse({ temporaryForSessionId: id, filename: "image.png", contentType: "image/png", sizeBytes: 1 }).temporaryForSessionId).toBe(id);
});
