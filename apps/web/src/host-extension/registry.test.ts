import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  EMPTY_HOST_EXTENSION,
  type HostExtension,
  type HostExtensionNavItem,
  type HostExtensionRoute,
} from "@opengeni/react/app/host-extension";

import { hostExtension, validateHostExtension } from "./registry";

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

  test("resolves the stock stub when no extension is configured", () => {
    expect(hostExtension).toEqual({ id: "none" });
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
});
