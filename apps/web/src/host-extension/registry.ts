// The console's host extension: its check, and the slot every console module
// reads it from. The bundle comes from outside this build, so its shape is
// checked at runtime: a malformed or colliding route is refused with the field
// it names, never left to shadow a native page.
//
// This module does not import the extension itself. startup.ts, which only the
// main entry reaches, imports the build's `@opengeni/web-host-extension` and
// installs it here; lazy routes import this module, and a descriptor with
// import() that lazy routes reach statically reshuffles the startup chunks.
import {
  EMPTY_HOST_EXTENSION,
  isBuiltInToolCardName,
  isNativeDestination,
  isNativeNavId,
  isNativeSectionId,
  nativeNavDestination,
  type HostExtension,
  type HostExtensionContext,
  type HostExtensionStarter,
  type HostExtensionOutsideWorkspaceRoute,
  type HostToolRegistryEntry,
  type NativeDestination,
  type NativeSectionId,
} from "@opengeni/react/app/host-extension";

/** Lowercase segments with optional `$param` segments, relative to the workspace. */
const ROUTE_PATH = /^[a-z][a-z0-9-]*(\/(\$?[a-zA-Z][a-zA-Z0-9]*|[a-z0-9-]+))*$/;

/**
 * First path segments the native console owns under workspaces/$workspaceId/
 * besides its native destinations, including redirect-only ones. Kept static
 * (App.tsx's routes are built after this module runs); registry.test.ts fails
 * when App.tsx adds one not listed. Plain strings: a load-time read of the
 * contract module's bindings could run before that module in a chunk cycle.
 */
const OTHER_NATIVE_SEGMENTS: ReadonlySet<string> = new Set([
  "sessions",
  "settings",
  "organization",
  "account",
  "inbox",
  "capabilities",
  "state",
  "agent",
  "agents",
  "priority",
  "schedules",
  "documents",
  "memory",
  "sites",
]);

/**
 * First path segments the native console owns at its top level (App.tsx's
 * root routes, and the API and asset paths served beside it). A host page
 * outside any workspace must start with another segment; registry.test.ts
 * fails when App.tsx adds a root route not listed.
 */
const NATIVE_TOP_LEVEL_SEGMENTS: ReadonlySet<string> = new Set([
  "sessions",
  "identity-links",
  "billing",
  "integrations",
  "teams",
  "connect-agent",
  "device",
  "reset-password",
  "excel",
  "desktop-return",
  "setup-account",
  "account-auth",
  "settings",
  "reauthenticate",
  "native-sign-in",
  "site-auth",
  "dev",
  "workspaces",
  "v1",
  "api",
  "assets",
  "auth",
  "oauth",
  "mcp",
]);

/** Lowercase static segments: an outside-workspace page path (no params). */
const OUTSIDE_ROUTE_PATH = /^[a-z][a-z0-9-]*(\/[a-z0-9-]+)*$/;

/** The workspace route's own param, which an extension path must not redeclare. */
const WORKSPACE_PARAM = "$workspaceId";

export class HostExtensionInvalidError extends Error {
  readonly code = "HOST_EXTENSION_INVALID";

  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`HOST_EXTENSION_INVALID: ${field} ${reason}`);
    this.name = "HostExtensionInvalidError";
  }
}

type Fields = Readonly<Record<string, unknown>>;

function fail(field: string, reason: string): never {
  throw new HostExtensionInvalidError(field, reason);
}

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Fields {
  return isRecord(value) ? value : fail(field, "must be an object");
}

function text(value: unknown, field: string): string {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : fail(field, "must be a non-empty string");
}

function optionalText(value: unknown, field: string): void {
  if (value !== undefined) text(value, field);
}

function optionalFunction(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "function") fail(field, "must be a function");
}

/** A React component: a function, or a memo/forwardRef/lazy object. */
function component(value: unknown, field: string): void {
  if (typeof value !== "function" && !(isRecord(value) && "$$typeof" in value)) {
    fail(field, "must be a React component");
  }
}

function checkSessionIndicator(value: unknown): void {
  if (value === undefined) return;
  component(value, "sessionIndicator");
  const wrappers: readonly symbol[] = [Symbol.for("react.memo"), Symbol.for("react.forward_ref"), Symbol.for("react.lazy")];
  if (isRecord(value) && !(typeof value.$$typeof === "symbol" && wrappers.includes(value.$$typeof))) {
    fail("sessionIndicator", "must be a supported React component");
  }
}

function list(value: unknown, field: string): readonly unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : fail(field, "must be an array");
}

function checkRoutePath(path: string, field: string): void {
  if (!ROUTE_PATH.test(path)) fail(field, `"${path}" is not a lowercase relative route path`);
  const segments = path.split("/");
  const first = segments[0] ?? "";
  if (isNativeDestination(first) || OTHER_NATIVE_SEGMENTS.has(first))
    fail(field, `"${path}" collides with the native "${first}" route`);
  const params = new Set<string>();
  for (const param of segments.filter((segment) => segment.startsWith("$"))) {
    if (param === WORKSPACE_PARAM) fail(field, `"${path}" redeclares the workspace's ${param}`);
    if (params.has(param)) fail(field, `"${path}" declares ${param} twice`);
    params.add(param);
  }
}

/** Only these keys, or the field names the first one it does not know. */
function knownKeys(value: Fields, field: string, keys: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) fail(`${field}.${unknown}`, "is not a known field");
}

function checkOutsideWorkspaceRoutes(value: unknown): void {
  const paths = new Set<string>();
  list(value, "outsideWorkspaceRoutes").forEach((entry, index) => {
    const field = `outsideWorkspaceRoutes[${index}]`;
    const route = record(entry, field);
    const path =
      typeof route.path === "string" ? route.path : fail(`${field}.path`, "must be a string");
    if (!OUTSIDE_ROUTE_PATH.test(path))
      fail(`${field}.path`, `"${path}" is not a lowercase static route path`);
    const first = path.split("/")[0] ?? "";
    if (NATIVE_TOP_LEVEL_SEGMENTS.has(first))
      fail(`${field}.path`, `"${path}" collides with the native "${first}" route`);
    if (paths.has(path)) fail(`${field}.path`, `"${path}" is registered twice`);
    if (typeof route.load !== "function") fail(`${field}.load`, "must be a function");
    if (route.access !== undefined && route.access !== "public" && route.access !== "signedIn")
      fail(`${field}.access`, 'must be "public" or "signedIn"');
    paths.add(path);
  });
}

function routePaths(value: unknown): ReadonlySet<string> {
  const paths = new Set<string>();
  list(value, "routes").forEach((entry, index) => {
    const field = `routes[${index}]`;
    const route = record(entry, field);
    const path =
      typeof route.path === "string" ? route.path : fail(`${field}.path`, "must be a string");
    checkRoutePath(path, `${field}.path`);
    if (paths.has(path)) fail(`${field}.path`, `"${path}" is registered twice`);
    if (typeof route.load !== "function") fail(`${field}.load`, "must be a function");
    if (route.mode !== undefined && route.mode !== "rail" && route.mode !== "settings") {
      fail(`${field}.mode`, 'must be "rail" or "settings"');
    }
    paths.add(path);
  });
  return paths;
}

function settingsGroupIds(value: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  list(value, "settingsGroups").forEach((entry, index) => {
    const field = `settingsGroups[${index}]`;
    const group = record(entry, field);
    const id = text(group.id, `${field}.id`);
    text(group.label, `${field}.label`);
    if (ids.has(id)) fail(`${field}.id`, `"${id}" is registered twice`);
    ids.add(id);
  });
  return ids;
}

/**
 * Native entry overrides: known ids, once each, never a destination the
 * extension hides; a settings group is a registered one, never with `group`
 * and never for the inbox; Insights stays out of the chat group.
 */
function checkNavOverrides(
  value: unknown,
  hidden: readonly unknown[],
  groups: ReadonlySet<string>,
): void {
  const ids = new Set<string>();
  list(value, "navOverrides").forEach((entry, index) => {
    const field = `navOverrides[${index}]`;
    const override = record(entry, field);
    knownKeys(override, field, ["id", "label", "group", "settingsGroup"]);
    const id = override.id;
    if (!isNativeNavId(id)) fail(`${field}.id`, `"${String(id)}" is not a native rail entry`);
    if (ids.has(id)) fail(`${field}.id`, `"${id}" is overridden twice`);
    const destination = nativeNavDestination(id);
    if (destination !== null && hidden.includes(destination))
      fail(`${field}.id`, `"${id}" is a hidden native destination`);
    ids.add(id);
    optionalText(override.label, `${field}.label`);
    if (
      override.group !== undefined &&
      override.group !== "peer" &&
      override.group !== "chat" &&
      override.group !== "hidden"
    )
      fail(`${field}.group`, 'must be "peer", "chat" or "hidden"');
    if (id === "insights" && override.group === "chat")
      fail(`${field}.group`, '"insights" is a settings page and cannot join the chat group');
    if (override.settingsGroup !== undefined) {
      const group = text(override.settingsGroup, `${field}.settingsGroup`);
      if (!groups.has(group))
        fail(`${field}.settingsGroup`, `"${group}" is not a registered settings group`);
      if (override.group !== undefined)
        fail(`${field}.settingsGroup`, "set either group or settingsGroup, not both");
      if (id === "inbox") fail(`${field}.settingsGroup`, '"inbox" stays on the primary rail');
    }
  });
}

function checkNav(value: unknown, paths: ReadonlySet<string>, groups: ReadonlySet<string>): void {
  const ids = new Set<string>();
  list(value, "nav").forEach((entry, index) => {
    const field = `nav[${index}]`;
    const item = record(entry, field);
    const id = text(item.id, `${field}.id`);
    if (ids.has(id)) fail(`${field}.id`, `"${id}" is registered twice`);
    ids.add(id);
    text(item.label, `${field}.label`);
    optionalText(item.description, `${field}.description`);
    component(item.icon, `${field}.icon`);
    const path = text(item.path, `${field}.path`);
    if (!paths.has(path)) fail(`${field}.path`, `"${path}" is not a registered route`);
    if (item.placement !== "primary") {
      const placement = record(item.placement, `${field}.placement`);
      const group = text(placement.settingsGroup, `${field}.placement.settingsGroup`);
      if (!groups.has(group))
        fail(`${field}.placement.settingsGroup`, `"${group}" is not a registered settings group`);
    }
    optionalFunction(item.visible, `${field}.visible`);
  });
}

function checkBrand(value: unknown): void {
  if (value === undefined) return;
  const brand = record(value, "brand");
  component(brand.mark, "brand.mark");
  component(brand.wordmark, "brand.wordmark");
}

/**
 * One tool card's rules, shared by install and the lazy loader: an exact
 * name, once among `names` (which then holds it), leaf matching off, no
 * built-in card's name, and a component.
 */
function checkToolRegistryEntry(item: unknown, field: string, names: Set<string>): void {
  const entry = record(item, field);
  if (entry.match !== "name") fail(`${field}.match`, 'must be "name"');
  const name = text(entry.name, `${field}.name`);
  if (names.has(name)) fail(`${field}.name`, `"${name}" is registered twice`);
  // An omitted flag enables leaf matching, which could capture another server's tool.
  if (entry.matchPrefixedLeaf !== false) fail(`${field}.matchPrefixedLeaf`, "must be false");
  const nativeLeaf = name.startsWith("mcp__opengeni__")
    ? name.slice("mcp__opengeni__".length)
    : name.startsWith("opengeni__")
      ? name.slice("opengeni__".length)
      : undefined;
  // Only hashed MCP wire names may deliberately replace a built-in leaf's card.
  const exactHostName = /^mcp_(?:[0-9a-f]{16}|[0-9a-f]{24})__[A-Za-z0-9_]+$/.test(name);
  // A stock build has no entries to check; the flag lets it drop the name list.
  if (
    import.meta.env.OPENGENI_WEB_HOST_EXTENSION_STOCK !== "true" &&
    ((nativeLeaf !== undefined && isBuiltInToolCardName(nativeLeaf)) ||
      (!exactHostName && isBuiltInToolCardName(name)))
  ) {
    fail(`${field}.name`, `"${name}" has a built-in card`);
  }
  component(entry.render, `${field}.render`);
  names.add(name);
}

function checkToolRegistryEntries(value: unknown): void {
  const names = new Set<string>();
  list(value, "toolRegistryEntries").forEach((item, index) =>
    checkToolRegistryEntry(item, `toolRegistryEntries[${index}]`, names),
  );
}

type ToolRegistryLoader = NonNullable<HostExtension["toolRegistryLoader"]>;

/**
 * The extension's tool-card loader, checked like install: each loaded entry
 * meets the install-time rules, against the installed entries' names too. A
 * refused entry is dropped, and one warning per load names the refused fields
 * only (never an entry). A rejection passes through to the caller.
 */
export function createHostToolRegistryLoader(
  source: ToolRegistryLoader,
  installed: HostExtension["toolRegistryEntries"],
): ToolRegistryLoader {
  return async () => {
    const loaded: unknown = await source();
    if (!Array.isArray(loaded)) fail("toolRegistryLoader", "must resolve to an array");
    const names = new Set((installed ?? []).map((entry) => entry.name));
    const kept: HostToolRegistryEntry[] = [];
    const refused: string[] = [];
    loaded.forEach((item: unknown, index) => {
      try {
        checkToolRegistryEntry(item, `toolRegistryLoader[${index}]`, names);
        // Checked just above, as install checks the eager entries.
        kept.push(item as HostToolRegistryEntry);
      } catch (error) {
        if (!(error instanceof HostExtensionInvalidError)) throw error;
        refused.push(error.field);
      }
    });
    if (refused.length > 0) console.warn("HOST_TOOL_REGISTRY_ENTRY_REFUSED", refused);
    return kept;
  };
}

/** "sessions" or one of the extension's own workspace pages without params. */
function checkLanding(value: unknown, paths: ReadonlySet<string>): void {
  if (value === undefined) return;
  const landing = text(value, "landing");
  if (landing === "sessions") return;
  if (landing.includes("$")) fail("landing", `"${landing}" has a param no redirect can fill`);
  if (!paths.has(landing)) fail("landing", `"${landing}" is not a registered route`);
}

function checkLifecycle(value: unknown): void {
  if (value === undefined) return;
  const lifecycle = record(value, "lifecycle");
  optionalFunction(lifecycle.onSignOut, "lifecycle.onSignOut");
  optionalFunction(lifecycle.onWorkspaceSwitch, "lifecycle.onWorkspaceSwitch");
}

/** Host context must always be visible and dismissible; check again after every resolution. */
export function validateHostMessageContext(value: unknown): void {
  if (value === undefined) return;
  const items = Array.isArray(value) ? value : [value];
  const ids = new Set<string>();
  items.forEach((candidate, index) => {
    const field = `messageContext[${index}]`;
    const item = record(candidate, field);
    knownKeys(item, field, ["id", "text", "label", "detail"]);
    const id = text(item.id, `${field}.id`);
    if (ids.has(id)) fail(`${field}.id`, "is duplicated");
    ids.add(id);
    text(item.text, `${field}.text`);
    text(item.label, `${field}.label`);
    optionalText(item.detail, `${field}.detail`);
  });
}

/** Host failures drop host items, preserve the person's send, and warn once per installation. */
export function createHostMessageContextResolver(
  source: NonNullable<HostExtension["messageContext"]>,
): NonNullable<HostExtension["messageContext"]> {
  let reported = false;
  return (context) => {
    try {
      const value = source(context);
      validateHostMessageContext(value);
      return value;
    } catch {
      if (!reported) {
        reported = true;
        console.warn("HOST_MESSAGE_CONTEXT_FAILED");
      }
      return undefined;
    }
  };
}

/** Validate each result when the host resolves starters. */
export function validateHostStarters(value: unknown): void {
  if (!Array.isArray(value)) fail("starters", "must return an array");
  if (value.length > 8) fail("starters", "must contain at most 8 items");
  const ids = new Set<string>();
  value.forEach((candidate, index) => {
    const field = `starters[${index}]`;
    const item = record(candidate, field);
    knownKeys(item, field, ["id", "label", "prompt"]);
    const id = text(item.id, `${field}.id`);
    if (ids.has(id)) fail(`${field}.id`, "is duplicated");
    ids.add(id);
    text(item.label, `${field}.label`);
    text(item.prompt, `${field}.prompt`);
  });
}

/** Invalid host results retain the native starters; an intentional empty list stays empty. */
export function createHostStartersResolver(
  source: NonNullable<HostExtension["starters"]>,
): (context: HostExtensionContext) => readonly HostExtensionStarter[] | undefined {
  let reported = false;
  return (context) => {
    try {
      const items = source(context);
      validateHostStarters(items);
      return items;
    } catch {
      if (!reported) {
        reported = true;
        console.warn("HOST_STARTERS_FAILED");
      }
      return undefined;
    }
  };
}

function checkCommandMenuProviders(value: unknown): void {
  const ids = new Set<string>();
  list(value, "commandMenuProviders").forEach((candidate, index) => {
    const field = `commandMenuProviders[${index}]`;
    const provider = record(candidate, field);
    knownKeys(provider, field, ["id", "heading", "search"]);
    const id = text(provider.id, `${field}.id`);
    if (ids.has(id)) fail(`${field}.id`, "is duplicated");
    ids.add(id);
    text(provider.heading, `${field}.heading`);
    if (typeof provider.search !== "function") fail(`${field}.search`, "must be a function");
  });
}
function checkUtilities(value: unknown): void {
  const utilities = list(value, "utilities");
  if (utilities.length > 3) fail("utilities", "must contain at most 3 entries");
  const ids = new Set<string>();
  utilities.forEach((candidate, index) => {
    const field = `utilities[${index}]`;
    const utility = record(candidate, field);
    knownKeys(utility, field, ["id", "label", "icon", "load"]);
    const id = text(utility.id, `${field}.id`);
    if (ids.has(id)) fail(`${field}.id`, "is duplicated");
    ids.add(id);
    text(utility.label, `${field}.label`);
    component(utility.icon, `${field}.icon`);
    if (typeof utility.load !== "function") fail(`${field}.load`, "must be a function");
  });
}

/**
 * Checks that a value is a usable host extension and returns it unchanged.
 * Throws HostExtensionInvalidError (`HOST_EXTENSION_INVALID`) naming the field.
 */
export function validateHostExtension(value: unknown): HostExtension {
  const fields = record(value, "extension");
  text(fields.id, "id");
  optionalText(fields.productName, "productName");
  checkBrand(fields.brand);
  optionalFunction(fields.messageContext, "messageContext");
  optionalFunction(fields.starters, "starters");
  checkSessionIndicator(fields.sessionIndicator);
  list(fields.hiddenNativeSections, "hiddenNativeSections").forEach((section, index) => {
    if (!isNativeSectionId(section)) fail(`hiddenNativeSections[${index}]`, "is not a native section");
  });
  checkCommandMenuProviders(fields.commandMenuProviders);
  checkUtilities(fields.utilities);
  const paths = routePaths(fields.routes);
  const hidden = list(fields.hiddenNativeDestinations, "hiddenNativeDestinations");
  const groups = settingsGroupIds(fields.settingsGroups);
  checkNav(fields.nav, paths, groups);
  checkNavOverrides(fields.navOverrides, hidden, groups);
  checkLanding(fields.landing, paths);
  checkOutsideWorkspaceRoutes(fields.outsideWorkspaceRoutes);
  list(fields.outsideWorkspaceProviders, "outsideWorkspaceProviders").forEach((provider, index) =>
    component(provider, `outsideWorkspaceProviders[${index}]`),
  );
  hidden.forEach((destination, index) => {
    if (!isNativeDestination(destination)) {
      fail(
        `hiddenNativeDestinations[${index}]`,
        `"${String(destination)}" is not a native destination`,
      );
    }
  });
  list(fields.shellProviders, "shellProviders").forEach((provider, index) =>
    component(provider, `shellProviders[${index}]`),
  );
  checkToolRegistryEntries(fields.toolRegistryEntries);
  optionalFunction(fields.toolRegistryLoader, "toolRegistryLoader");
  optionalFunction(fields.workspaceFilter, "workspaceFilter");
  checkLifecycle(fields.lifecycle);
  return value as HostExtension;
}

export type HostExtensionSlot = Readonly<{
  /** Validates and installs the extension; once, before anything reads it. */
  install: (value: unknown) => HostExtension;
  /** The installed extension; the stock one until something is installed. */
  current: () => HostExtension;
  /** The installed extension's settings-mode route paths: one array per installation. */
  settingsPaths: () => readonly string[];
}>;

const NONE: readonly never[] = Object.freeze([]);

/**
 * A slot that holds one host extension. Reading it before installation gives
 * the stock extension, which tests and stock pages rely on; installing after
 * such a read throws HOST_EXTENSION_READ_BEFORE_INSTALL, because that reader
 * would keep stock values while the rest of the console is extended.
 */
export function createHostExtensionSlot(): HostExtensionSlot {
  let installed: HostExtension | undefined;
  let settingsPaths: readonly string[] = NONE;
  let readBeforeInstall = false;
  return {
    install(value) {
      if (installed) {
        throw new Error("HOST_EXTENSION_INSTALLED: the host extension is installed once");
      }
      if (readBeforeInstall) {
        throw new Error(
          "HOST_EXTENSION_READ_BEFORE_INSTALL: read the host extension at call time, after startup",
        );
      }
      const extension = validateHostExtension(value);
      installed = extension;
      settingsPaths = (extension.routes ?? [])
        .filter((route) => route.mode === "settings")
        .map((route) => route.path);
      return extension;
    },
    current() {
      if (installed) return installed;
      readBeforeInstall = true;
      return EMPTY_HOST_EXTENSION;
    },
    settingsPaths() {
      if (!installed) readBeforeInstall = true;
      return settingsPaths;
    },
  };
}

const slot = createHostExtensionSlot();

/** Installs this build's extension; called by startup.ts only. */
export const installHostExtension: HostExtensionSlot["install"] = slot.install;

/** This build's host extension (the configured bundle, or the stock stub). Read it at call time. */
export const currentHostExtension: HostExtensionSlot["current"] = slot.current;

/**
 * Paths of this build's extension routes that open in the settings-mode shell.
 * The same array on every call, so it can be a memo input.
 */
export const extensionSettingsPaths: HostExtensionSlot["settingsPaths"] = slot.settingsPaths;

/** This build's extension pages outside any workspace (read at call time). */
export function outsideWorkspaceRoutes(): readonly HostExtensionOutsideWorkspaceRoute[] {
  return currentHostExtension().outsideWorkspaceRoutes ?? NONE;
}

/** The outside-workspace page at `pathname` (exact, trailing slash allowed), if any. */
export function outsideWorkspaceRouteAt(
  pathname: string,
): HostExtensionOutsideWorkspaceRoute | undefined {
  const path = pathname.replace(/^\/+|\/+$/g, "");
  return outsideWorkspaceRoutes().find((route) => route.path === path);
}

/** Native destinations this build's extension hides from every link source; none for the stub. */
export function hiddenNativeDestinations(): readonly NativeDestination[] {
  return currentHostExtension().hiddenNativeDestinations ?? NONE;
}

/** Native settings sections and capability parts hidden by this build. */
export function hiddenNativeSections(): readonly NativeSectionId[] {
  return currentHostExtension().hiddenNativeSections ?? NONE;
}
