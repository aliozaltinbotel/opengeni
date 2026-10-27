import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { build, type Plugin } from "vite";

import {
  HOST_EXTENSION_STOCK_DEFINE,
  hostExtensionAliases,
  hostExtensionDefine,
  hostExtensionTailwindSource,
  resolveHostExtensionFiles,
} from "./vite-host-extension";

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

  test.each([
    [undefined, '"true"'],
    ["", '"true"'],
    ["  ", '"true"'],
    ["/opt/extension", '"false"'],
  ])("defines the stock-build flag for %p as %p", (configured, flag) => {
    expect(hostExtensionDefine(configured)).toEqual({ [HOST_EXTENSION_STOCK_DEFINE]: flag });
  });

  test("the vite config defines the stock-build flag from the same setting", async () => {
    const config = await readFile(new URL("./vite.config.ts", import.meta.url), "utf8");
    expect(config).toMatch(
      /define:\s*hostExtensionDefine\(process\.env\.OPENGENI_WEB_HOST_EXTENSION\)/,
    );
  });

  test.each([
    [undefined, false],
    ["/opt/extension", true],
  ])(
    "a build with the extension setting %p keeps extension-only code: %p",
    async (configured, kept) => {
      const project = await directoryWith({
        "entry.js": [
          `if (${HOST_EXTENSION_STOCK_DEFINE} !== "true") globalThis.marker = "extension-only-check";`,
          "globalThis.loaded = true;",
        ].join("\n"),
      });
      const outDir = path.join(project, "dist");
      await build({
        configFile: false,
        logLevel: "silent",
        root: project,
        define: hostExtensionDefine(configured),
        build: {
          outDir,
          lib: { entry: path.join(project, "entry.js"), formats: ["es"], fileName: "entry" },
        },
      });
      const output = await Promise.all(
        (await readdir(outDir)).map((name) => readFile(path.join(outDir, name), "utf8")),
      );
      expect(output.join("\n").includes("extension-only-check")).toBe(kept);
    },
  );

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

  describe("Tailwind scans the configured extension", () => {
    // A utility class no console source uses: only the extension's built JS
    // can make Tailwind generate it. Tailwind scans this file too, so the class
    // is assembled here rather than written out.
    const EXTENSION_ONLY_CLASS = ["tracking", "[0.4242em]"].join("-");
    const stylesheet = "/console/src/styles.css";

    function transformOf(plugin: Plugin): (code: string, id: string) => unknown {
      const { transform } = plugin;
      if (typeof transform !== "function") throw new Error("expected a transform function");
      return (code, id) => Reflect.apply(transform, {}, [code, id]);
    }

    test.each([undefined, "", "  "])("adds no plugin when the env is %p", (configured) => {
      expect(hostExtensionTailwindSource(configured, stylesheet)).toBeUndefined();
    });

    test("adds the extension directory as a source of the console stylesheet only", () => {
      const plugin = hostExtensionTailwindSource(" /opt/extension ", stylesheet);
      if (!plugin) throw new Error("expected a plugin for a configured extension");
      expect(plugin.enforce).toBe("pre");
      const transform = transformOf(plugin);
      expect(transform('@import "tailwindcss";\n', stylesheet)).toBe(
        '@import "tailwindcss";\n\n@source "/opt/extension";\n',
      );
      expect(transform("a {}", `${stylesheet}?direct`)).toBe('a {}\n@source "/opt/extension";\n');
      expect(transform("a {}", "/console/src/other.css")).toBeNull();
      expect(transform("a {}", "/opt/extension/style.css")).toBeNull();
    });

    test("compares the stylesheet and the module id as normalized paths", () => {
      // Vite hands transforms normalized ids; the configured stylesheet path
      // may not be (a "./" or doubled separator, or Windows separators).
      const plugin = hostExtensionTailwindSource(
        "/opt/extension",
        "/console/./src//styles.css",
      );
      if (!plugin) throw new Error("expected a plugin for a configured extension");
      const transform = transformOf(plugin);
      expect(transform("a {}", "/console/src/styles.css")).toBe('a {}\n@source "/opt/extension";\n');
      expect(transform("a {}", "/console/src/styles.css?inline")).toBe(
        'a {}\n@source "/opt/extension";\n',
      );
      expect(transform("a {}", "/console/src/other.css")).toBeNull();
    });

    test("the vite config adds the source before Tailwind's own plugin", async () => {
      const config = await readFile(new URL("./vite.config.ts", import.meta.url), "utf8");
      const source = config.search(
        /hostExtensionTailwindSource\(\s*process\.env\.OPENGENI_WEB_HOST_EXTENSION,/,
      );
      expect(source).toBeGreaterThan(-1);
      expect(source).toBeLessThan(config.indexOf("tailwindcss()"));
    });

    /** Builds a one-stylesheet project with Tailwind and returns its CSS. */
    async function tailwindBuild(configured: string | undefined, root?: string): Promise<string> {
      const project = root ?? (await directoryWith({}));
      await writeFile(path.join(project, "styles.css"), "@tailwind utilities;\n");
      await writeFile(path.join(project, "entry.js"), 'import "./styles.css";\n');
      const outDir = path.join(project, "out");
      await build({
        configFile: false,
        logLevel: "silent",
        root: project,
        plugins: [
          hostExtensionTailwindSource(configured, path.join(project, "styles.css")),
          tailwindcss(),
        ],
        build: {
          outDir,
          lib: { entry: path.join(project, "entry.js"), formats: ["es"], fileName: "entry" },
        },
      });
      const files = (await readdir(outDir)).filter((name) => name.endsWith(".css"));
      const css = await Promise.all(files.map((name) => readFile(path.join(outDir, name), "utf8")));
      await rm(outDir, { recursive: true, force: true });
      return css.join("\n");
    }

    const extensionFiles = {
      "index.js": `export const className = "${EXTENSION_ONLY_CLASS}";`,
      "style.css": "",
    };

    test("a build generates a class only the configured extension uses", async () => {
      const extension = await directoryWith(extensionFiles);
      expect(await tailwindBuild(extension)).toContain("4242em");
      expect(await tailwindBuild(undefined)).not.toContain("4242em");
    });

    test("a build scans an extension directory its own repository ignores", async () => {
      // A host builds its extension into a directory its .gitignore lists.
      const repository = await directoryWith({ ".gitignore": "dist/\n" });
      await mkdir(path.join(repository, ".git"));
      const extension = path.join(repository, "dist");
      await mkdir(extension);
      for (const [name, content] of Object.entries(extensionFiles)) {
        await writeFile(path.join(extension, name), content);
      }
      // Tailwind's own scan of the repository skips the ignored directory...
      expect(await tailwindBuild(undefined, repository)).not.toContain("4242em");
      // ...and the explicit source still reaches it.
      expect(await tailwindBuild(extension, repository)).toContain("4242em");
    });
  });
});
