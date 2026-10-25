import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBlob } from "../src/file-blob";

for (const bytes of [new Uint8Array(), Uint8Array.of(0, 255, 128, 42)]) {
  test(`FileBlob.load preserves ${bytes.byteLength} bytes and its file name`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-file-blob-"));
    try {
      const source = join(directory, "source.bin");
      const saved = join(directory, "saved.bin");
      await writeFile(source, bytes);
      const blob = await FileBlob.load(source);
      await writeFile(source, Uint8Array.of(99));
      expect(blob.name).toBe(source);
      expect(blob.size).toBe(bytes.byteLength);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
      await blob.save(saved);
      expect(new Uint8Array(await readFile(saved))).toEqual(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("FileBlob.fromBytes isolates the selected SharedArrayBuffer view", async () => {
  const shared = new SharedArrayBuffer(8);
  const backing = new Uint8Array(shared);
  backing.fill(99);
  const selected = new Uint8Array(shared, 2, 3);
  selected.set([0, 255, 128]);
  const blob = FileBlob.fromBytes(selected, { name: "shared.bin", type: "application/octet-stream" });
  backing.fill(42);
  expect(blob.name).toBe("shared.bin");
  expect(blob.type).toBe("application/octet-stream");
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.of(0, 255, 128));
});
