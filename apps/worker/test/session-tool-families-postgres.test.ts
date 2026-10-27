import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GOVERNED_ORGANIZATION_SESSION_POLICY,
  sessionToolFamilyGate,
} from "@opengeni/contracts/organization-session-policy";
import {
  bootstrapWorkspace,
  createDb,
  ensureGovernedOrganizationSessionPolicy,
  putHostOrganizationSessionPolicy,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  codemodeDeliveryForTurn,
  readTurnSessionToolFamilyGate,
  withoutDeniedFamilyTools,
} from "../src/activities/agent-turn/session-tool-families";

/*
 * The worker has no governance port. It reads the organization's stored
 * session policy once per turn and removes the denied families from every
 * tool list it assembles; no stored policy means nothing is removed.
 */

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("worker-session-tool-families");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function organizationId(): Promise<string> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test-host:tenant",
    accountExternalId: `worker-families-${suffix}`,
    accountName: "Worker families",
    workspaceExternalSource: "test",
    workspaceExternalId: `worker-families-${suffix}`,
    workspaceName: "Worker families",
    subjectId: `user:worker-families-${suffix}`,
  });
  return access.workspaceGrants[0]!.accountId;
}

const CATALOG = [
  "exec_command",
  "code_search",
  "command_read",
  "browser_open",
  "computer_act",
  "interaction__cua_click",
  "knowledge_search",
  "skill_read",
] as const;

describe("turn tool families", () => {
  test("no stored policy: the turn keeps every tool and Codemode delivery", async () => {
    const gate = await readTurnSessionToolFamilyGate(client.db, await organizationId());
    expect(gate.deniedFamilies.size).toBe(0);
    expect(withoutDeniedFamilyTools(CATALOG, (name) => name, gate)).toEqual([...CATALOG]);
    expect(codemodeDeliveryForTurn("modal", gate)).toBe("managed_file");
    expect(codemodeDeliveryForTurn("selfhosted", gate)).toBe("transient_exec");
  });

  test("the governed default removes every generic family and Codemode delivery", async () => {
    const id = await organizationId();
    await ensureGovernedOrganizationSessionPolicy(
      client.db,
      id,
      GOVERNED_ORGANIZATION_SESSION_POLICY,
    );
    const gate = await readTurnSessionToolFamilyGate(client.db, id);
    expect(withoutDeniedFamilyTools(CATALOG, (name) => name, gate)).toEqual([
      "knowledge_search",
      "skill_read",
    ]);
    expect(codemodeDeliveryForTurn("modal", gate)).toBe("none");
    expect(codemodeDeliveryForTurn("selfhosted", gate)).toBe("none");
  });

  test("a host allowlist keeps only the families it names", async () => {
    const id = await organizationId();
    await putHostOrganizationSessionPolicy(client.db, {
      organizationId: id,
      policy: { attachments: "enabled", toolFamilies: { mode: "allow", families: ["browser"] } },
      operationId: crypto.randomUUID(),
      actorSubjectId: "api_key:host",
    });
    const gate = await readTurnSessionToolFamilyGate(client.db, id);
    expect(withoutDeniedFamilyTools(CATALOG, (name) => name, gate)).toEqual([
      "browser_open",
      "knowledge_search",
      "skill_read",
    ]);
    expect(codemodeDeliveryForTurn("modal", gate)).toBe("none");
  });

  test("shell alone also withholds Codemode, which runs through the shell", () => {
    const gate = sessionToolFamilyGate({
      attachments: "enabled",
      toolFamilies: { mode: "deny", families: ["shell"] },
    });
    expect(codemodeDeliveryForTurn("modal", gate)).toBe("none");
  });
});
