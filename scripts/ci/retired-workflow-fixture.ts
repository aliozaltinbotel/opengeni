import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Retained upstream contract input, not an installed workflow or evidence of hosted execution.
// Keep exact pre-removal bytes in Git history instead of recreating executable Actions definitions.
const source = "721110ceb604dcd5d8d928298cd1da1f8e961590";
export function readRetiredWorkflow(name: string): string {
  if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*\.ya?ml$/u.test(name)) throw new Error("RETIRED_WORKFLOW_NAME_INVALID");
  return execFileSync("git", ["--no-replace-objects", "show", `${source}:.github/workflows/${name}`], {
    cwd: resolve(import.meta.dir, "../.."),
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function retiredWorkflowNames(): string[] {
  return execFileSync("git", ["--no-replace-objects", "ls-tree", "--name-only", `${source}:.github/workflows`], {
    cwd: resolve(import.meta.dir, "../.."),
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split("\n").filter((name) => /\.ya?ml$/u.test(name));
}
