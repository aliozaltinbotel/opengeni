// The console's host extension, resolved at build time for the fixed
// `@opengeni/web-host-extension` specifier (vite-host-extension.ts) and checked
// once here. The bundle comes from outside this build, so its shape is checked
// at runtime: a malformed or colliding route is refused with the field it
// names, never left to shadow a native page.
import extension from "@opengeni/web-host-extension";
import {
  isNativeDestination,
  NATIVE_DESTINATIONS,
  type HostExtension,
} from "@opengeni/react/app/host-extension";

/** Lowercase segments with optional `$param` segments, relative to the workspace. */
const ROUTE_PATH = /^[a-z][a-z0-9-]*(\/(\$?[a-zA-Z][a-zA-Z0-9]*|[a-z0-9-]+))*$/;

/**
 * First path segments the native console owns under workspaces/$workspaceId/,
 * including redirect-only ones. Kept static (App.tsx's routes are built after
 * this module runs); registry.test.ts fails when App.tsx adds one not listed.
 */
const NATIVE_SEGMENTS: ReadonlySet<string> = new Set([
  ...NATIVE_DESTINATIONS,
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

function list(value: unknown, field: string): readonly unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : fail(field, "must be an array");
}

function checkRoutePath(path: string, field: string): void {
  if (!ROUTE_PATH.test(path)) fail(field, `"${path}" is not a lowercase relative route path`);
  const segments = path.split("/");
  const first = segments[0] ?? "";
  if (NATIVE_SEGMENTS.has(first))
    fail(field, `"${path}" collides with the native "${first}" route`);
  const params = new Set<string>();
  for (const param of segments.filter((segment) => segment.startsWith("$"))) {
    if (param === WORKSPACE_PARAM) fail(field, `"${path}" redeclares the workspace's ${param}`);
    if (params.has(param)) fail(field, `"${path}" declares ${param} twice`);
    params.add(param);
  }
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

function checkToolRegistryEntry(value: unknown, field: string): void {
  const entry = record(value, field);
  if (entry.match === "name") text(entry.name, `${field}.name`);
  else if (entry.match === "rawType") text(entry.type, `${field}.type`);
  else fail(`${field}.match`, 'must be "rawType" or "name"');
  component(entry.render, `${field}.render`);
}

function checkLifecycle(value: unknown): void {
  if (value === undefined) return;
  const lifecycle = record(value, "lifecycle");
  optionalFunction(lifecycle.onSignOut, "lifecycle.onSignOut");
  optionalFunction(lifecycle.onWorkspaceSwitch, "lifecycle.onWorkspaceSwitch");
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
  checkNav(fields.nav, routePaths(fields.routes), settingsGroupIds(fields.settingsGroups));
  list(fields.hiddenNativeDestinations, "hiddenNativeDestinations").forEach(
    (destination, index) => {
      if (!isNativeDestination(destination)) {
        fail(
          `hiddenNativeDestinations[${index}]`,
          `"${String(destination)}" is not a native destination`,
        );
      }
    },
  );
  list(fields.shellProviders, "shellProviders").forEach((provider, index) =>
    component(provider, `shellProviders[${index}]`),
  );
  list(fields.toolRegistryEntries, "toolRegistryEntries").forEach((entry, index) =>
    checkToolRegistryEntry(entry, `toolRegistryEntries[${index}]`),
  );
  optionalFunction(fields.workspaceFilter, "workspaceFilter");
  checkLifecycle(fields.lifecycle);
  return value as HostExtension;
}

/** This build's host extension: the configured bundle, or the stock stub. */
export const hostExtension: HostExtension = validateHostExtension(extension);
