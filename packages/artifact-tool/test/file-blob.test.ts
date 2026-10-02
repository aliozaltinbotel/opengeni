import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileBlob } from "../src/file-blob";

const directories: string[] = [];

async function temporaryDirectory(parent = tmpdir()): Promise<string> {
  const directory = await mkdtemp(join(parent, "opengeni-file-blob-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("FileBlob", () => {
  test("loads and saves exact binary bytes with the file name and default MIME type", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "binary.dat");
    const bytes = Uint8Array.from({ length: 1025 }, (_, index) => index % 256);
    await writeFile(path, bytes);

    const blob = await FileBlob.load(path);

    expect(blob.name).toBe(path);
    expect(blob.type).toBe("");
    expect(blob.size).toBe(bytes.byteLength);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);

    const savedPath = join(directory, "saved.dat");
    await blob.save(savedPath);
    expect(new Uint8Array(await readFile(savedPath))).toEqual(bytes);
  });

  test("loads an empty file without adding bytes", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "empty.dat");
    await writeFile(path, new Uint8Array());

    const blob = await FileBlob.load(path);

    expect(blob.name).toBe(path);
    expect(blob.size).toBe(0);
    expect(blob.type).toBe("");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array());
  });

  test("copies only a shared buffer view's bytes and preserves name and MIME options", async () => {
    const bytes = new Uint8Array(new SharedArrayBuffer(8));
    bytes.set([91, 92, 0, 128, 255, 13, 93, 94]);
    const view = bytes.subarray(2, 6);
    const expected = Uint8Array.from(view);

    const blob = FileBlob.fromBytes(view, { name: "image.bin", type: "APPLICATION/OCTET-STREAM" });
    bytes.fill(17);

    expect(blob.name).toBe("image.bin");
    expect(blob.type).toBe("application/octet-stream");
    expect(blob.size).toBe(view.byteLength);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(expected);
  });

  test("preserves filesystem load and save errors", async () => {
    const directory = await temporaryDirectory();
    const missingPath = join(directory, "missing.dat");

    await expect(FileBlob.load(missingPath)).rejects.toMatchObject({
      code: "ENOENT",
      path: missingPath,
    });
    await expect(FileBlob.load(directory)).rejects.toMatchObject({ code: "EISDIR" });

    const output = join(directory, "missing-directory", "output.dat");
    await expect(FileBlob.fromBytes(Uint8Array.of(0, 255)).save(output)).rejects.toMatchObject({
      code: "ENOENT",
      path: output,
    });
  });

  test("emits declarations with the installed TypeScript compiler", async () => {
    const directory = await temporaryDirectory(resolve(import.meta.dir, ".."));
    const configPath = join(directory, "tsconfig.json");
    const sourcePath = resolve(import.meta.dir, "../src/file-blob.ts");
    await writeFile(
      configPath,
      JSON.stringify({
        extends: resolve(import.meta.dir, "../tsconfig.json"),
        compilerOptions: {
          noEmit: false,
          declaration: true,
          declarationMap: false,
          emitDeclarationOnly: true,
          rootDir: resolve(import.meta.dir, "../src"),
          outDir: join(directory, "dist"),
          incremental: false,
          paths: {},
        },
        include: [sourcePath],
        exclude: [],
      }),
    );
    const compiler = Bun.spawn({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "../../../node_modules/typescript/bin/tsc"),
        "--project",
        configPath,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      compiler.exited,
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
    ]);
    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(await readFile(join(directory, "dist/file-blob.d.ts"), "utf8")).toContain(
      "static load(path: string): Promise<FileBlob>",
    );
  });
});
