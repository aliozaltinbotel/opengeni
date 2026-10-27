import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  ACTIVE_WORK_ACTION_ICON_RAW_BUDGET,
  ACTIVE_WORK_ACTION_ICON_RAW_MEASUREMENT,
  CODEX_CAPACITY_LIVE_STATUS_RAW_BUDGET,
  CODEX_CAPACITY_LIVE_STATUS_RAW_MEASUREMENT,
  DIRECT_SESSION_RAW_BUDGET,
  DIRECT_SESSION_RAW_MEASUREMENT,
  EFFECTIVE_DIRECT_SESSION_RAW_BUDGET,
  HTTP1_BROWSER_STREAMS_RAW_BUDGET,
  HTTP1_BROWSER_STREAMS_RAW_MEASUREMENT,
  KIB,
  MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET,
  MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_MEASUREMENT,
  MODEL_CATALOG_GATEWAY_OPENROUTER_RAW_BUDGET,
  MODEL_CATALOG_GATEWAY_OPENROUTER_RAW_MEASUREMENT,
  MINIMUM_RAW_HEADROOM_BYTES,
  ORGANIZATION_CODEX_INHERITANCE_RAW_BUDGET,
  ORGANIZATION_CODEX_INHERITANCE_RAW_MEASUREMENT,
  ORGANIZATION_INVITATION_CONTINUATION_RAW_BUDGET,
  ORGANIZATION_INVITATION_CONTINUATION_RAW_MEASUREMENT,
  SCHEDULED_CONNECTED_MACHINE_RAW_BUDGET,
  SCHEDULED_CONNECTED_MACHINE_RAW_MEASUREMENT,
  SIDEBAR_DENSITY_CURRENT_MAIN_BROWSER_RAW_BUDGET,
  SIDEBAR_DENSITY_CURRENT_MAIN_BROWSER_RAW_MEASUREMENT,
  SETUP_ACCOUNT_QUERY_COMPATIBILITY_RAW_BUDGET,
  SETUP_ACCOUNT_QUERY_COMPATIBILITY_RAW_MEASUREMENT,
  ORGANIZATION_API_KEYS_CURRENT_MAIN_RAW_BUDGET,
  ORGANIZATION_API_KEYS_CURRENT_MAIN_RAW_MEASUREMENT,
  PR_REVIEW_EXECUTION_MODEL_RAW_BUDGET,
  PR_REVIEW_EXECUTION_MODEL_RAW_MEASUREMENT,
  PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_FILE_COUNT,
  PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_GZIP_BUDGET,
  PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_GZIP_MEASUREMENT,
  PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_RAW_BUDGET,
  PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_RAW_MEASUREMENT,
  SESSION_READ_CANCELLATION_RAW_BUDGET,
  SESSION_READ_CANCELLATION_RAW_MEASUREMENT,
  SESSION_WAIT_COMMAND_WAKE_RAW_BUDGET,
  SESSION_WAIT_COMMAND_WAKE_RAW_MEASUREMENT,
  TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET,
  TIMELINE_HARDENING_CURRENT_MAIN_RAW_MEASUREMENT,
  TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET,
  TIMELINE_HARDENING_MERGE_TREE_RAW_MEASUREMENT,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
  VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT,
  WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET,
  WORK_DISCOVERY_MERGE_TREE_RAW_MEASUREMENT,
  WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET,
  WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_MEASUREMENT,
  WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET,
  WORKSPACE_MEMBER_ADMINISTRATION_RAW_MEASUREMENT,
  wholeKibEnvelope,
} from "./web-bundle-budget-policy";

describe("web bundle budget policy", () => {
  test("pins the measured agent-configuration and current-main merge aggregates", () => {
    const source = readFileSync(new URL("./check-web-bundle-budget.ts", import.meta.url), "utf8");
    expect(source).toContain("wholeKibEnvelope(2_572_187, 1.5 * kib)");
    expect(source).toContain("wholeKibEnvelope(726_074, 1.5 * kib)");
    expect(source).toContain("Grouping the new config/allowance modules into startup-sdk-runtime");
    expect(wholeKibEnvelope(2_572_187, 1.5 * KIB)).toBe(2514 * KIB);
    expect(wholeKibEnvelope(726_074, 1.5 * KIB)).toBe(711 * KIB);
    expect(2514 * KIB - 2_572_187).toBeGreaterThanOrEqual(1.5 * KIB);
    expect(711 * KIB - 726_074).toBeGreaterThanOrEqual(1.5 * KIB);
    for (const limit of [
      "initialRaw: 1485 * kib",
      "initialGzip: 405 * kib",
      "initialFileGzip: wholeKibEnvelope(82_325)",
      "initialFiles: 20",
      "lazyChunkRaw: 800 * kib",
      "lazyChunkGzip: 240 * kib",
      "cssGzip: wholeKibEnvelope(48_180)",
    ])
      expect(source).toContain(limit);
    expect(source).toContain("39,");
  });

  test("calibrates only the measured session artifact navigation gzip envelope", () => {
    const source = readFileSync(new URL("./check-web-bundle-budget.ts", import.meta.url), "utf8");
    expect(source).toContain("wholeKibEnvelope(656_741, 1.5 * kib)");
    const envelope = wholeKibEnvelope(656_741, 1.5 * KIB);
    expect(envelope).toBe(643 * KIB);
    expect(envelope - 656_774).toBeGreaterThanOrEqual(1.5 * KIB);
    // Shared hard limits are pinned once above; retain the unique direct-session caps here.
    for (const limit of [
      "directSessionRaw: Math.max(EFFECTIVE_DIRECT_SESSION_RAW_BUDGET, wholeKibEnvelope(2_329_400))",
      "directSessionFiles: 31",
    ])
      expect(source).toContain(limit);
  });

  test("bounds the eager route error boundary and client error beacon in the entry chunk", () => {
    const source = readFileSync(new URL("./check-web-bundle-budget.ts", import.meta.url), "utf8");
    expect(source).toContain("initialFileGzip: wholeKibEnvelope(82_325)");
    expect(source).toContain("wholeKibEnvelope(2_455_346, 1.5 * kib)");
    expect(wholeKibEnvelope(82_325)).toBe(82 * KIB);
    expect(wholeKibEnvelope(82_325) - 82_325).toBeGreaterThanOrEqual(KIB);
    expect(wholeKibEnvelope(2_455_346, 1.5 * KIB) - 2_455_346).toBeGreaterThanOrEqual(1.5 * KIB);
  });

  test("pins the direct-session growth measured after removing misplaced lazy code", () => {
    const source = readFileSync(new URL("./check-web-bundle-budget.ts", import.meta.url), "utf8");
    expect(source).toContain("wholeKibEnvelope(2_933_830, 1.5 * kib)");
    expect(source).toContain("wholeKibEnvelope(838_954, 1.5 * kib)");
    expect(source).toContain("apps/web/vite-eager-graph.ts");
    expect(source).toContain("    52,\n  ),");
    for (const [measured, limit] of [
      [2_933_830, wholeKibEnvelope(2_933_830, 1.5 * KIB)],
      [838_954, wholeKibEnvelope(838_954, 1.5 * KIB)],
      [48_180, wholeKibEnvelope(48_180)],
    ] as const) {
      expect(limit % KIB).toBe(0);
      expect(limit - measured).toBeGreaterThanOrEqual(measured === 48_180 ? KIB : 1.5 * KIB);
    }
  });

  test("retains at least one KiB above the combined personal GitHub and current-main graph", () => {
    expect(DIRECT_SESSION_RAW_MEASUREMENT).toBe(2_219_469);
    expect(DIRECT_SESSION_RAW_BUDGET).toBe(2169 * KIB);
    expect(DIRECT_SESSION_RAW_BUDGET - DIRECT_SESSION_RAW_MEASUREMENT).toBe(1_587);
    expect(DIRECT_SESSION_RAW_BUDGET - DIRECT_SESSION_RAW_MEASUREMENT).toBeGreaterThanOrEqual(
      MINIMUM_RAW_HEADROOM_BYTES,
    );
  });

  test("retains the reviewed timeline-hardening merge-tree envelope", () => {
    expect(TIMELINE_HARDENING_MERGE_TREE_RAW_MEASUREMENT).toBe(2_201_700);
    expect(TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET).toBe(2152 * KIB);
    expect(
      TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET - TIMELINE_HARDENING_MERGE_TREE_RAW_MEASUREMENT,
    ).toBe(1_948);
  });

  test("retains the exact timeline-hardening current-main envelope", () => {
    expect(TIMELINE_HARDENING_CURRENT_MAIN_RAW_MEASUREMENT).toBe(2_222_765);
    expect(TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET).toBe(2172 * KIB);
    expect(
      TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET - TIMELINE_HARDENING_CURRENT_MAIN_RAW_MEASUREMENT,
    ).toBe(1_363);
  });

  test("rounds the measured graph plus required headroom to a whole KiB", () => {
    expect(wholeKibEnvelope(2137 * KIB)).toBe(2138 * KIB);
    expect(wholeKibEnvelope(2137 * KIB + 1)).toBe(2139 * KIB);
    expect(wholeKibEnvelope(0, 1)).toBe(KIB);
  });

  test("rejects invalid measurements and headroom instead of weakening the guard", () => {
    expect(() => wholeKibEnvelope(-1)).toThrow("non-negative safe integer");
    expect(() => wholeKibEnvelope(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "non-negative safe integer",
    );
    expect(() => wholeKibEnvelope(1, 0)).toThrow("positive safe integer");
  });

  test("retains the exact version-frozen release-source envelope", () => {
    expect(VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT).toBe(2_205_043);
    expect(VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET).toBe(2155 * KIB);
    expect(
      VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET -
        VARIABLE_SET_SELECTION_MERGE_TREE_RAW_MEASUREMENT,
    ).toBe(1_677);
  });

  test("retains the exact current-main permission-scoped discovery envelope", () => {
    expect(WORK_DISCOVERY_MERGE_TREE_RAW_MEASUREMENT).toBe(2_206_112);
    expect(WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET).toBe(2156 * KIB);
    expect(WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET - WORK_DISCOVERY_MERGE_TREE_RAW_MEASUREMENT).toBe(
      1_632,
    );
  });

  test("retains the exact workspace-member administration envelope", () => {
    expect(WORKSPACE_MEMBER_ADMINISTRATION_RAW_MEASUREMENT).toBe(2_210_226);
    expect(WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET).toBe(2160 * KIB);
    expect(
      WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET - WORKSPACE_MEMBER_ADMINISTRATION_RAW_MEASUREMENT,
    ).toBe(1_614);
    expect(EFFECTIVE_DIRECT_SESSION_RAW_BUDGET).toBe(
      Math.max(
        DIRECT_SESSION_RAW_BUDGET,
        TIMELINE_HARDENING_MERGE_TREE_RAW_BUDGET,
        TIMELINE_HARDENING_CURRENT_MAIN_RAW_BUDGET,
        VARIABLE_SET_SELECTION_MERGE_TREE_RAW_BUDGET,
        WORK_DISCOVERY_MERGE_TREE_RAW_BUDGET,
        WORKSPACE_MEMBER_ADMINISTRATION_RAW_BUDGET,
        WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET,
        MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET,
        HTTP1_BROWSER_STREAMS_RAW_BUDGET,
        SESSION_READ_CANCELLATION_RAW_BUDGET,
        SCHEDULED_CONNECTED_MACHINE_RAW_BUDGET,
        ORGANIZATION_API_KEYS_CURRENT_MAIN_RAW_BUDGET,
        PR_REVIEW_EXECUTION_MODEL_RAW_BUDGET,
        PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_RAW_BUDGET,
        ORGANIZATION_CODEX_INHERITANCE_RAW_BUDGET,
        MODEL_CATALOG_GATEWAY_OPENROUTER_RAW_BUDGET,
        ORGANIZATION_INVITATION_CONTINUATION_RAW_BUDGET,
        CODEX_CAPACITY_LIVE_STATUS_RAW_BUDGET,
        SIDEBAR_DENSITY_CURRENT_MAIN_BROWSER_RAW_BUDGET,
        SETUP_ACCOUNT_QUERY_COMPATIBILITY_RAW_BUDGET,
        SESSION_WAIT_COMMAND_WAKE_RAW_BUDGET,
        ACTIVE_WORK_ACTION_ICON_RAW_BUDGET,
      ),
    );
  });

  test("retains one KiB headroom above the shared active-work action icon graph", () => {
    expect(ACTIVE_WORK_ACTION_ICON_RAW_MEASUREMENT).toBe(2_284_597);
    expect(ACTIVE_WORK_ACTION_ICON_RAW_BUDGET).toBe(2233 * KIB);
    expect(ACTIVE_WORK_ACTION_ICON_RAW_BUDGET - ACTIVE_WORK_ACTION_ICON_RAW_MEASUREMENT).toBe(
      1_995,
    );
  });

  test("retains the exact workspace-member administration current-main envelope", () => {
    expect(WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_MEASUREMENT).toBe(2_224_726);
    expect(WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET).toBe(2174 * KIB);
    expect(
      WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_BUDGET -
        WORKSPACE_MEMBER_ADMINISTRATION_CURRENT_MAIN_RAW_MEASUREMENT,
    ).toBe(1_450);
  });

  test("retains the exact managed social sign-in merge-tree envelope", () => {
    expect(MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_MEASUREMENT).toBe(2_226_468);
    expect(MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET).toBe(2176 * KIB);
    expect(
      MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_BUDGET -
        MANAGED_SOCIAL_SIGN_IN_MERGE_TREE_RAW_MEASUREMENT,
    ).toBe(1_756);
  });

  test("retains the exact browser-owned HTTP/1 stream-lifetime envelope", () => {
    expect(HTTP1_BROWSER_STREAMS_RAW_MEASUREMENT).toBe(2_237_456);
    expect(HTTP1_BROWSER_STREAMS_RAW_BUDGET).toBe(2187 * KIB);
    expect(HTTP1_BROWSER_STREAMS_RAW_BUDGET - HTTP1_BROWSER_STREAMS_RAW_MEASUREMENT).toBe(2_032);
  });

  test("retains the exact abandoned session-read cancellation envelope", () => {
    expect(SESSION_READ_CANCELLATION_RAW_MEASUREMENT).toBe(2_239_997);
    expect(SESSION_READ_CANCELLATION_RAW_BUDGET).toBe(2189 * KIB);
    expect(SESSION_READ_CANCELLATION_RAW_BUDGET - SESSION_READ_CANCELLATION_RAW_MEASUREMENT).toBe(
      1_539,
    );
  });

  test("retains the exact scheduled Connected Machine routing envelope", () => {
    expect(SCHEDULED_CONNECTED_MACHINE_RAW_MEASUREMENT).toBe(2_242_670);
    expect(SCHEDULED_CONNECTED_MACHINE_RAW_BUDGET).toBe(2192 * KIB);
    expect(
      SCHEDULED_CONNECTED_MACHINE_RAW_BUDGET - SCHEDULED_CONNECTED_MACHINE_RAW_MEASUREMENT,
    ).toBe(1_938);
  });

  test("retains the exact organization API-key current-main envelope", () => {
    expect(ORGANIZATION_API_KEYS_CURRENT_MAIN_RAW_MEASUREMENT).toBe(2_264_303);
    expect(ORGANIZATION_API_KEYS_CURRENT_MAIN_RAW_BUDGET).toBe(2213 * KIB);
    expect(
      ORGANIZATION_API_KEYS_CURRENT_MAIN_RAW_BUDGET -
        ORGANIZATION_API_KEYS_CURRENT_MAIN_RAW_MEASUREMENT,
    ).toBe(1_809);
  });

  test("retains the exact PR-review execution-model envelope", () => {
    expect(PR_REVIEW_EXECUTION_MODEL_RAW_MEASUREMENT).toBe(2_267_606);
    expect(PR_REVIEW_EXECUTION_MODEL_RAW_BUDGET).toBe(2216 * KIB);
    expect(PR_REVIEW_EXECUTION_MODEL_RAW_BUDGET - PR_REVIEW_EXECUTION_MODEL_RAW_MEASUREMENT).toBe(
      1_578,
    );
  });

  test("retains the configured-API PR-review browser envelope", () => {
    expect(PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_RAW_MEASUREMENT).toBe(2_269_339);
    expect(PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_RAW_BUDGET).toBe(2218 * KIB);
    expect(
      PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_RAW_BUDGET -
        PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_RAW_MEASUREMENT,
    ).toBe(1_893);
    expect(PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_GZIP_MEASUREMENT).toBe(637_787);
    expect(PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_GZIP_BUDGET).toBe(624 * KIB);
    expect(
      PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_GZIP_BUDGET -
        PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_GZIP_MEASUREMENT,
    ).toBe(1_189);
    expect(PR_REVIEW_EXECUTION_CURRENT_MAIN_BROWSER_FILE_COUNT).toBe(33);
  });

  test("retains the organization Codex inheritance envelope", () => {
    expect(ORGANIZATION_CODEX_INHERITANCE_RAW_MEASUREMENT).toBe(2_271_792);
    expect(ORGANIZATION_CODEX_INHERITANCE_RAW_BUDGET).toBe(2220 * KIB);
    expect(
      ORGANIZATION_CODEX_INHERITANCE_RAW_BUDGET - ORGANIZATION_CODEX_INHERITANCE_RAW_MEASUREMENT,
    ).toBe(1_488);
  });

  test("retains the exact model-catalog, Gateway, and OpenRouter envelope", () => {
    expect(MODEL_CATALOG_GATEWAY_OPENROUTER_RAW_MEASUREMENT).toBe(2_274_951);
    expect(MODEL_CATALOG_GATEWAY_OPENROUTER_RAW_BUDGET).toBe(2223 * KIB);
    expect(
      MODEL_CATALOG_GATEWAY_OPENROUTER_RAW_BUDGET -
        MODEL_CATALOG_GATEWAY_OPENROUTER_RAW_MEASUREMENT,
    ).toBe(1_401);
  });

  test("retains the exact organization-invitation continuation envelope", () => {
    expect(ORGANIZATION_INVITATION_CONTINUATION_RAW_MEASUREMENT).toBe(2_277_646);
    expect(ORGANIZATION_INVITATION_CONTINUATION_RAW_BUDGET).toBe(2226 * KIB);
    expect(
      ORGANIZATION_INVITATION_CONTINUATION_RAW_BUDGET -
        ORGANIZATION_INVITATION_CONTINUATION_RAW_MEASUREMENT,
    ).toBe(1_778);
  });

  test("retains the exact authoritative Codex capacity-status envelope", () => {
    expect(CODEX_CAPACITY_LIVE_STATUS_RAW_MEASUREMENT).toBe(2_279_737);
    expect(CODEX_CAPACITY_LIVE_STATUS_RAW_BUDGET).toBe(2228 * KIB);
    expect(CODEX_CAPACITY_LIVE_STATUS_RAW_BUDGET - CODEX_CAPACITY_LIVE_STATUS_RAW_MEASUREMENT).toBe(
      1_735,
    );
  });

  test("retains the exact sidebar-density and current-main configured-browser envelope", () => {
    expect(SIDEBAR_DENSITY_CURRENT_MAIN_BROWSER_RAW_MEASUREMENT).toBe(2_279_505);
    expect(SIDEBAR_DENSITY_CURRENT_MAIN_BROWSER_RAW_BUDGET).toBe(2228 * KIB);
    expect(
      SIDEBAR_DENSITY_CURRENT_MAIN_BROWSER_RAW_BUDGET -
        SIDEBAR_DENSITY_CURRENT_MAIN_BROWSER_RAW_MEASUREMENT,
    ).toBe(1_967);
  });

  test("retains the exact setup-account query compatibility envelope", () => {
    expect(SETUP_ACCOUNT_QUERY_COMPATIBILITY_RAW_MEASUREMENT).toBe(2_281_164);
    expect(SETUP_ACCOUNT_QUERY_COMPATIBILITY_RAW_BUDGET).toBe(2229 * KIB);
    expect(
      SETUP_ACCOUNT_QUERY_COMPATIBILITY_RAW_BUDGET -
        SETUP_ACCOUNT_QUERY_COMPATIBILITY_RAW_MEASUREMENT,
    ).toBe(1_332);
  });

  test("retains the exact session-wait and command-wake lifecycle envelope", () => {
    expect(SESSION_WAIT_COMMAND_WAKE_RAW_MEASUREMENT).toBe(2_281_673);
    expect(SESSION_WAIT_COMMAND_WAKE_RAW_BUDGET).toBe(2230 * KIB);
    expect(SESSION_WAIT_COMMAND_WAKE_RAW_BUDGET - SESSION_WAIT_COMMAND_WAKE_RAW_MEASUREMENT).toBe(
      1_847,
    );
    expect(
      SESSION_WAIT_COMMAND_WAKE_RAW_BUDGET - SESSION_WAIT_COMMAND_WAKE_RAW_MEASUREMENT,
    ).toBeGreaterThanOrEqual(MINIMUM_RAW_HEADROOM_BYTES);
  });

  test("bounds the runtime-robustness session graph growth", () => {
    const source = readFileSync(new URL("./check-web-bundle-budget.ts", import.meta.url), "utf8");
    expect(source).toContain("wholeKibEnvelope(711_698, 1.5 * kib)");
    expect(source).toContain("wholeKibEnvelope(2_533_812, 1.5 * kib)");
  });

  test("bounds the usage-allowance session graph growth", () => {
    const source = readFileSync(new URL("./check-web-bundle-budget.ts", import.meta.url), "utf8");
    expect(source).toContain("wholeKibEnvelope(2_531_746, 1.5 * kib)");
    expect(source).toContain("wholeKibEnvelope(713_634, 1.5 * kib)");
    expect(wholeKibEnvelope(713_634, 1.5 * KIB) - 713_634).toBeGreaterThanOrEqual(1.5 * KIB);
  });

  test("bounds the organization Models page session graph growth", () => {
    const source = readFileSync(new URL("./check-web-bundle-budget.ts", import.meta.url), "utf8");
    expect(source).toContain("wholeKibEnvelope(2_533_407, 1.5 * kib)");
    expect(wholeKibEnvelope(2_533_407, 1.5 * KIB) - 2_533_407).toBeGreaterThanOrEqual(1.5 * KIB);
  });

  test("keeps usage allowance pages lazy without a session-graph envelope", () => {
    const source = readFileSync(new URL("./check-web-bundle-budget.ts", import.meta.url), "utf8");
    // The usage UI fits the existing caps: the session graph carries only the
    // refusal row and the small eager usage entry. Keep it that way.
    expect(source).not.toContain("Usage allowance UI:");
    const vite = readFileSync(new URL("../apps/web/vite.config.ts", import.meta.url), "utf8");
    expect(vite).toContain('name: "usage-allowances"');
    // The eager account-menu/composer usage entry must not join the budget pages.
    expect(vite).toContain("(?!usage-entry\\.)");
    expect(vite).not.toContain('name: "usage-surfaces"');
    expect(vite).toContain("react-slider");
    // Settings-only rows stay out of the paused banner/provider chunk that
    // direct workspace and session loads import.
    expect(vite).toContain('name: "workspace-chrome"');
    expect(vite).toContain("default-sandbox-environment-row");
    // Module-scope composer panel callers must not sit in a chunk cycle.
    expect(vite).toContain('name: "composer-menu-primitives"');
  });

  test("bounds the usage allowances UI session graph growth", () => {
    const source = readFileSync(new URL("./check-web-bundle-budget.ts", import.meta.url), "utf8");
    expect(source).toContain("wholeKibEnvelope(2_536_098, 1.5 * kib)");
  });
});

const repoRoot = path.resolve(import.meta.dir, "..");
const webRoot = path.join(repoRoot, "apps/web");
const webDist = path.join(webRoot, "dist");
const extensionFixture = path.join(repoRoot, "apps/web/test/fixtures/host-extension-dist");
// Two full production web builds (stub, then fixture): they run only when
// asked for. The fixture's shape is checked on every run.
const fixtureBuildRequested = process.env.OPENGENI_WEB_BUNDLE_FIXTURE_BUILD === "1";

type BudgetReport = Readonly<{ initial: Readonly<{ gzip: number; files: number }> }>;
type ManifestChunk = Readonly<{ imports?: string[]; isEntry?: boolean }>;
type BuildMeasure = Readonly<{
  report: BudgetReport;
  manifest: Record<string, ManifestChunk>;
  css: string;
}>;
// Tailwind also scans every file under apps/web that git does not ignore, so a
// class in the committed fixture would reach the stock CSS too. The fixture
// build therefore stages a copy in an ignored directory under apps/web (where
// the fixture's bare imports still resolve), as a host's own ignored dist is,
// and gives the copy's page a utility class no console source uses. This file
// is outside apps/web, so its literal is not a Tailwind source.
const stagedFixture = path.join(webRoot, "tmp/host-extension-fixture");
const PAGE_CLASS_MARKER = "const pageClassName = undefined;";
const EXTENSION_ONLY_CLASS = "tracking-[0.4242em]";
// Tailwind minifies the generated value to `.4242em`.
const EXTENSION_ONLY_CSS = "letter-spacing:.4242em";

/** Copies the fixture to its ignored staging directory, its page using EXTENSION_ONLY_CLASS. */
function stageFixture(): string {
  if (existsSync(stagedFixture)) {
    throw new Error(`${stagedFixture} already exists; remove it before the fixture budget build`);
  }
  cpSync(extensionFixture, stagedFixture, { recursive: true });
  const page = path.join(stagedFixture, "chunks/today-page.js");
  const source = readFileSync(page, "utf8");
  if (!source.includes(PAGE_CLASS_MARKER)) throw new Error(`${page} has no page class marker`);
  writeFileSync(
    page,
    source.replace(PAGE_CLASS_MARKER, `const pageClassName = "${EXTENSION_ONLY_CLASS}";`),
  );
  return stagedFixture;
}

/** Removes the staged copy, and its parent when the copy was all it held. */
function removeStagedFixture(): void {
  rmSync(stagedFixture, { recursive: true, force: true });
  const parent = path.dirname(stagedFixture);
  if (existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
}

function bun(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    // Nested `bun run` calls in the build script use this same Bun.
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      ...env,
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Builds apps/web, then reads the budget report (printed even when a budget
 * fails). The budget script reads apps/web/dist only, so this refuses to run
 * over a dist it did not build rather than delete someone's output.
 */
function buildAndMeasure(hostExtension: string): BuildMeasure {
  if (existsSync(webDist)) {
    throw new Error(`${webDist} already exists; remove it before the fixture budget build`);
  }
  try {
    // `bun test` sets NODE_ENV=test, which Vite would keep for the build.
    const build = bun(["run", "--cwd", "apps/web", "build"], {
      NODE_ENV: "production",
      OPENGENI_WEB_HOST_EXTENSION: hostExtension,
    });
    if (build.status !== 0) {
      throw new Error(`apps/web build failed:\n${build.stdout}\n${build.stderr}`);
    }
    const check = bun(["run", "check:web-bundle-budget"]);
    const assets = path.join(webDist, "assets");
    return {
      css: readdirSync(assets)
        .filter((file) => file.endsWith(".css"))
        .map((file) => readFileSync(path.join(assets, file), "utf8"))
        .join("\n"),
      report: JSON.parse(check.stdout) as BudgetReport,
      manifest: JSON.parse(
        readFileSync(path.join(webDist, ".vite/manifest.json"), "utf8"),
      ) as Record<string, ManifestChunk>,
    };
  } finally {
    rmSync(webDist, { recursive: true, force: true });
  }
}

function staticImportGraph(manifest: Record<string, ManifestChunk>): Set<string> {
  const graph = new Set<string>();
  const pending = Object.keys(manifest).filter((key) => manifest[key]?.isEntry);
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (graph.has(key)) continue;
    graph.add(key);
    pending.push(...(manifest[key]?.imports ?? []));
  }
  return graph;
}

describe("web bundle budget with a host extension", () => {
  test("the prebuilt extension fixture keeps its page and card body behind import()", () => {
    const descriptor = readFileSync(path.join(extensionFixture, "index.js"));
    const source = descriptor.toString("utf8");
    expect(source).toContain('import("./chunks/today-page.js")');
    expect(source).toContain('import("./chunks/status-card.js")');
    expect(source).not.toMatch(/^import .*["']\.\/chunks\//m);
    // The eager descriptor stays tiny: well under the 2 KiB fixture allowance.
    expect(Bun.gzipSync(descriptor).byteLength).toBeLessThan(KIB);
    const page = readFileSync(path.join(extensionFixture, "chunks/today-page.js"), "utf8");
    expect(page).toContain(PAGE_CLASS_MARKER);
    expect(page).toContain("className: pageClassName");
    // The page shares an icon module with the console's direct chat route, so
    // the fixture build exercises how the bundler places a module both graphs
    // import.
    expect(page).toMatch(/^import \{ PencilIcon \} from "lucide-react";$/m);
  });

  test.skipIf(!fixtureBuildRequested)(
    "OPENGENI_WEB_BUNDLE_FIXTURE_BUILD=1: the fixture extension build stays within 2 KiB of the stub's initial load",
    () => {
      // The staged copy must stay outside Tailwind's own scan, or the CSS
      // assertions below would pass without the extension source.
      const ignored = spawnSync("git", ["check-ignore", "-q", stagedFixture], { cwd: repoRoot });
      expect({ stagedFixture, ignored: ignored.status === 0 }).toEqual({
        stagedFixture,
        ignored: true,
      });
      const stub = buildAndMeasure("");
      let fixture: BuildMeasure;
      try {
        fixture = buildAndMeasure(stageFixture());
      } finally {
        removeStagedFixture();
      }
      // The descriptor is eager startup code. It may join an existing startup
      // chunk or, if the bundler splits it, become one small file of its own;
      // its pages and cards must add nothing else to the initial load.
      expect(fixture.report.initial.files).toBeLessThanOrEqual(stub.report.initial.files + 1);
      expect(fixture.report.initial.gzip - stub.report.initial.gzip).toBeLessThanOrEqual(2 * KIB);
      // Tailwind scans the configured extension: the class only its page uses
      // is generated for the fixture build and not for the stock one.
      expect(fixture.css).toContain(EXTENSION_ONLY_CSS);
      expect(stub.css).not.toContain(EXTENSION_ONLY_CSS);
      // Every page and card body the fixture ships is its own lazy entry,
      // outside the static initial graph. Manifest keys are relative to apps/web.
      const lazyKeys = readdirSync(path.join(extensionFixture, "chunks"))
        .filter((file) => file.endsWith(".js"))
        .map((file) => path.relative(webRoot, path.join(stagedFixture, "chunks", file)));
      expect(lazyKeys.length).toBeGreaterThan(0);
      const initialGraph = staticImportGraph(fixture.manifest);
      for (const key of lazyKeys) {
        expect({ key, inManifest: key in fixture.manifest }).toEqual({ key, inManifest: true });
        expect({ key, initial: initialGraph.has(key) }).toEqual({ key, initial: false });
      }
    },
    15 * 60 * 1000,
  );
});
