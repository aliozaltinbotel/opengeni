import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as db from "@opengeni/db";
import { canonicalModelSourceJson, type ModelSourceRef } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { buildPortableSkillArtifact } from "@opengeni/runtime/skill-library";
import { createWorkspaceSkillTools } from "../src/activities/agent-turn/skill-tools";
import { loadConfiguredBundledSkills } from "../src/activities/agent-turn/skill-selection";

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}

for (const source of ["builtin", "session"] as const) {
  test(`selected ${source} artifact read and search retain the same genuine source ref`, async () => {
    track(spyOn(db, "assertSkillReadAttempt").mockResolvedValue(undefined));
    track(spyOn(db, "listSkillDescriptors").mockResolvedValue([]));
    track(spyOn(db, "getActiveSessionFunctionToolResults").mockResolvedValue([]));
    const sessionId = crypto.randomUUID();
    const selected =
      source === "builtin"
        ? loadConfiguredBundledSkills({
            firstPartyTools: [],
            videoGenerationEnabled: false,
            bundledSkillIds: ["builtin:opengeni-help"],
          })[0]!
        : {
            id: `session:${sessionId}:selected-guidance`,
            artifact: buildPortableSkillArtifact([
              {
                path: "SKILL.md",
                content:
                  "---\nname: selected-guidance\ndescription: Session selected guidance\n---\nUse this session guidance.",
              },
            ]),
          };
    const expected: ModelSourceRef = {
      owner: "native.skill.artifact",
      id: selected.id,
      sha256: db.skillFilesContentHash(selected.artifact.files),
      version: createHash("sha256")
        .update(
          canonicalModelSourceJson({
            name: selected.artifact.name,
            description: selected.artifact.description,
          }),
          "utf8",
        )
        .digest("hex"),
    };
    const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });
    const definitions = createWorkspaceSkillTools({
      db: {} as db.Database,
      settings,
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      actor: {
        kind: "agent",
        sessionId,
        turnId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        executionGeneration: 1,
      },
      selected: [selected],
      filesystem: async () => {
        throw Error("must not start sandbox");
      },
      modelToolOutputTruncationTokens: () => settings.modelToolOutputTruncationTokens,
    });
    const context = {
      operationId: crypto.randomUUID(),
      caller: { kind: "model" as const, subjectId: "agent:selected-skill" },
    };
    for (const [modelName, args] of [
      ["skill_read", { skill: selected.id }],
      ["skill_search", { query: selected.artifact.name, scope: "installed" }],
    ] as const) {
      const definition = definitions.find((item) => item.modelName === modelName)!;
      const result = await definition.execute(args, context);
      expect(definition.modelSourceRefs?.(result)).toEqual([expected]);
    }
  });
}
