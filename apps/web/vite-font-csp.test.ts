import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import config from "./vite.config";

test("small font assets remain same-origin files under font-src self", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-font-csp-"));
  try {
    const font = Buffer.alloc(1024, 42);
    await writeFile(path.join(root, "index.html"), '<link rel="stylesheet" href="./style.css">');
    await writeFile(path.join(root, "style.css"), '@font-face{font-family:Fixture;src:url("./small.woff2")}body{background:url("./small.svg")}');
    await writeFile(path.join(root, "small.woff2"), font);
    await writeFile(path.join(root, "small.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
    await build({
      configFile: false,
      root,
      logLevel: "silent",
      build: { assetsInlineLimit: config.build?.assetsInlineLimit },
    });
    const assets = path.join(root, "dist/assets");
    const names = await readdir(assets);
    const cssName = names.find((name) => name.endsWith(".css"));
    if (!cssName) throw new Error("fixture build omitted CSS");
    const css = await readFile(path.join(assets, cssName), "utf8");
    expect(css).not.toContain("data:font");
    const fontName = names.find((name) => name.endsWith(".woff2"));
    expect(fontName).toBeDefined();
    if (!fontName) throw new Error("fixture build inlined its small font");
    expect(await readFile(path.join(assets, fontName))).toEqual(font);
    expect(css).toContain(fontName);
    expect(css).toContain("data:image/svg+xml");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
