#!/usr/bin/env bun
/**
 * Fail closed when a migration on this head reuses an ordinal that a protected
 * base already assigned to a different migration, or when the local ledger
 * adds unpublished duplicate ordinals. Published groups that already coexist
 * on one protected base retain their immutable filename identities.
 * Prints the exact renumber command for new collisions only.
 *
 *   bun scripts/check-migration-ordinals.ts [--base <ref>] [--protected-base <full-commit>]...
 *
 * The primary base defaults to `origin/main` (fetched when missing) because a
 * collision is a property of what protected main holds *now*, not of the
 * pull-request event base. When `origin/production` exists it is also checked,
 * so a hotfix into production cannot take an ordinal that main already assigned
 * to a different file (and the reverse). A red result here is a real conflict
 * signal, so the candidate must be renumbered (a source revision), never merely
 * rerun.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MIGRATIONS_DIR,
  findProtectedOrdinalCollisions,
  listMigrationFiles,
  nextFreeOrdinal,
  parseLsTree,
  type MigrationName,
} from "./migration-ordinals";

async function git(root: string, ...command: string[]) {
  const child = Bun.spawn(["git", ...command], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function loadLedger(
  root: string,
  ref: string,
  required: boolean,
): Promise<{ ref: string; files: MigrationName[] } | null> {
  let tree = await git(root, "ls-tree", "--name-only", ref, "--", `${MIGRATIONS_DIR}/`);
  if (tree.code !== 0 && (ref === "origin/main" || ref === "origin/production")) {
    const branch = ref === "origin/main" ? "main" : "production";
    const fetched = await git(root, "fetch", "--no-tags", "--quiet", "origin", branch);
    if (fetched.code === 0) {
      tree = await git(root, "ls-tree", "--name-only", "FETCH_HEAD", "--", `${MIGRATIONS_DIR}/`);
    }
  }
  if (tree.code !== 0) {
    if (!required) return null;
    throw new Error(`cannot read ${MIGRATIONS_DIR} at ${ref}: ${tree.stderr.trim()}`);
  }
  return { ref, files: parseLsTree(tree.stdout) };
}

async function main(): Promise<void> {
  const root = process.cwd();
  if (!existsSync(join(root, MIGRATIONS_DIR))) {
    throw new Error(`run from the repository root (missing ${MIGRATIONS_DIR})`);
  }
  const baseIndex = process.argv.indexOf("--base");
  const primary =
    baseIndex >= 0
      ? process.argv[baseIndex + 1]
      : (process.env.OPENGENI_MIGRATION_BASE_REF ?? "origin/main");
  if (!primary) throw new Error("--base expects a git ref");

  const ledgers: Array<{ ref: string; files: MigrationName[]; protectedHistory?: true }> = [];
  const loadedPrimary = await loadLedger(root, primary, true);
  if (!loadedPrimary) throw new Error(`cannot read ${MIGRATIONS_DIR} at ${primary}`);
  ledgers.push(loadedPrimary);
  if (primary !== "origin/main") {
    const originMain = await loadLedger(root, "origin/main", false);
    if (originMain) ledgers.push(originMain);
  }
  if (primary !== "origin/production") {
    const production = await loadLedger(root, "origin/production", false);
    if (production) ledgers.push(production);
  }

  // A fork's reviewed source ledger is an explicit trust input, separate from
  // the comparison-only --base. Mutable refs and unrelated histories cannot
  // silently authorize exemptions for newly allocated duplicate ordinals.
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] !== "--protected-base") continue;
    const commit = process.argv[++index];
    if (!commit || !/^[a-f0-9]{40}$/.test(commit)) {
      throw new Error("--protected-base expects a full 40-character commit hash");
    }
    const object = await git(root, "cat-file", "-t", commit);
    if (object.code !== 0 || object.stdout.trim() !== "commit") {
      throw new Error(`--protected-base ${commit} must name a commit object`);
    }
    const ancestor = await git(root, "merge-base", "--is-ancestor", commit, primary);
    if (ancestor.code !== 0) {
      throw new Error(
        `--protected-base ${commit} must be an ancestor of comparison base ${primary}`,
      );
    }
    const ledger = await loadLedger(root, commit, true);
    if (!ledger) throw new Error(`cannot read ${MIGRATIONS_DIR} at ${commit}`);
    const changed = await git(
      root,
      "diff",
      "--name-only",
      "--diff-filter=MDT",
      "--no-renames",
      commit,
      "--",
      `:(glob)${MIGRATIONS_DIR}/*.sql`,
    );
    if (changed.code !== 0)
      throw new Error(`cannot compare protected migration bytes at ${commit}`);
    if (changed.stdout.trim()) {
      throw new Error(`Protected historical SQL differs from ${commit}:\n${changed.stdout.trim()}`);
    }
    ledgers.push({ ...ledger, protectedHistory: true });
  }

  const headLedger = listMigrationFiles(root);
  const { collisions, duplicates } = findProtectedOrdinalCollisions(headLedger, ledgers);
  if (collisions.length === 0 && duplicates.length === 0) {
    const highest = nextFreeOrdinal(headLedger, ...ledgers.map((ledger) => ledger.files));
    console.log(
      `[migration-ordinals] ok: ${headLedger.length} migrations, bases ${ledgers.map((ledger) => ledger.ref).join(",")} next ${highest}`,
    );
    return;
  }
  const next = nextFreeOrdinal(headLedger, ...ledgers.map((ledger) => ledger.files));
  for (const collision of collisions) {
    console.error(
      `[migration-ordinals] ordinal ${collision.ordinal} of ${collision.headFile} is already used on ${collision.ref} by ${collision.baseFile}`,
    );
    console.error(
      `  fix: bun scripts/renumber-migration.ts ${collision.headFile.replace(/\.sql$/, "")} --next   (next free ordinal: ${next})`,
    );
  }
  for (const files of duplicates) {
    console.error(
      `[migration-ordinals] duplicate ordinal in ${MIGRATIONS_DIR}: ${files.join(", ")}`,
    );
  }
  process.exit(1);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
