import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalModelSourceJson, type SkillFile } from "@opengeni/contracts";
import { skillArtifactSelectionSourceRef, skillFilesContentHash } from "../src/skills";

const artifact = {
  name: "selected-skill",
  description: "Selected guidance",
  files: [
    { path: "SKILL.md", content: "Selected instructions" },
    { path: "references/detail.md", content: "Additional context" },
  ] satisfies SkillFile[],
};

test("selected artifact source binds exact files and canonical descriptor without ledger identity", () => {
  const id = "builtin:selected-skill";
  const ref = skillArtifactSelectionSourceRef(id, artifact);
  expect(ref).toEqual({
    owner: "native.skill.artifact",
    id,
    sha256: skillFilesContentHash(artifact.files),
    version: createHash("sha256")
      .update(
        canonicalModelSourceJson({ name: artifact.name, description: artifact.description }),
        "utf8",
      )
      .digest("hex"),
  });
  expect(
    skillArtifactSelectionSourceRef(id, { ...artifact, files: [...artifact.files].reverse() }),
  ).toEqual(ref);
  const changedFile = skillArtifactSelectionSourceRef(id, {
    ...artifact,
    files: [...artifact.files, { path: "references/new.md", content: "New context" }],
  });
  expect(changedFile.sha256).not.toBe(ref.sha256);
  expect(changedFile.version).toBe(ref.version);
  for (const descriptor of [{ name: "renamed" }, { description: "Changed guidance" }]) {
    const changed = skillArtifactSelectionSourceRef(id, { ...artifact, ...descriptor });
    expect(changed.version).not.toBe(ref.version);
    expect(changed.sha256).toBe(ref.sha256);
  }
});

test("absent or empty artifact description hashes the same model-visible name fallback", () => {
  const id = "builtin:selected-skill";
  for (const description of ["", null, undefined]) {
    expect(skillArtifactSelectionSourceRef(id, { ...artifact, description })).toEqual(
      skillArtifactSelectionSourceRef(id, { ...artifact, description: artifact.name }),
    );
  }
});
