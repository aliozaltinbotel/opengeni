import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  createDb,
  rawRows,
  setRlsContext,
  withRlsContext,
  withSessionRlsActorContext,
  type Database,
} from "../src/database";

// Pure input checks: RLS-context hardening fails LOUD on a missing account id
// instead of letting a blank GUC silently scope every read to zero rows — the
// phantom "no active subscription" failure mode this change set targets.

describe("setRlsContext input guard", () => {
  function dbThatMustNotExecute(): Database {
    return {
      execute: async () => {
        throw new Error("db.execute must not be reached for an invalid accountId");
      },
    } as unknown as Database;
  }

  test("rejects an empty accountId before issuing any query", async () => {
    await expect(setRlsContext(dbThatMustNotExecute(), { accountId: "" })).rejects.toThrow(
      /non-empty accountId/,
    );
  });

  test("rejects a blank/whitespace accountId", async () => {
    await expect(setRlsContext(dbThatMustNotExecute(), { accountId: "   " })).rejects.toThrow(
      /non-empty accountId/,
    );
  });

  test("rejects a non-string accountId", async () => {
    await expect(
      setRlsContext(dbThatMustNotExecute(), { accountId: undefined as unknown as string }),
    ).rejects.toThrow();
  });
});

describe("setRlsContext query budget", () => {
  test("applies the base tenant and protocol context in one database round trip", async () => {
    let executeCalls = 0;
    let executedQuery: SQL | undefined;
    const db = {
      execute: async (query: SQL) => {
        executeCalls += 1;
        executedQuery = query;
        return [];
      },
    } as unknown as Database;

    await setRlsContext(db, {
      accountId: "00000000-0000-0000-0000-000000000001",
      workspaceId: "00000000-0000-0000-0000-000000000002",
    });

    expect(executeCalls).toBe(1);
    const queryText = executedQuery ? new PgDialect().sqlToQuery(executedQuery).sql : undefined;
    expect(queryText).toContain("set_config('opengeni.account_id'");
    expect(queryText).toContain("set_config('opengeni.workspace_id'");
    expect(queryText).toContain("set_config('opengeni.lossless_content_writer'");
    expect(queryText).toContain("set_config('opengeni.sandbox_recovery_protocol_v2'");
    expect(queryText).toContain("set_config('opengeni.pending_tool_event_output_v1'");
    expect(queryText).toContain("set_config('opengeni.session_variable_set_attachments_v1'");
  });

  test.each(["array", "rows"] as const)(
    "applies actor settings together and separately verifies the subject with %s results",
    async (resultShape) => {
      const actor = {
        subjectId: "subject:rls-context",
        privateFileOwnerSubjectId: "subject:file-owner",
        initiatingHumanSubjectId: "subject:initiating-human",
      };
      const queries: SQL[] = [];
      const db = {
        execute: async (query: SQL) => {
          queries.push(query);
          const rows = queries.length === 1 ? [] : [{ subject_id: actor.subjectId }];
          return resultShape === "array" ? rows : { rows };
        },
      } as unknown as Database;

      await withSessionRlsActorContext(actor, () =>
        setRlsContext(db, {
          accountId: "00000000-0000-0000-0000-000000000001",
          workspaceId: "00000000-0000-0000-0000-000000000002",
        }),
      );

      expect(queries).toHaveLength(2);
      const dialect = new PgDialect();
      const setup = dialect.sqlToQuery(queries[0]!);
      for (const name of [
        "account_id",
        "workspace_id",
        "lossless_content_writer",
        "sandbox_recovery_protocol_v2",
        "pending_tool_event_output_v1",
        "session_variable_set_attachments_v1",
        "subject_id",
        "private_file_owner",
        "initiating_human_subject_id",
      ]) {
        expect(setup.sql).toContain(`set_config('opengeni.${name}'`);
      }
      expect(setup.params).toContain(actor.subjectId);
      expect(setup.params).toContain(actor.privateFileOwnerSubjectId);
      expect(setup.params).toContain(actor.initiatingHumanSubjectId);
      const readback = dialect.sqlToQuery(queries[1]!).sql;
      expect(readback).toContain("current_setting('opengeni.subject_id'");
      expect(readback).not.toContain("set_config");
    },
  );

  test.each(["array", "rows"] as const)(
    "rejects a mismatched subject readback with %s results",
    async (resultShape) => {
      let executeCalls = 0;
      const db = {
        execute: async () => {
          executeCalls += 1;
          const rows = executeCalls === 1 ? [] : [{ subject_id: "subject:other-backend" }];
          return resultShape === "array" ? rows : { rows };
        },
      } as unknown as Database;

      await expect(
        withSessionRlsActorContext({ subjectId: "subject:expected" }, () =>
          setRlsContext(db, { accountId: "00000000-0000-0000-0000-000000000001" }),
        ),
      ).rejects.toThrow("Authenticated subject RLS context was not applied on the active backend");
      expect(executeCalls).toBe(2);
    },
  );
});

describe("setRlsContext actor settings on PostgreSQL", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("rls-context");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
    client = createDb(shared.appUrl, { max: 1 });
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  test.each([false, true])(
    "applies exact actor and protocol settings and clears them at commit (optional identities=%s)",
    async (includeOptionalIdentities) => {
      const context = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
      const actor = {
        subjectId: `subject:${crypto.randomUUID()}`,
        ...(includeOptionalIdentities
          ? {
              privateFileOwnerSubjectId: `subject:${crypto.randomUUID()}`,
              initiatingHumanSubjectId: `subject:${crypto.randomUUID()}`,
            }
          : {}),
      };
      await withSessionRlsActorContext(actor, () =>
        withRlsContext(client.db, context, async (scoped) => {
          const [settings] = await rawRows(
            scoped,
            sql`
            select
              current_setting('opengeni.account_id', true) as account_id,
              current_setting('opengeni.workspace_id', true) as workspace_id,
              current_setting('opengeni.subject_id', true) as subject_id,
              current_setting('opengeni.private_file_owner', true) as private_file_owner,
              current_setting('opengeni.initiating_human_subject_id', true) as initiating_human_subject_id,
              current_setting('opengeni.lossless_content_writer', true) as lossless_content_writer,
              current_setting('opengeni.sandbox_recovery_protocol_v2', true) as sandbox_recovery_protocol_v2,
              current_setting('opengeni.pending_tool_event_output_v1', true) as pending_tool_event_output_v1,
              current_setting('opengeni.session_variable_set_attachments_v1', true) as session_variable_set_attachments_v1,
              rolsuper, rolbypassrls
            from pg_roles where rolname = current_user
          `,
          );
          expect(settings).toEqual({
            account_id: context.accountId,
            workspace_id: context.workspaceId,
            subject_id: actor.subjectId,
            private_file_owner: actor.privateFileOwnerSubjectId ?? "",
            initiating_human_subject_id: actor.initiatingHumanSubjectId ?? "",
            lossless_content_writer: "1",
            sandbox_recovery_protocol_v2: "1",
            pending_tool_event_output_v1: "1",
            session_variable_set_attachments_v1: "1",
            rolsuper: false,
            rolbypassrls: false,
          });
        }),
      );
      const [afterCommit] = await rawRows(
        client.db,
        sql`
        select
          current_setting('opengeni.account_id', true) as account_id,
          current_setting('opengeni.workspace_id', true) as workspace_id,
          current_setting('opengeni.subject_id', true) as subject_id,
          current_setting('opengeni.private_file_owner', true) as private_file_owner,
          current_setting('opengeni.initiating_human_subject_id', true) as initiating_human_subject_id
      `,
      );
      expect(afterCommit).toEqual({
        account_id: "",
        workspace_id: "",
        subject_id: "",
        private_file_owner: "",
        initiating_human_subject_id: "",
      });
    },
  );

  test("RLS rollback permits same-backend reuse with a new tenant and actor, then no actor", async () => {
    const readScope = (db: Database) =>
      rawRows<{
        pid: number;
        account_id: string;
        workspace_id: string;
        subject_id: string;
      }>(
        db,
        sql`select pg_backend_pid() as pid,
      current_setting('opengeni.account_id', true) as account_id,
      current_setting('opengeni.workspace_id', true) as workspace_id,
      current_setting('opengeni.subject_id', true) as subject_id`,
      );
    const first = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
    const second = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
    let firstPid: number | undefined;
    await expect(
      withSessionRlsActorContext({ subjectId: "subject:rolled-back" }, () =>
        withRlsContext(client.db, first, async (tx) => {
          firstPid = (await readScope(tx))[0]!.pid;
          await tx.execute(sql`select 1 / 0`);
        }),
      ),
    ).rejects.toThrow();
    const [cleared] = await readScope(client.db);
    expect(cleared).toEqual({ pid: firstPid, account_id: "", workspace_id: "", subject_id: "" });
    await withSessionRlsActorContext({ subjectId: "subject:retry" }, () =>
      withRlsContext(client.db, second, async (tx) => {
        expect((await readScope(tx))[0]).toEqual({
          pid: firstPid,
          account_id: second.accountId,
          workspace_id: second.workspaceId,
          subject_id: "subject:retry",
        });
      }),
    );
    await withRlsContext(client.db, first, async (tx) => {
      expect((await readScope(tx))[0]).toEqual({
        pid: firstPid,
        account_id: first.accountId,
        workspace_id: first.workspaceId,
        subject_id: "",
      });
    });
  });

  test("an absent actor preserves inherited identities across a nested tenant scope", async () => {
    const outer = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
    const inner = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() };
    await withRlsContext(client.db, outer, async (scoped) => {
      await scoped.execute(sql`select
        set_config('opengeni.subject_id', 'subject:inherited', true),
        set_config('opengeni.private_file_owner', 'subject:inherited-owner', true),
        set_config('opengeni.initiating_human_subject_id', 'subject:inherited-human', true)`);
      await withRlsContext(scoped, inner, async (nested) => {
        const [settings] = await rawRows(
          nested,
          sql`
          select
            current_setting('opengeni.account_id', true) as account_id,
            current_setting('opengeni.workspace_id', true) as workspace_id,
            current_setting('opengeni.subject_id', true) as subject_id,
            current_setting('opengeni.private_file_owner', true) as private_file_owner,
            current_setting('opengeni.initiating_human_subject_id', true) as initiating_human_subject_id
        `,
        );
        expect(settings).toEqual({
          account_id: inner.accountId,
          workspace_id: inner.workspaceId,
          subject_id: "subject:inherited",
          private_file_owner: "subject:inherited-owner",
          initiating_human_subject_id: "subject:inherited-human",
        });
      });
      const [restored] = await rawRows(
        scoped,
        sql`
        select
          current_setting('opengeni.account_id', true) as account_id,
          current_setting('opengeni.workspace_id', true) as workspace_id,
          current_setting('opengeni.subject_id', true) as subject_id,
          current_setting('opengeni.private_file_owner', true) as private_file_owner,
          current_setting('opengeni.initiating_human_subject_id', true) as initiating_human_subject_id
      `,
      );
      expect(restored).toEqual({
        account_id: outer.accountId,
        workspace_id: outer.workspaceId,
        subject_id: "subject:inherited",
        private_file_owner: "subject:inherited-owner",
        initiating_human_subject_id: "subject:inherited-human",
      });
    });
  });
});
