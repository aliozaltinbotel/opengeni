import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { build } from "vite";

import { hostExtensionAliases, resolveHostExtensionFiles } from "./vite-host-extension";

const stubDirectory = path.resolve(import.meta.dir, "src/host-extension/none");
const temporaryDirectories: string[] = [];

async function directoryWith(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opengeni-host-extension-"));
  temporaryDirectories.push(directory);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content);
  }
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("web host extension resolution", () => {
  test.each([undefined, "", "  "])("resolves the stock stub when the env is %p", (configured) => {
    expect(resolveHostExtensionFiles(configured, stubDirectory)).toEqual({
      entry: path.join(stubDirectory, "index.ts"),
      style: path.join(stubDirectory, "style.css"),
    });
  });

  test("resolves a configured directory to its index.js and style.css", async () => {
    const directory = await directoryWith({
      "index.js": "export default { id: 'fixture' };",
      "style.css": "",
    });
    expect(resolveHostExtensionFiles(directory, stubDirectory)).toEqual({
      entry: path.join(directory, "index.js"),
      style: path.join(directory, "style.css"),
    });
  });

  test("refuses a configured directory that has no style.css", async () => {
    const directory = await directoryWith({ "index.js": "export default { id: 'fixture' };" });
    expect(() => resolveHostExtensionFiles(directory, stubDirectory)).toThrow(
      /^HOST_EXTENSION_INCOMPLETE: .*style\.css/,
    );
  });

  test("refuses a configured directory that has no index.js", async () => {
    const directory = await directoryWith({ "style.css": "" });
    expect(() => resolveHostExtensionFiles(directory, stubDirectory)).toThrow(
      /^HOST_EXTENSION_INCOMPLETE: .*index\.js/,
    );
  });

  test("refuses a relative directory", () => {
    expect(() => resolveHostExtensionFiles("extension/dist", stubDirectory)).toThrow(
      /^HOST_EXTENSION_INCOMPLETE: .*absolute/,
    );
  });

  test("the vite config resolves the extension through these aliases", async () => {
    const config = await readFile(new URL("./vite.config.ts", import.meta.url), "utf8");
    expect(config).toContain("hostExtensionAliases(");
    expect(config).toMatch(
      /resolveHostExtensionFiles\(\s*process\.env\.OPENGENI_WEB_HOST_EXTENSION,/,
    );
  });

  test("a build resolves the style specifier apart from the entry specifier", async () => {
    const extension = await directoryWith({
      "index.js": "export default { id: 'fixture-extension' };",
      "style.css": ".fixture-extension-style { color: red; }",
    });
    const project = await directoryWith({
      "entry.js": [
        'import extension from "@opengeni/web-host-extension";',
        'import "@opengeni/web-host-extension/style.css";',
        "globalThis.extensionId = extension.id;",
      ].join("\n"),
    });
    const outDir = path.join(project, "dist");
    await build({
      configFile: false,
      logLevel: "silent",
      root: project,
      resolve: { alias: hostExtensionAliases(resolveHostExtensionFiles(extension, stubDirectory)) },
      build: {
        outDir,
        lib: { entry: path.join(project, "entry.js"), formats: ["es"], fileName: "entry" },
      },
    });
    const output = await Promise.all(
      (await readdir(outDir)).map((name) => readFile(path.join(outDir, name), "utf8")),
    );
    expect(output.join("\n")).toContain("fixture-extension");
    expect(output.join("\n")).toContain(".fixture-extension-style");
  });
});
