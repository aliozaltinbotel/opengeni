import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";

const output = process.env.OPENGENI_CLERK_RECOVERY_EVIDENCE_DIR ?? "/tmp/opengeni-clerk-recovery";
let web: StartedProcess;
let browser: Browser;
let base: string;
beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const node = Bun.which("node");
  if (!node) throw new Error("The native web browser fixture requires Node.js 22 or later");
  web = await startProcess(
    [
      node,
      "node_modules/vite/bin/vite.js",
      "dev",
      ".",
      "--config",
      "test/clerk-recovery.vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: new URL("../../apps/web", import.meta.url).pathname,
      env: { VITE_API_BASE_URL: "" },
      ready: async () =>
        (await fetch(base, { signal: AbortSignal.timeout(2000) }).catch(() => null))?.ok === true,
      timeoutMs: 45000,
    },
  );
  browser = await chromium.launch({ headless: true });
  await mkdir(output, { recursive: true });
}, 60000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
});
async function api(context: BrowserContext) {
  const calls: string[] = [];
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push(path);
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION },
        body: JSON.stringify(body),
      });
    if (path === "/v1/config/client") {
      if (request.headers().authorization !== "Bearer fixture-token:allowed")
        return json({ code: "NOT_AUTHORIZED" }, 403);
      return json({
        apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
        deploymentRevision: "",
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
        models: [],
        defaultReasoningEffort: "none",
        allowedReasoningEfforts: ["none"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 0 },
        productAccessMode: "local",
        auth: { mode: "none" },
        analytics: { consentRequired: true, providers: {} },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      });
    }
    if (path === "/v1/access/me")
      return json({
        subjectId: "fixture-person",
        accountGrants: [],
        workspaceGrants: [],
        defaultWorkspaceId: null,
      });
    if (path === "/v1/workspaces") return json([]);
    if (request.method() === "POST") return route.fulfill({ status: 204 });
    return json({ code: "UNEXPECTED_FIXTURE_READ" }, 404);
  });
  return calls;
}
for (const width of [390, 1440])
  test(`Clerk refusal recovery keyboard flow at ${width}px (client emulation)`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    try {
      const calls = await api(context);
      const page = await context.newPage();
      await page.goto(
        `${base}/workspaces/00000000-0000-4000-8000-000000000099/sessions/00000000-0000-4000-8000-000000000098?workspaceId=old#old`,
      );
      await page.getByRole("heading", { name: "Choose an organization" }).waitFor();
      expect(await page.locator("body").innerText()).not.toContain("Create organization");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `${output}/refused-${width}.png` });
      await page.getByRole("combobox", { name: "Organization", exact: true }).focus();
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      expect(
        await page.getByRole("combobox", { name: "Organization", exact: true }).inputValue(),
      ).toBe("allowed");
      await page.keyboard.press("Tab");
      expect(
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "No workspace access" }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/");
      expect(new URL(page.url()).search).toBe("");
      expect(new URL(page.url()).hash).toBe("");
      expect(calls.filter((path) => path === "/v1/config/client")).toHaveLength(2);
    } finally {
      await context.tracing.stop({ path: `${output}/recovery-${width}.zip` });
      await context.close();
    }
  }, 60000);
test("Clerk account change is explicit and returns to sign-in without anonymous config I/O", async () => {
  const context = await browser.newContext();
  try {
    const calls = await api(context);
    const page = await context.newPage();
    await page.goto(base);
    await page.getByRole("button", { name: "Use another account", exact: true }).click();
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    expect(calls.filter((path) => path === "/v1/config/client")).toHaveLength(1);
  } finally {
    await context.close();
  }
}, 60000);
