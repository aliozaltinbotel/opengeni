import { describe, expect, spyOn, test } from "bun:test";
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
  createHostToolRegistryLoader,
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

    /**
     * Each module specifier a source imports (static, side-effect, re-export or
     * import()). `@/…` and relative ones resolve under src; a `.js`, `.ts` or
     * `.tsx` extension and a trailing `/index` are dropped.
     */
    function importedModules(file: string, source: string): string[] {
      const specifiers = source.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm,
      );
      return Array.from(specifiers, ([, specifier = ""]) => moduleOf(file, specifier));
    }

    function moduleOf(file: string, specifier: string): string {
      const resolved = specifier.startsWith("@/")
        ? specifier.slice(2)
        : specifier.startsWith(".")
          ? join(dirname(file), specifier)
          : specifier;
      return resolved.replace(/\.(?:js|ts|tsx)$/, "").replace(/\/index$/, "");
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

    type AstNode = Readonly<{
      type: string;
      start: number;
      callee?: AstNode;
      object?: AstNode;
      property?: AstNode;
      computed?: boolean;
      expression?: AstNode;
      imported?: AstNode;
      local?: AstNode;
      name?: string;
      value?: unknown;
      source?: AstNode | null;
      specifiers?: readonly AstNode[];
      declaration?: AstNode | null;
      declarations?: readonly AstNode[];
      init?: AstNode | null;
    }>;
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

    /** An identifier's name, or a string literal's value (`import { "x" as y }`, `r["x"]`). */
    function nameOf(node: AstNode | undefined): string | undefined {
      if (node?.type === "Identifier") return node.name;
      return typeof node?.value === "string" ? node.value : undefined;
    }

    function unwrapParentheses(node: AstNode | undefined): AstNode | undefined {
      return node?.type === "ParenthesizedExpression" ? unwrapParentheses(node.expression) : node;
    }

    /** The function a call runs at once: `(() => …)()`, `(function () {…})()` or `.call`/`.apply` of one. */
    function immediatelyInvoked(callee: AstNode | undefined): AstNode | undefined {
      const target = unwrapParentheses(callee);
      if (target && FUNCTION_NODES.has(target.type)) return target;
      if (target?.type !== "MemberExpression" || target.computed) return undefined;
      const invoked = unwrapParentheses(target.object);
      const method = nameOf(target.property);
      return invoked &&
        FUNCTION_NODES.has(invoked.type) &&
        (method === "call" || method === "apply")
        ? invoked
        : undefined;
    }

    /**
     * The local names a module binds to readers: aliased named imports and
     * namespace imports (`registryNamespaces`: those of the registry itself).
     */
    function readerBindings(
      file: string,
      program: AstNode,
    ): { readers: Set<string>; namespaces: Set<string>; registryNamespaces: Set<string> } {
      const readers = new Set(EXTENSION_READERS);
      const namespaces = new Set<string>();
      const registryNamespaces = new Set<string>();
      const body: unknown = Reflect.get(program, "body");
      for (const statement of Array.isArray(body) ? body : []) {
        if (!isAstNode(statement) || statement.type !== "ImportDeclaration") continue;
        const fromRegistry =
          moduleOf(file, nameOf(statement.source ?? undefined) ?? "") === "host-extension/registry";
        for (const specifier of statement.specifiers ?? []) {
          const local = nameOf(specifier.local);
          if (!local) continue;
          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.add(local);
            if (fromRegistry) registryNamespaces.add(local);
          }
          if (
            specifier.type === "ImportSpecifier" &&
            EXTENSION_READERS.has(nameOf(specifier.imported) ?? "")
          ) {
            readers.add(local);
          }
        }
      }
      return { readers, namespaces, registryNamespaces };
    }

    /**
     * `file:line` of each load-time read of the extension: a call to a reader
     * (under any import alias or through a namespace import) outside every
     * function body, where an IIFE's body counts as load time. Outside
     * registry.ts, a re-export of a reader counts too, because its importers
     * would escape this scan's names.
     */
    function moduleScopeReads(file: string, source: string): string[] {
      const { program, errors } = parseSync(file, source);
      expect(errors).toEqual([]);
      const root = program as unknown as AstNode;
      const { readers, namespaces, registryNamespaces } = readerBindings(file, root);
      const reads = new Set<number>();
      const lineOf = (node: AstNode): number => source.slice(0, node.start).split("\n").length;
      const isReader = (callee: AstNode | undefined): boolean => {
        const target = unwrapParentheses(callee);
        if (target?.type === "Identifier") return readers.has(target.name ?? "");
        const object = unwrapParentheses(target?.object);
        return (
          target?.type === "MemberExpression" &&
          object?.type === "Identifier" &&
          namespaces.has(object.name ?? "") &&
          EXTENSION_READERS.has(nameOf(target.property) ?? "")
        );
      };
      // A local binding that reaches a reader: an imported reader, or a
      // namespace import of the registry.
      const bindsReader = (local: string): boolean =>
        readers.has(local) || registryNamespaces.has(local);
      // An expression that is a reader itself (not a call of one): a bound
      // name, or a reader read off a registry namespace (`ns.reader`, `ns["reader"]`).
      const isReaderReference = (expression: AstNode | null | undefined): boolean => {
        const target = unwrapParentheses(expression ?? undefined);
        if (target?.type === "Identifier") return bindsReader(target.name ?? "");
        const object = unwrapParentheses(target?.object);
        return (
          target?.type === "MemberExpression" &&
          object?.type === "Identifier" &&
          registryNamespaces.has(object.name ?? "") &&
          EXTENSION_READERS.has(nameOf(target.property) ?? "")
        );
      };
      const reExportsReader = (node: AstNode): boolean => {
        if (node.type === "ExportAllDeclaration") {
          const from = nameOf(node.source ?? undefined) ?? "";
          return moduleOf(file, from) === "host-extension/registry";
        }
        if (node.type === "ExportDefaultDeclaration") return isReaderReference(node.declaration);
        if (node.type !== "ExportNamedDeclaration") return false;
        // `export const r = reader;` binds a reader under a new exported name.
        if ((node.declaration?.declarations ?? []).some(({ init }) => isReaderReference(init)))
          return true;
        const exported = (node.specifiers ?? []).map((specifier) => nameOf(specifier.local) ?? "");
        return exported.some((local) =>
          node.source ? EXTENSION_READERS.has(local) : bindsReader(local),
        );
      };
      // An IIFE's own body runs while the module loads.
      const loadTimeFunctions = new Set<AstNode>();
      const visit = (node: AstNode, inFunction: boolean): void => {
        if (node.type === "CallExpression" && !inFunction) {
          if (isReader(node.callee)) reads.add(lineOf(node));
          const invoked = immediatelyInvoked(node.callee);
          if (invoked) loadTimeFunctions.add(invoked);
        }
        if (file !== "host-extension/registry.ts" && reExportsReader(node)) {
          reads.add(lineOf(node));
        }
        const nested =
          inFunction || (FUNCTION_NODES.has(node.type) && !loadTimeFunctions.has(node));
        for (const value of Object.values(node)) {
          for (const child of Array.isArray(value) ? value : [value]) {
            if (isAstNode(child)) visit(child, nested);
          }
        }
      };
      visit(root, false);
      return Array.from(reads, (line) => `${file}:${line}`);
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

    test("the module-scope scan follows aliased and namespace imports of a reader", () => {
      const source = [
        'import { currentHostExtension as extension } from "./registry";',
        'import * as registry from "@/host-extension/registry";',
        "const product = extension().productName;",
        "const hidden = registry.hiddenNativeDestinations();",
        'const paths = registry["extensionSettingsPaths"]();',
        "export function Page() { return [extension(), registry.extensionSettingsPaths()]; }",
      ].join("\n");
      expect(moduleScopeReads("probe.ts", source)).toEqual([
        "probe.ts:3",
        "probe.ts:4",
        "probe.ts:5",
      ]);
    });

    test("the module-scope scan treats an IIFE body as load time", () => {
      const source = [
        "const hidden = (() => hiddenNativeDestinations())();",
        "const product = (function () { return currentHostExtension().productName; })();",
        "void (async () => { await Promise.resolve(); extensionSettingsPaths(); })();",
        "const later = (() => () => currentHostExtension())();",
        "(function () { currentHostExtension(); }).call(null);",
        "(function () { hiddenNativeDestinations(); }).apply(null, []);",
        "const deferred = (function () { return () => extensionSettingsPaths(); }).apply(null);",
      ].join("\n");
      expect(moduleScopeReads("probe.ts", source)).toEqual([
        "probe.ts:1",
        "probe.ts:2",
        "probe.ts:3",
        "probe.ts:5",
        "probe.ts:6",
      ]);
    });

    test("the module-scope scan finds a reader re-exported outside registry.ts", () => {
      const source = [
        'export { currentHostExtension } from "./registry";',
        'export { hiddenNativeDestinations as hidden } from "@/host-extension/registry";',
        'import { extensionSettingsPaths as paths } from "./registry";',
        "export { paths };",
        'export * from "./registry.ts";',
        'export * as registry from "../host-extension/registry";',
        'export { productName } from "./brand";',
        "export default paths;",
        'import * as extensionRegistry from "./registry";',
        "export { extensionRegistry };",
        "export { extensionRegistry as readers };",
        'import { productName } from "./brand";',
        "export default productName;",
        'import * as brand from "./brand";',
        "export { brand };",
        "export const r = currentHostExtension;",
        "export default extensionRegistry.currentHostExtension;",
        'export const s = extensionRegistry["hiddenNativeDestinations"], t = productName;',
        "export const u = brand.currentHostExtension;",
      ].join("\n");
      expect(moduleScopeReads("host-extension/probe.ts", source)).toEqual([
        "host-extension/probe.ts:1",
        "host-extension/probe.ts:2",
        "host-extension/probe.ts:4",
        "host-extension/probe.ts:5",
        "host-extension/probe.ts:6",
        "host-extension/probe.ts:8",
        "host-extension/probe.ts:10",
        "host-extension/probe.ts:11",
        "host-extension/probe.ts:16",
        "host-extension/probe.ts:17",
        "host-extension/probe.ts:18",
      ]);
      expect(moduleScopeReads("host-extension/registry.ts", source)).toEqual([]);
    });

    test("the importer scan resolves extensions and index modules", () => {
      const source = [
        'import { a } from "./startup.js";',
        'import "@/host-extension/startup/index";',
        'export { b } from "./startup/index.ts";',
        'const c = import("../host-extension/startup.tsx");',
        'import "@opengeni/web-host-extension/style.css";',
      ].join("\n");
      expect(importedModules("host-extension/probe.ts", source)).toEqual([
        "host-extension/startup",
        "host-extension/startup",
        "host-extension/startup",
        "host-extension/startup",
        "@opengeni/web-host-extension/style.css",
      ]);
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

    test.each(["knowledge_search", "memory_propose"])(
      "installs an exact host-prefixed entry for %s",
      (leaf) => {
        for (const hash of ["0123456789abcdef", "0123456789abcdef01234567"]) {
          const extension = extensionWith({
            toolRegistryEntries: [{ ...entry, name: `mcp_${hash}__${leaf}` }],
          });
          const slot = createHostExtensionSlot();
          expect(slot.install(extension)).toBe(extension);
          expect(slot.current()).toBe(extension);
        }
      },
    );

    test.each([true, undefined])(
      "refuses a host-prefixed built-in leaf with matchPrefixedLeaf %p",
      (matchPrefixedLeaf) => {
        expectInvalid(
          {
            id: "fixture",
            toolRegistryEntries: [
              {
                ...entry,
                name: "mcp_0123456789abcdef__knowledge_search",
                matchPrefixedLeaf,
              },
            ],
          },
          "toolRegistryEntries[0].matchPrefixedLeaf",
        );
      },
    );

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

    test.each([
      "artifacts_create",
      "host-app__exec_command",
      "knowledge_search",
      "memory_propose",
      "opengeni__knowledge_search",
      "mcp__opengeni__knowledge_search",
      "opengeni__memory_propose",
      "mcp__opengeni__memory_propose",
      "mcp_invalid__knowledge_search",
      "mcp_0123__knowledge_search",
      "mcp_0123456789ABCDEF__knowledge_search",
    ])("refuses an entry for %p, which a built-in card already renders", (name) => {
      expectInvalid(
        extensionWith({ toolRegistryEntries: [{ ...entry, name }] }),
        "toolRegistryEntries[0].name",
      );
    });

    test("refuses two entries for one tool name", () => {
      expectInvalid(
        extensionWith({ toolRegistryEntries: [entry, { ...entry, render: Page }] }),
        "toolRegistryEntries[1].name",
      );
    });

    test("accepts a tool-card loader and refuses one that is not a function", () => {
      const extension = extensionWith({ toolRegistryLoader: async () => [entry] });
      expect(validateHostExtension(extension)).toBe(extension);
      expectInvalid({ id: "fixture", toolRegistryLoader: [entry] }, "toolRegistryLoader");
    });

    test("a loaded entry repeating an installed or loaded name is dropped with one warning", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const other = { ...entry, name: "host-app__list_tasks" };
        // A built bundle is untyped at runtime: it can return entries its types rule out.
        const loaded: readonly unknown[] = [
          entry,
          other,
          { ...other, render: Page },
          { ...other, name: "host-app__x", render: 1 },
        ];
        const loader = createHostToolRegistryLoader(
          async () => loaded as readonly (typeof entry)[],
          [entry],
        );
        expect(await loader()).toEqual([other]);
        expect(warn.mock.calls).toEqual([
          [
            "HOST_TOOL_REGISTRY_ENTRY_REFUSED",
            [
              "toolRegistryLoader[0].name",
              "toolRegistryLoader[2].name",
              "toolRegistryLoader[3].render",
            ],
          ],
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    test("a loader that rejects or resolves no array rejects, for the registry to fall back", async () => {
      const failure = new Error("host failure");
      await expect(
        createHostToolRegistryLoader(() => Promise.reject(failure), undefined)(),
      ).rejects.toBe(failure);
      const notAList = (async () => ({ entries: [entry] })) as unknown as () => Promise<
        readonly never[]
      >;
      await expect(createHostToolRegistryLoader(notAList, undefined)()).rejects.toThrow(
        "HOST_EXTENSION_INVALID: toolRegistryLoader must resolve to an array",
      );
    });
  });

  describe("native rail overrides", () => {
    test("accepts a relabel, a move to chat and an entry left off the rail", () => {
      const extension = extensionWith({
        navOverrides: [
          { id: "inbox", label: "Agent requests", group: "chat" },
          { id: "artifacts", group: "chat" },
          { id: "meetings", group: "hidden" },
          { id: "plugins", label: "Agent skills", group: "peer" },
        ],
      });
      expect(validateHostExtension(extension)).toBe(extension);
    });

    test.each([
      [[{ id: "secrets" }], "navOverrides[0].id"],
      [[{ id: "pms" }], "navOverrides[0].id"],
      [[{ id: "inbox" }, { id: "state" }, { id: "inbox", label: "Again" }], "navOverrides[2].id"],
      [[{ id: "inbox", label: "" }], "navOverrides[0].label"],
      [[{ id: "inbox", group: "settings" }], "navOverrides[0].group"],
      [[{ id: "inbox", icon: Icon }], "navOverrides[0].icon"],
    ])("refuses the overrides %p at %s", (navOverrides, field) => {
      expectInvalid({ id: "fixture", navOverrides }, field);
    });

    test("accepts native entries moved into a settings group, Insights included", () => {
      const extension = extensionWith({
        settingsGroups: [{ id: "setup", label: "Setup" }],
        navOverrides: [
          { id: "insights", label: "Agent usage", settingsGroup: "setup" },
          { id: "state", label: "Know-how", settingsGroup: "setup" },
        ],
      });
      expect(validateHostExtension(extension)).toBe(extension);
      const hiddenInsights = extensionWith({
        navOverrides: [{ id: "insights", group: "hidden" }],
      });
      expect(validateHostExtension(hiddenInsights)).toBe(hiddenInsights);
    });

    test.each([
      [[{ id: "state", settingsGroup: "missing" }], "navOverrides[0].settingsGroup"],
      [[{ id: "state", settingsGroup: "" }], "navOverrides[0].settingsGroup"],
      [[{ id: "state", group: "peer", settingsGroup: "setup" }], "navOverrides[0].settingsGroup"],
      [[{ id: "inbox", settingsGroup: "setup" }], "navOverrides[0].settingsGroup"],
      [[{ id: "insights", group: "chat" }], "navOverrides[0].group"],
    ])("refuses the settings-group overrides %p at %s", (navOverrides, field) => {
      expectInvalid(
        { id: "fixture", settingsGroups: [{ id: "setup", label: "Setup" }], navOverrides },
        field,
      );
    });

    test("refuses an override of a destination the extension hides", () => {
      expectInvalid(
        extensionWith({
          hiddenNativeDestinations: ["meetings"],
          navOverrides: [{ id: "meetings", label: "Calls" }],
        }),
        "navOverrides[0].id",
      );
    });
  });

  describe("landing", () => {
    test("accepts sessions and one of the extension's own static routes", () => {
      for (const landing of ["sessions", "operations/today"]) {
        const extension = extensionWith({ routes: [route("operations/today")], landing });
        expect(validateHostExtension(extension)).toBe(extension);
      }
    });

    test.each([
      ["reports", [route("operations")]],
      ["inbox", [route("operations")]],
      ["operations/$itemId", [route("operations/$itemId")]],
      ["", [route("operations")]],
    ])("refuses the landing %p", (landing, routes) => {
      expectInvalid(extensionWith({ routes, landing }), "landing");
    });
  });

  describe("outside-workspace routes", () => {
    const OutsidePage = () => null;
    const outsideLoad = async () => ({ default: OutsidePage });

    test("accepts public and signed-in pages at their own top-level segments", () => {
      const extension = extensionWith({
        outsideWorkspaceRoutes: [
          { path: "register", load: outsideLoad, access: "public" },
          { path: "not-admitted", load: outsideLoad },
          { path: "identity/ambiguous", load: outsideLoad, access: "signedIn" },
        ],
        outsideWorkspaceProviders: [Page],
      });
      expect(validateHostExtension(extension)).toBe(extension);
    });

    test.each([
      "workspaces",
      "sessions/mine",
      "settings",
      "reset-password",
      "v1/thing",
      "dev",
      "Register",
      "register/$token",
      "/register",
    ])("refuses the outside path %p", (path) => {
      expectInvalid(
        extensionWith({ outsideWorkspaceRoutes: [{ path, load: outsideLoad }] }),
        "outsideWorkspaceRoutes[0].path",
      );
    });

    test("refuses a path registered twice, a missing load and an unknown access", () => {
      expectInvalid(
        extensionWith({
          outsideWorkspaceRoutes: [
            { path: "register", load: outsideLoad },
            { path: "register", load: outsideLoad },
          ],
        }),
        "outsideWorkspaceRoutes[1].path",
      );
      expectInvalid(
        { id: "fixture", outsideWorkspaceRoutes: [{ path: "register" }] },
        "outsideWorkspaceRoutes[0].load",
      );
      expectInvalid(
        {
          id: "fixture",
          outsideWorkspaceRoutes: [{ path: "register", load: outsideLoad, access: "admin" }],
        },
        "outsideWorkspaceRoutes[0].access",
      );
      expectInvalid(
        { id: "fixture", outsideWorkspaceProviders: ["provider"] },
        "outsideWorkspaceProviders[0]",
      );
    });

    test("refuses a page under every first segment App.tsx registers at the top level", async () => {
      const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
      const parentCount = app.split("getParentRoute: () => rootRoute,").length - 1;
      const paths = Array.from(
        app.matchAll(
          /getParentRoute: \(\) => rootRoute,((?:(?!createRoute\()[\s\S])*?)\bpath: ([^,]+),/g,
        ),
        (match) => match[2] ?? "",
      );
      expect(paths.length).toBe(parentCount);
      const segments = new Set(
        paths
          .map((path) =>
            path.startsWith('"')
              ? path.slice(1, -1)
              : path === "EXCEL_ADDIN_PATH.slice(1)"
                ? "excel"
                : path === "DESKTOP_APP_RETURN_PATH.slice(1)"
                  ? "desktop-return"
                  : `unknown:${path}`,
          )
          .map((path) => path.replace(/^\//, "").split("/")[0] ?? "")
          .filter((segment) => segment !== ""),
      );
      expect([...segments].filter((segment) => segment.startsWith("unknown:"))).toEqual([]);
      expect(segments.size).toBeGreaterThanOrEqual(15);
      for (const segment of segments) {
        expectInvalid(
          extensionWith({
            outsideWorkspaceRoutes: [{ path: `${segment}/host-page`, load: outsideLoad }],
          }),
          "outsideWorkspaceRoutes[0].path",
        );
      }
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
