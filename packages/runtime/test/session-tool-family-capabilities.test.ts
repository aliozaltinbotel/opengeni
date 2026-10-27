import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { buildAgentCapabilities, buildOpenGeniAgent } from "../src/index";

/*
 * A host session policy that denies the shell family removes the sandbox shell
 * and file-editing capabilities from the agent; one that denies Codemode never
 * receives a Codemode bearer. Without a policy the capability set is unchanged.
 */
describe("sandbox capabilities under a host session policy", () => {
  test("without a restriction the shell and filesystem capabilities are present", () => {
    const types = buildAgentCapabilities(testSettings()).map((capability) => capability.type);
    expect(types).toContain("shell");
    expect(types).toContain("filesystem");
  });

  test("a denied shell family removes the shell and filesystem capabilities", () => {
    const types = buildAgentCapabilities(testSettings(), [], {
      deniedSessionToolFamilies: ["shell"],
    }).map((capability) => capability.type);
    expect(types).not.toContain("shell");
    expect(types).not.toContain("filesystem");
  });

  test("other denied families leave the sandbox capabilities alone", () => {
    const types = buildAgentCapabilities(testSettings(), [], {
      deniedSessionToolFamilies: ["browser", "computerUse"],
    }).map((capability) => capability.type);
    expect(types).toContain("shell");
  });

  test("a Codemode bearer is refused when the policy denies Codemode", () => {
    expect(() =>
      buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
        codemodeTokenSeed: "codemode-bearer",
        codemodeTokenSessionId: crypto.randomUUID(),
        deniedSessionToolFamilies: ["codemode"],
      }),
    ).toThrow("Codemode");
  });
});
