import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing/shared-pg";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { executeMigrationFile } from "../src/migrate";

const expansionUrl = new URL("../drizzle/1025_host_session_create_admission.sql", import.meta.url);
const validationUrl = new URL(
  "../drizzle/1027_validate_host_session_create_admission.sql",
  import.meta.url,
);

describe("online host session create admission constraint", () => {
  test("enforces every new write before separate validation, preserving readiness fences", async () => {
    const expansion = await readFile(expansionUrl, "utf8");
    const validation = await readFile(validationUrl, "utf8");
    expect(expansion).toContain("NOT VALID");
    expect(expansion).not.toContain("VALIDATE CONSTRAINT");
    expect(validation).toContain("VALIDATE CONSTRAINT sessions_host_session_create_state_check");
    const blank = await acquireBlankTestDatabase("host-create-online-constraint");
    if (!blank) throw new Error("PostgreSQL unavailable");
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(`CREATE SCHEMA opengeni_private;
        CREATE TABLE sessions (id text PRIMARY KEY, account_id text, workspace_id text);
        CREATE TABLE session_turns (session_id text, account_id text, workspace_id text);
        CREATE TABLE session_realtime_modes (session_id text, account_id text, workspace_id text);
        INSERT INTO sessions VALUES ('historical', 'account', 'workspace');`);
      await executeMigrationFile(sql, "1025_host_session_create_admission.sql", expansion);
      // The production owner returns only after this file's implicit transaction
      // commits. Validation must not retain the expansion's table lock.
      const locks = await sql`SELECT mode FROM pg_locks WHERE pid = pg_backend_pid()
        AND relation = 'sessions'::regclass AND mode IN ('AccessExclusiveLock', 'ShareRowExclusiveLock')`;
      expect(locks).toHaveLength(0);
      const constraint = () => sql<Array<{ convalidated: boolean }>>`
        SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'sessions'::regclass AND conname = 'sessions_host_session_create_state_check'`;
      expect((await constraint())[0]?.convalidated).toBe(false);
      expect(
        (await sql`SELECT host_session_create_state FROM sessions WHERE id = 'historical'`)[0]
          ?.host_session_create_state,
      ).toBe("ready");
      await expect(
        sql`INSERT INTO sessions VALUES ('bad', 'account', 'workspace', 'unrecognized')`,
      ).rejects.toMatchObject({ code: "23514" });
      await sql`INSERT INTO sessions VALUES ('pending', 'account', 'workspace', 'pending'), ('failed', 'account', 'workspace', 'failed')`;
      for (const table of ["session_turns", "session_realtime_modes"]) {
        for (const id of ["pending", "failed", "missing"]) {
          await expect(
            sql.unsafe(`INSERT INTO ${table} VALUES ($1, 'account', 'workspace')`, [id]),
          ).rejects.toMatchObject({ code: "55000" });
        }
        await sql.unsafe(`INSERT INTO ${table} VALUES ('historical', 'account', 'workspace')`);
      }
      await executeMigrationFile(
        sql,
        "1027_validate_host_session_create_admission.sql",
        validation,
      );
      expect((await constraint())[0]?.convalidated).toBe(true);
      await expect(
        sql`UPDATE sessions SET host_session_create_state = 'unrecognized' WHERE id = 'historical'`,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
