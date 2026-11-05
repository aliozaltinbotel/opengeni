import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("bundled document parsing retains the LiteParse native closure", async () => {
  const temporaryRoot = await mkdtemp(join(root, "apps/worker/.native-closure-"));
  const entrypoint = join(temporaryRoot, "entry.ts");
  const outdir = join(temporaryRoot, "dist");

  try {
    await mkdir(outdir, { recursive: true });
    await writeFile(
      entrypoint,
      `import { LiteParse } from "@llamaindex/liteparse";

new LiteParse({ ocrEnabled: true, numWorkers: 1 });
process.stdout.write("liteparse-native-runtime-ready");
`,
    );

    // Bun.build mutates process-global resolver state. Keep the compiler smoke
    // test in a child process so it cannot contaminate later test modules.
    const buildProcess = Bun.spawn({
      cmd: [
        "bun",
        "build",
        entrypoint,
        `--outdir=${outdir}`,
        "--target=bun",
        "--format=esm",
        "--splitting",
        "--minify-syntax",
        "--minify-whitespace",
        "--external=@llamaindex/liteparse",
        "--external=sharp",
      ],
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildExitCode, buildStdout, buildStderr] = await Promise.all([
      buildProcess.exited,
      new Response(buildProcess.stdout).text(),
      new Response(buildProcess.stderr).text(),
    ]);
    expect(buildExitCode, `${buildStdout}\n${buildStderr}`).toBe(0);

    const process = Bun.spawn({
      cmd: ["bun", join(outdir, "entry.js")],
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("liteparse-native-runtime-ready");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("host context signal survives source versus production-bundle class identity", async () => {
  const temporaryRoot = await mkdtemp(join(root, "packages/runtime/.host-context-boundary-"));
  const outdir = join(temporaryRoot, "dist");
  try {
    const entrypoint=join(root,"packages/runtime/src/model-provider-errors.ts");
    const build=Bun.spawn({cmd:[process.execPath,"build",entrypoint,`--outdir=${outdir}`,"--target=bun","--format=esm","--splitting","--minify-syntax","--minify-whitespace"],cwd:root,stdout:"pipe",stderr:"pipe",stdin:"ignore"});
    const [code,output,error]=await Promise.all([build.exited,new Response(build.stdout).text(),new Response(build.stderr).text()]);
    expect(code,`${output}\n${error}`).toBe(0);
    const source=await import("../packages/runtime/src/model-provider-errors");
    const bundled=await import(join(outdir,"model-provider-errors.js"));
    const signal=new source.HostContextChangedError();
    expect(signal instanceof bundled.HostContextChangedError).toBe(false);
    expect(bundled.isHostContextChangedError(signal)).toBe(true);
    expect(source.isHostContextChangedError(new bundled.HostContextChangedError())).toBe(true);
    const brand=Symbol.for("opengeni.host-context-changed.v1");
    const textOnly=Object.assign(new Error(signal.message),{name:signal.name,code:signal.code});
    const accessor=Object.defineProperty(new Error(),brand,{get(){throw Error("must not invoke getter");}});
    const mutable=Object.defineProperty(new Error(),brand,{value:true,writable:true});
    for(const rejected of [textOnly,JSON.parse(JSON.stringify(signal)),Object.create(signal),accessor,mutable,new Proxy(new Error(),{getOwnPropertyDescriptor(){throw Error("unreadable");}})]){
      expect(bundled.isHostContextChangedError(rejected)).toBe(false);
    }
  } finally { await rm(temporaryRoot,{recursive:true,force:true}); }
});
