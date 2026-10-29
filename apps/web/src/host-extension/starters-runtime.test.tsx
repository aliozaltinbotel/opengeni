import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppHost } from "@opengeni/react/app/lib/app-host";
import type { HostExtensionContext } from "@opengeni/react/app/host-extension";

let malformed: unknown;
void mock.module("@opengeni/web-host-extension", () => ({
  default: {
    id: "host",
    starters: (context: HostExtensionContext) => context.pathname === "/" ? [] : malformed,
  },
}));
GlobalRegistrator.register();
await import("@/app-host");
afterAll(() => { mock.restore(); GlobalRegistrator.unregister(); });

let resolved: unknown;
function Probe() {
  resolved = useAppHost().starters?.({ workspaceId: "w1", pathname: "/workspaces/w1/sessions" });
  return null;
}

test("malformed starter output after install is dropped and warns once", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const value of [undefined, null, "invalid"]) {
      malformed = value;
      expect(() => renderToStaticMarkup(<Probe />)).not.toThrow();
      expect(resolved).toBeUndefined();
    }
    expect(warning.mock.calls).toEqual([["HOST_STARTERS_FAILED"]]);
  } finally { warning.mockRestore(); }
});
