import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSync } from "oxc-parser";
import {
  EMPTY_HOST_EXTENSION,
  type HostExtension,
  type HostExtensionNavItem,
  type HostExtensionRoute,
} from "@opengeni/react/app/host-extension";

import {
  createHostExtensionSlot,
  currentHostExtension,
  extensionSettingsPaths,
  hiddenNativeDestinations,
  validateHostExtension,
} from "./registry";

// The console installs its extension once, from its startup module.
const startup = await import("./startup");

const Page = () => null;
const Icon = () => null;
const load: HostExtensionRoute["load"] = async () => ({ default: Page });

function route(path: string): HostExtensionRoute {
  return { path, load };
}

function navItem(path: string, id = "item"): HostExtensionNavItem {
  return { id, label: "Item", icon: Icon, path, placement: "primary" };
}

function extensionWith(fields: Omit<HostExtension, "id">): HostExtension {
  return { id: "fixture", ...fields };
}

function expectInvalid(value: unknown, field: string): void {
  expect(() => validateHostExtension(value)).toThrow(
    new RegExp(`^HOST_EXTENSION_INVALID: ${field.replaceAll(/[[\].]/g, "\\$&")} `),
  );
}

describe("host extension registry", () => {
  test("returns the empty extension unchanged", () => {
    expect(validateHostExtension(EMPTY_HOST_EXTENSION)).toBe(EMPTY_HOST_EXTENSION);
  });

  test("installs the stock stub at startup when no extension is configured", () => {
    expect(startup.hostExtension).toEqual({ id: "none" });
    expect(currentHostExtension()).toBe(startup.hostExtension);
    expect(hiddenNativeDestinations()).toEqual([]);
    expect(extensionSettingsPaths()).toEqual([]);
  });

  describe("installation", () => {
    test("installs a validated extension once and serves it to every reader", () => {
      const slot = createHostExtensionSlot();
      const extension = extensionWith({
        routes: [route("operations"), { ...route("prefs"), mode: "settings" }],
        hiddenNativeDestinations: ["automations"],
      });
      expect(slot.install(extension)).toBe(extension);
      expect(slot.current()).toBe(extension);
      expect(slot.settingsPaths()).toEqual(["prefs"]);
      expect(slot.settingsPaths()).toBe(slot.settingsPaths());
      expect(() => slot.install(extension)).toThrow(/^HOST_EXTENSION_INSTALLED: /);
    });

    test("refuses an extension that does not validate, and installs nothing", () => {
      const slot = createHostExtensionSlot();
      expect(() => slot.install({ id: "" })).toThrow(/^HOST_EXTENSION_INVALID: id /);
      expect(() => slot.install(EMPTY_HOST_EXTENSION)).not.toThrow();
    });

    test("refuses to install after a reader already saw the stock settings paths", () => {
      const slot = createHostExtensionSlot();
      expect(slot.settingsPaths()).toEqual([]);
      expect(() => slot.install(EMPTY_HOST_EXTENSION)).toThrow(
        /^HOST_EXTENSION_READ_BEFORE_INSTALL: /,
      );
    });

    test("refuses to install after a reader already saw the stock extension", () => {
      // A reader before installation would keep stock values, so a late
      // install fails loudly instead of leaving the console half-extended.
      const slot = createHostExtensionSlot();
      expect(slot.current()).toBe(EMPTY_HOST_EXTENSION);
      expect(() => slot.install(EMPTY_HOST_EXTENSION)).toThrow(
        /^HOST_EXTENSION_READ_BEFORE_INSTALL: /,
      );
    });
  });

  describe("startup wiring", () => {
    // A lazy route that statically reaches a module with import() reshuffles
    // the startup chunks, so the descriptor (whose pages load through
    // import()) is reached from the main entry's startup module alone, and
    // only main-entry modules import that startup module.
    const sourceRoot = new URL("..", import.meta.url).pathname;

    async function consoleSources(): Promise<{ file: string; source: string }[]> {
      const sources: { file: string; source: string }[] = [];
      for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: sourceRoot })) {
        if (/\.test\.tsx?$/.test(file)) continue;
        sources.push({ file, source: await readFile(join(sourceRoot, file), "utf8") });
      }
      return sources.sort((left, right) => (left.file < right.file ? -1 : 1));
    }

    /** Each module specifier a source imports (static, side-effect, re-export or import()), resolved under src. */
    function importedModules(file: string, source: string): string[] {
      const specifiers = source.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm,
      );
      return Array.from(specifiers, ([, specifier = ""]) => {
        if (specifier.startsWith("@/")) return specifier.slice(2);
        if (specifier.startsWith(".")) return join(dirname(file), specifier);
        return specifier;
      });
    }

    test("only the startup module imports the build's extension", async () => {
      const importers = (await consoleSources())
        .filter(({ file, source }) =>
          importedModules(file, source).includes("@opengeni/web-host-extension"),
        )
        .map(({ file }) => file);
      expect(importers).toEqual(["host-extension/startup.ts"]);
      const main = await readFile(join(sourceRoot, "main.tsx"), "utf8");
      expect(main).toMatch(/^import "\.\/app-host";$/m);
    });

    test("only main-entry modules import the startup module", async () => {
      const importers = (await consoleSources())
        .filter(({ file, source }) =>
          importedModules(file, source).includes("host-extension/startup"),
        )
        .map(({ file }) => file);
      expect(importers).toEqual(["App.tsx", "app-host.ts"]);
    });

    const EXTENSION_READERS: ReadonlySet<string> = new Set([
      "currentHostExtension",
      "hiddenNativeDestinations",
      "extensionSettingsPaths",
    ]);

    type AstNode = Readonly<{ type: string; start: number; callee?: AstNode; name?: string }>;
    const FUNCTION_NODES: ReadonlySet<string> = new Set([
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ]);

    function isAstNode(value: unknown): value is AstNode {
      return (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "type") === "string"
      );
    }

    /** `file:line` of each call to an extension reader outside every function body. */
    function moduleScopeReads(file: string, source: string): string[] {
      const { program, errors } = parseSync(file, source);
      expect(errors).toEqual([]);
      const reads: string[] = [];
      const visit = (node: AstNode, inFunction: boolean): void => {
        const callee = node.type === "CallExpression" ? node.callee : undefined;
        if (
          !inFunction &&
          callee?.type === "Identifier" &&
          EXTENSION_READERS.has(callee.name ?? "")
        ) {
          reads.push(`${file}:${source.slice(0, node.start).split("\n").length}`);
        }
        const nested = inFunction || FUNCTION_NODES.has(node.type);
        for (const value of Object.values(node)) {
          for (const child of Array.isArray(value) ? value : [value]) {
            if (isAstNode(child)) visit(child, nested);
          }
        }
      };
      visit(program as unknown as AstNode, false);
      return reads;
    }

    test("no module reads the extension while it loads, except main-entry App.tsx", async () => {
      // Shared chunks evaluate before the main entry's own modules, so a
      // module-scope read would see the stock extension (and make startup's
      // install throw). Reads inside functions run at call time.
      const reads = (await consoleSources())
        .filter(({ file }) => file !== "App.tsx")
        .flatMap(({ file, source }) => moduleScopeReads(file, source));
      expect(reads).toEqual([]);
    });

    test("the module-scope scan finds a load-time read and skips call-time ones", () => {
      const source = [
        "const hidden = hiddenNativeDestinations();",
        "export function Page() { return currentHostExtension().productName; }",
        "export const paths = () => extensionSettingsPaths();",
        "export function Shell({ lifecycle = currentHostExtension().lifecycle }) { return lifecycle; }",
      ].join("\n");
      expect(moduleScopeReads("probe.ts", source)).toEqual(["probe.ts:1"]);
    });
  });

  test("accepts a complete extension", () => {
    const extension = extensionWith({
      productName: "Fixture",
      routes: [
        route("operations"),
        route("operations/items/$itemId"),
        { ...route("prefs"), mode: "settings" },
      ],
      nav: [
        navItem("operations"),
        { ...navItem("prefs", "prefs"), placement: { settingsGroup: "fixture" } },
      ],
      settingsGroups: [{ id: "fixture", label: "Fixture" }],
      hiddenNativeDestinations: ["plugins", "playground"],
      lifecycle: { onSignOut: async () => undefined },
    });
    expect(validateHostExtension(extension)).toBe(extension);
  });

  test.each([
    "sessions",
    "settings",
    "organization",
    "account",
    "inbox",
    "capabilities",
    "state",
    "plugins",
    "automations",
    "computer-use",
    "variable-sets",
    "environments",
  ])("refuses a route under the native segment %s", (segment) => {
    expectInvalid(
      extensionWith({ routes: [route("operations"), route(`${segment}/extra`)] }),
      "routes[1].path",
    );
  });

  test.each([
    "",
    "Operations",
    "1st",
    "operations/",
    "/operations",
    "operations//items",
    "operations/$1d",
    "a b",
  ])("refuses the malformed route path %p", (path) => {
    expectInvalid(extensionWith({ routes: [route(path)] }), "routes[0].path");
  });

  test("refuses a route under every first segment App.tsx registers below the workspace", async () => {
    const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
    const parentCount = app.split("getParentRoute: () => workspaceRoute,").length - 1;
    // Each workspace child's path, read up to the end of its own createRoute call.
    const paths = Array.from(
      app.matchAll(
        /getParentRoute: \(\) => workspaceRoute,((?:(?!createRoute\()[\s\S])*?)\bpath: "([^"]+)"/g,
      ),
      (match) => match[2] ?? "",
    );
    expect(paths.length).toBe(parentCount);
    const segments = new Set(
      paths.map((path) => path.split("/")[0] ?? "").filter((segment) => segment !== ""),
    );
    expect(segments.size).toBeGreaterThanOrEqual(27);
    for (const segment of segments) {
      expectInvalid(
        extensionWith({ routes: [route(`${segment}/extension-page`)] }),
        "routes[0].path",
      );
    }
  });

  test.each(["reports/$workspaceId", "reports/$itemId/lines/$itemId"])(
    "refuses the route path %p that redeclares a param",
    (path) => {
      expectInvalid(extensionWith({ routes: [route(path)] }), "routes[0].path");
    },
  );

  test("refuses two routes with one path", () => {
    expectInvalid(
      extensionWith({ routes: [route("operations"), route("reports"), route("operations")] }),
      "routes[2].path",
    );
  });

  test("refuses a nav item that points to an unknown route", () => {
    expectInvalid(
      extensionWith({
        routes: [route("operations")],
        nav: [navItem("operations"), navItem("reports", "reports")],
      }),
      "nav[1].path",
    );
  });

  test("refuses a value that is not an extension", () => {
    expectInvalid(null, "extension");
    expectInvalid({ id: "" }, "id");
    expectInvalid(
      extensionWith({ hiddenNativeDestinations: ["sessions" as never] }),
      "hiddenNativeDestinations[0]",
    );
    expectInvalid(
      extensionWith({
        routes: [route("operations")],
        nav: [{ ...navItem("operations"), placement: { settingsGroup: "missing" } }],
      }),
      "nav[0].placement.settingsGroup",
    );
  });

  describe("tool registry entries", () => {
    const Card = () => null;
    const entry = {
      match: "name",
      name: "host-app__get_onboarding_status",
      render: Card,
      matchPrefixedLeaf: false,
    } as const;

    test("accepts an exact-name entry that disables prefixed leaf matching", () => {
      const extension = extensionWith({ toolRegistryEntries: [entry] });
      expect(validateHostExtension(extension)).toBe(extension);
    });

    test("refuses an entry that allows prefixed leaf matching", () => {
      expectInvalid(
        { id: "fixture", toolRegistryEntries: [{ ...entry, matchPrefixedLeaf: true }] },
        "toolRegistryEntries[0].matchPrefixedLeaf",
      );
    });

    test("refuses an entry that leaves prefixed leaf matching at its default", () => {
      const { matchPrefixedLeaf: _omitted, ...withoutFlag } = entry;
      expectInvalid(
        { id: "fixture", toolRegistryEntries: [withoutFlag] },
        "toolRegistryEntries[0].matchPrefixedLeaf",
      );
    });

    test("refuses a raw-type entry", () => {
      expectInvalid(
        {
          id: "fixture",
          toolRegistryEntries: [{ match: "rawType", type: "computer_call", render: Card }],
        },
        "toolRegistryEntries[0].match",
      );
    });

    test.each(["artifacts_create", "host-app__exec_command"])(
      "refuses an entry for %p, which a built-in card already renders",
      (name) => {
        expectInvalid(
          extensionWith({ toolRegistryEntries: [{ ...entry, name }] }),
          "toolRegistryEntries[0].name",
        );
      },
    );

    test("refuses two entries for one tool name", () => {
      expectInvalid(
        extensionWith({ toolRegistryEntries: [entry, { ...entry, render: Page }] }),
        "toolRegistryEntries[1].name",
      );
    });
  });

  test("the prebuilt extension dist fixture is a valid extension with lazy pages", async () => {
    const fixture = new URL("../../test/fixtures/host-extension-dist/", import.meta.url);
    const loaded: { default: unknown } = await import(new URL("index.js", fixture).href);
    const extension = validateHostExtension(loaded.default);
    expect(extension.toolRegistryEntries).toHaveLength(1);
    const [fixtureRoute] = extension.routes ?? [];
    if (!fixtureRoute) throw new Error("the fixture dist registers no route");
    const page = await fixtureRoute.load();
    expect(typeof page.default).toBe("function");
    const style = await readFile(new URL("style.css", fixture), "utf8");
    expect(style.match(/--og-color-[a-z-]+:/g)).toHaveLength(2);
    expect(style).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
