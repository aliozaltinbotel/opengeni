import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  GRANDFATHERED_MIGRATIONS,
  GRANDFATHERED_VACUOUS_GUARDS,
  MIGRATIONS_DIR,
  analyzeMigrationRlsBackfills,
  readsTable,
  splitStatements,
  staleAllowlistEntries,
  stripComments,
  unreviewedFindings,
  writesTable,
} from "./migration-rls-backfills";

const temporaryDirectories: string[] = [];

function fixture(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "og-rls-backfill-"));
  temporaryDirectories.push(directory);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(directory, name), body, "utf8");
  }
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const FORCED_TABLE = `
CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "workspace_id" uuid, "origin_workspace_id" uuid);
ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "widgets"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
`;

const CATALOG_WINDOW = `
CREATE TEMP TABLE saved_forced_tables ON COMMIT DROP AS
SELECT class.oid::regclass AS relation FROM pg_class class
WHERE class.oid IN ('widgets'::regclass) AND class.relforcerowsecurity;
DO $open_window$
DECLARE forced regclass;
BEGIN
  FOR forced IN SELECT relation FROM saved_forced_tables ORDER BY relation::text LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', forced);
  END LOOP;
END $open_window$;
UPDATE widgets SET origin_workspace_id = workspace_id;
DO $close_window$
DECLARE forced regclass;
BEGIN
  FOR forced IN SELECT relation FROM saved_forced_tables ORDER BY relation::text LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', forced);
  END LOOP;
END $close_window$;
`;

describe("catalog-filtered owner posture window", () => {
  const analyze = (window: string, extra: Record<string, string> = {}) =>
    analyzeMigrationRlsBackfills(
      fixture({
        "0001_base.sql": FORCED_TABLE,
        "0002_window.sql": window,
        ...extra,
      }),
    );

  test("accepts the exact closed regclass window", () => {
    expect(analyze(CATALOG_WINDOW)).toEqual([]);
  });
  test.each([
    ["missing restore", CATALOG_WINDOW.slice(0, CATALOG_WINDOW.indexOf("DO $close_window$"))],
    ["unfiltered snapshot", CATALOG_WINDOW.replace(" AND class.relforcerowsecurity", "")],
    ["unbounded catalog", CATALOG_WINDOW.replace("class.oid IN ('widgets'::regclass) AND ", "")],
    [
      "policy bypass",
      CATALOG_WINDOW.replace(
        "UPDATE widgets",
        "CREATE POLICY bypass ON widgets USING (true); UPDATE widgets",
      ),
    ],
    [
      "extra open-loop policy",
      CATALOG_WINDOW.replace(
        "END $open_window$",
        "CREATE POLICY bypass ON widgets USING (true); END $open_window$",
      ),
    ],
    [
      "snapshot tampering",
      CATALOG_WINDOW.replace("UPDATE widgets", "DELETE FROM saved_forced_tables; UPDATE widgets"),
    ],
    [
      "different restore snapshot",
      CATALOG_WINDOW.replace(
        "FROM saved_forced_tables ORDER BY relation::text LOOP\n    EXECUTE format('ALTER TABLE %s FORCE",
        "FROM other_tables ORDER BY relation::text LOOP\n    EXECUTE format('ALTER TABLE %s FORCE",
      ),
    ],
  ])("rejects %s", (_label, window) => {
    expect(analyze(window)).toContainEqual(
      expect.objectContaining({ kind: "write", tables: ["widgets"] }),
    );
  });
  test("only listed tables receive owner visibility", () => {
    expect(
      analyze(CATALOG_WINDOW.replace("'widgets'::regclass", "'other_table'::regclass")),
    ).toHaveLength(1);
  });
  test("re-arms after close and in the next file", () => {
    const findings = analyze(`${CATALOG_WINDOW}\nUPDATE widgets SET origin_workspace_id = NULL;`, {
      "0003_after.sql": "UPDATE widgets SET origin_workspace_id = NULL;",
    });
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.file)).toEqual(["0002_window.sql", "0003_after.sql"]);
  });
});

describe("splitStatements", () => {
  test("keeps a dollar-quoted body as one statement", () => {
    const statements = splitStatements(
      `SELECT 1;\nDO $tag$ BEGIN UPDATE x SET y = 1; END $tag$;\nSELECT 2;`,
    );
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("END $tag$");
  });

  test("does not split on a semicolon inside a string or comment", () => {
    const statements = splitStatements(`SELECT ';'; -- trailing ; comment\nSELECT 2;`);
    expect(statements).toHaveLength(2);
  });
});

describe("writesTable", () => {
  test("matches quoted and bare targets but not a same-named string literal", () => {
    expect(writesTable(`UPDATE "widgets" SET a = 1`, "widgets")).toBe(true);
    expect(writesTable(`INSERT INTO widgets (a) SELECT 1`, "widgets")).toBe(true);
    expect(writesTable(`DELETE FROM ONLY widgets`, "widgets")).toBe(true);
    expect(writesTable(`SELECT 1 WHERE tablename = 'widgets'`, "widgets")).toBe(false);
    expect(writesTable(`UPDATE widgets_archive SET a = 1`, "widgets")).toBe(false);
  });

  test("readsTable matches query positions only", () => {
    expect(readsTable(`SELECT 1 FROM "widgets"`, "widgets")).toBe(true);
    expect(readsTable(`SELECT 1 FROM x JOIN widgets ON true`, "widgets")).toBe(true);
    expect(readsTable(`SELECT 1 FROM pg_policies WHERE tablename = 'widgets'`, "widgets")).toBe(
      false,
    );
  });
});

describe("analyzeMigrationRlsBackfills", () => {
  test("0697 catalog definition classification requires exact statement bytes", () => {
    const patch = readFileSync(
      new URL("../packages/db/drizzle/0697_codex_retry_after_unknown_outcome.sql", import.meta.url),
      "utf8",
    );
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE.replaceAll("widgets", "session_turn_attempts"),
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toEqual([]);
    // Even comment-only drift loses the exact source classification.
    expect(analyze(patch.replace("-- An explicit Retry", "-- A changed Retry"))).toMatchObject([
      { kind: "vacuous-guard", tables: ["session_turn_attempts"] },
    ]);
    expect(
      analyze(
        patch.replace(
          "END\n$retry_after_unknown$",
          "DELETE FROM session_turn_attempts; END\n$retry_after_unknown$",
        ),
      ),
    ).toMatchObject([{ kind: "write", tables: ["session_turn_attempts"] }]);
    expect(analyze(`${patch}\nDELETE FROM session_turn_attempts;`)).toMatchObject([
      { kind: "write", statement: 2, tables: ["session_turn_attempts"] },
    ]);
    expect(
      analyze(
        `${patch}\nDO $guard$ BEGIN IF EXISTS (SELECT 1 FROM session_turn_attempts) THEN RAISE EXCEPTION 'actual guard'; END IF; END $guard$;`,
      ),
    ).toMatchObject([{ kind: "vacuous-guard", statement: 2, tables: ["session_turn_attempts"] }]);
    const changedDynamicSql = patch
      .replace(/anchor := \$old\$[\s\S]*?\$old\$;/, "anchor := $old$OR REPLACE FUNCTION$old$;")
      .replace(
        /\$new\$[\s\S]*?\$new\$/,
        "$new$TABLE scratch (id int); DELETE FROM session_turn_attempts; CREATE OR REPLACE FUNCTION$new$",
      );
    expect(analyze(changedDynamicSql)).toMatchObject([
      { kind: "write", tables: ["session_turn_attempts"] },
    ]);
  });

  test("0494 resolver patch is runtime source while real snapshot preflights remain guarded", () => {
    const migration = readFileSync(
      new URL("../packages/db/drizzle/0494_mcp_account_bindings.sql", import.meta.url),
      "utf8",
    );
    const patch = migration.match(/DO \$resolver\$[\s\S]*?END \$resolver\$;/)![0];
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE.replaceAll(
            "widgets",
            "turn_connection_authority_snapshots",
          ),
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toEqual([]);
    expect(
      analyze(
        patch.replace(
          "END $resolver$",
          `IF EXISTS (SELECT 1 FROM turn_connection_authority_snapshots)
      THEN RAISE EXCEPTION 'actual migration guard'; END IF; END $resolver$`,
        ),
      ),
    ).toMatchObject([{ kind: "vacuous-guard", tables: ["turn_connection_authority_snapshots"] }]);
    expect(
      analyze(patch.replace("EXECUTE replace(definition,anchor,insertion);", "EXECUTE insertion;")),
    ).toMatchObject([{ kind: "vacuous-guard", tables: ["turn_connection_authority_snapshots"] }]);
  });
  test("distinguishes catalog routine patches from executed dynamic SQL and real guards", () => {
    const patch = `DO $patch$ DECLARE definition text; replacement text; anchor text;
BEGIN
definition := pg_get_functiondef('example()'::regprocedure);
replacement := $body$ IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'runtime only'; END IF; $body$;
IF definition IS NULL THEN RAISE EXCEPTION 'missing catalog routine'; END IF;
EXECUTE replace(definition, anchor, replacement);
END $patch$;`;
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE,
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toHaveLength(0);
    expect(
      analyze(
        patch.replace(
          "END $patch$",
          "IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'real guard'; END IF; END $patch$",
        ),
      ),
    ).toHaveLength(1);
    expect(
      analyze(
        patch.replace("EXECUTE replace(definition, anchor, replacement);", "EXECUTE replacement;"),
      ),
    ).toHaveLength(1);
    expect(
      analyze(patch.replace("EXECUTE replace", "definition := 'SELECT 1'; EXECUTE replace")),
    ).toHaveLength(1);
  });
  test("recognizes catalog SELECT INTO routine patches without hiding executed queries", () => {
    const patch = `DO $patch$ DECLARE definition text; source text; facts jsonb;
  anchor text := $old$ SELECT id INTO row FROM widgets; $old$;
  replacement text := $new$ IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'runtime only'; END IF; $new$;
BEGIN
SELECT p.prosrc, pg_catalog.pg_get_functiondef(p.oid), jsonb_build_object('owner', p.proowner)
INTO source, definition, facts FROM pg_catalog.pg_proc p WHERE p.oid = target;
IF definition IS NULL THEN RAISE EXCEPTION 'missing catalog routine'; END IF;
IF source NOT LIKE '%' || anchor || '%'
 OR (length(source) - length(replace(source, anchor, ''))) / length(anchor) <> 1
THEN RAISE EXCEPTION 'catalog anchor changed'; END IF;
EXECUTE format('CREATE POLICY example ON widgets FOR SELECT USING (false)');
EXECUTE replace(definition, anchor, replacement);
END $patch$;`;
    const analyze = (sql: string) => analyzeMigrationRlsBackfills(
      fixture({ "0001_base.sql": FORCED_TABLE, "0002_patch.sql": sql }),
    );
    expect(analyze(patch)).toHaveLength(0);
    expect(analyze(patch.replace(
      "EXECUTE replace(definition, anchor, replacement);",
      "definition := replace(definition, anchor, replacement); EXECUTE definition;",
    ))).toHaveLength(0);
    for (const mutation of [
      (sql: string) => sql.replace("END $patch$", "UPDATE widgets SET id = id; END $patch$"),
      (sql: string) => sql.replace("END $patch$", "EXECUTE 'DELETE FROM widgets'; END $patch$"),
      (sql: string) => sql.replace("END $patch$", "IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'real guard'; END IF; END $patch$"),
      (sql: string) => sql.replace("EXECUTE replace(definition, anchor, replacement);", "EXECUTE replacement;"),
      (sql: string) => sql.replace("END $patch$", "EXECUTE anchor; END $patch$"),
      (sql: string) => sql.replace("END $patch$", "PERFORM unknown(replacement); END $patch$"),
      (sql: string) => sql.replace("EXECUTE replace", "definition := 'SELECT 1'; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "SELECT 'SELECT 1' INTO definition; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "SELECT '1' INTO STRICT definition; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "GET DIAGNOSTICS definition = ROW_COUNT; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "GET CURRENT DIAGNOSTICS definition = ROW_COUNT; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "GET STACKED DIAGNOSTICS definition = MESSAGE_TEXT; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "definition = '1'; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", '"definition" := \'1\'; EXECUTE replace'),
      (sql: string) => sql.replace("EXECUTE replace", "CALL mutate(definition); EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "FOR definition IN SELECT '1' LOOP NULL; END LOOP; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "FOREACH definition IN ARRAY ARRAY['1'] LOOP NULL; END LOOP; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "FETCH cursor INTO definition; EXECUTE replace"),
      (sql: string) => sql.replace("EXECUTE replace", "EXECUTE 'SELECT 1' INTO definition; EXECUTE replace"),
      (sql: string) => sql.replace("INTO source, definition, facts", "INTO definition, source, facts"),
      (sql: string) => sql.replace("pg_catalog.pg_get_functiondef", "untrusted.pg_get_functiondef"),
    ]) expect(analyze(mutation(patch)).length).toBeGreaterThan(0);
    const diagnosticOverwrite = patch
      .replace("SELECT id INTO row FROM widgets;", "1")
      .replace("IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'runtime only'; END IF;", "UPDATE widgets SET id = id;")
      .replace("EXECUTE replace", "GET DIAGNOSTICS definition = ROW_COUNT; EXECUTE replace");
    expect(analyze(diagnosticOverwrite)).toMatchObject([{ kind: "write", tables: ["widgets"] }]);
    const directOverwrite = diagnosticOverwrite.replace(
      /SELECT p\.prosrc, pg_catalog\.pg_get_functiondef\(p\.oid\), jsonb_build_object\('owner', p\.proowner\)\s+INTO source, definition, facts FROM pg_catalog\.pg_proc p WHERE p\.oid = target;/,
      "definition := pg_get_functiondef(target);",
    );
    expect(analyze(directOverwrite)).toMatchObject([{ kind: "write", tables: ["widgets"] }]);
  });
  test("refuses duplicate catalog INTO targets that overwrite the routine definition", () => {
    for (const duplicateTarget of ["definition", "DEFINITION"]) {
      const patch = `DO $patch$ DECLARE definition text;
anchor text := $old$old body$old$;
replacement text := $new$UPDATE widgets SET id = id;$new$;
BEGIN
SELECT pg_catalog.pg_get_functiondef(p.oid), 'old body'
INTO definition, ${duplicateTarget} FROM pg_catalog.pg_proc p WHERE p.oid = target;
EXECUTE replace(definition, anchor, replacement);
END $patch$;`;
      expect(analyzeMigrationRlsBackfills(fixture({
        "0001_base.sql": FORCED_TABLE,
        "0002_patch.sql": patch,
      })), duplicateTarget).toMatchObject([{ kind: "write", tables: ["widgets"] }]);
    }
  });
  test("keeps delimiter and function-header escapes visible in both publication paths", () => {
    const analyze = (sql: string) => analyzeMigrationRlsBackfills(
      fixture({ "0001_base.sql": FORCED_TABLE, "0002_patch.sql": sql }),
    );
    for (const [anchor, replacement] of [
      ["body anchor", "$function$; UPDATE widgets SET id = id; $function$"],
      ["CREATE OR REPLACE FUNCTION example()", "UPDATE widgets SET id = id;"],
      ["LANGUAGE plpgsql", "LANGUAGE plpgsql; UPDATE widgets SET id = id;"],
    ]) {
      const declarations = `DECLARE definition text;
anchor text := $old$${anchor}$old$;
replacement text := $new$${replacement}$new$;`;
      const catalogRead = "SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p WHERE p.oid = target;";
      const directRead = "definition := pg_get_functiondef(target);";
      for (const [read, publish] of [
        [catalogRead, "EXECUTE replace(definition, anchor, replacement);"],
        [catalogRead, "definition := replace(definition, anchor, replacement); EXECUTE definition;"],
        [directRead, "definition := replace(definition, anchor, replacement); EXECUTE definition;"],
      ]) expect(analyze(`DO $patch$ ${declarations} BEGIN ${read} ${publish} END $patch$;`))
        .toMatchObject([{ kind: "write", tables: ["widgets"] }]);
      expect(analyze(`DO $patch$ DECLARE definition text; BEGIN ${directRead}
definition := replace(definition, '${anchor}', '${replacement}');
EXECUTE definition; END $patch$;`))
        .toMatchObject([{ kind: "write", tables: ["widgets"] }]);
    }
  });
  test("keeps encoded or concatenated publication delimiters and headers opaque", () => {
    for (const literal of [
      String.raw`E'\x24function\x24; UPDATE widgets SET id = id; \x24function\x24'`,
      String.raw`E'\044function\044; UPDATE widgets SET id = id; \044function\044'`,
      String.raw`E'\u0024function\u0024; UPDATE widgets SET id = id; \u0024function\u0024'`,
      String.raw`'\x24function\x24; UPDATE widgets SET id = id; \x24function\x24'`,
      "E'$fun' || E'ction$; UPDATE widgets SET id = id; $function$'",
      "'CRE' || 'ATE FUNCTION example(); UPDATE widgets SET id = id;'",
    ]) {
      for (const body of [
        `definition := pg_get_functiondef(target); definition := replace(definition, 'body anchor', ${literal}); EXECUTE definition;`,
        `SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p WHERE p.oid = target; EXECUTE replace(definition, 'body anchor', ${literal});`,
      ]) expect(analyzeMigrationRlsBackfills(fixture({
        "0001_base.sql": FORCED_TABLE,
        "0002_patch.sql": `DO $patch$ DECLARE definition text; BEGIN ${body} END $patch$;`,
      })), `${literal} / ${body.startsWith("SELECT") ? "SELECT" : "assignment"}`)
        .toMatchObject([{ kind: "write", tables: ["widgets"] }]);
    }
  });
  test("admits literal constant anchors but refuses unknown anchor or definition mutations", () => {
    const patch = `DO $patch$ DECLARE definition text; anchor text; BEGIN
definition := pg_get_functiondef(target);
anchor := E'old body\\n' || 'old tail';
IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1
THEN RAISE EXCEPTION 'catalog source changed'; END IF;
definition := replace(definition, anchor, E'UPDATE widgets SET id = id;\\n' || anchor);
EXECUTE definition; END $patch$;`;
    const analyze = (body: string) => analyzeMigrationRlsBackfills(fixture({
      "0001_base.sql": FORCED_TABLE, "0002_patch.sql": body,
    }));
    expect(analyze(patch)).toHaveLength(0);
    for (const mutation of [
      "CALL mutate(anchor);", "GET DIAGNOSTICS anchor = ROW_COUNT;", "anchor = '1';",
      "SELECT '1' INTO STRICT anchor;", "CALL mutate(definition);",
      "GET DIAGNOSTICS definition = ROW_COUNT;", "definition = '1';",
    ]) expect(analyze(patch.replace("EXECUTE definition;", mutation + " EXECUTE definition;")).length)
      .toBeGreaterThan(0);
  });
  test("keeps definition snapshot witnesses read-only", () => {
    const patch = `DO $patch$ DECLARE definition text; previous text; BEGIN
definition := pg_get_functiondef(target); previous := definition;
definition := replace(definition, 'old body', 'UPDATE widgets SET id = id;');
IF definition = previous THEN RAISE EXCEPTION 'catalog source changed'; END IF;
EXECUTE definition; END $patch$;`;
    const analyze = (body: string) => analyzeMigrationRlsBackfills(fixture({
      "0001_base.sql": FORCED_TABLE, "0002_patch.sql": body,
    }));
    expect(analyze(patch)).toHaveLength(0);
    for (const mutation of ["CALL mutate(previous);", "previous = '1';", "EXECUTE previous;"])
      expect(analyze(patch.replace("EXECUTE definition;", mutation + " EXECUTE definition;")).length)
        .toBeGreaterThan(0);
  });
  test("treats a replacement initialised in DECLARE as the same catalog routine patch", () => {
    const patch = `DO $patch$ DECLARE definition text;
  anchor text := $old$ RETURN NULL; $old$;
  replacement text := $new$ SELECT id INTO v_row FROM widgets WHERE id = NEW.id; RETURN NULL; $new$;
BEGIN
definition := pg_get_functiondef('example()'::regprocedure);
IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'anchor drifted'; END IF;
EXECUTE replace(definition, anchor, replacement);
END $patch$;`;
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE,
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toHaveLength(0);
    expect(
      analyze(
        patch.replace(
          "END $patch$",
          "IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'real guard'; END IF; END $patch$",
        ),
      ),
    ).toHaveLength(1);
    expect(
      analyze(
        patch.replace("EXECUTE replace(definition, anchor, replacement);", "EXECUTE replacement;"),
      ),
    ).toHaveLength(1);
  });
  test("ignores chained pg_get_functiondef replacements but still sees independent writes", () => {
    const patch = `DO $patch$ DECLARE definition text;
BEGIN
definition := pg_get_functiondef('example()'::regprocedure);
IF definition IS NULL THEN RAISE EXCEPTION 'missing catalog routine'; END IF;
definition := replace(definition, 'anchor one', 'DELETE FROM widgets;');
definition := replace(definition, 'anchor two', 'UPDATE widgets SET id = id;');
EXECUTE definition;
END $patch$;`;
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE,
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toHaveLength(0);
    expect(
      analyze(
        patch.replace("EXECUTE definition;", "EXECUTE definition; UPDATE widgets SET id = id;"),
      ),
    ).toHaveLength(1);
    expect(
      analyze(
        patch.replace("EXECUTE definition;", "EXECUTE 'DELETE FROM widgets'; EXECUTE definition;"),
      ),
    ).toHaveLength(1);
  });
  test("treats pg_catalog-qualified routine patch built-ins like their bare forms", () => {
    // Comment stripping keeps literals whole but still strips code comments.
    expect(stripComments("SELECT '-- kept' -- don't keep\nFROM t")).toBe(
      "SELECT '-- kept'  \nFROM t",
    );
    expect(stripComments("x := E'it\\'s -- kept\\n'; /* it's gone */ y")).toBe(
      "x := E'it\\'s -- kept\\n';   y",
    );
    expect(stripComments("x := 'a''b -- kept'; z")).toBe("x := 'a''b -- kept'; z");
    expect(stripComments("DO $b$ BEGIN -- gone\nUPDATE widgets SET id = id; END $b$")).toBe(
      "DO $b$ BEGIN  \nUPDATE widgets SET id = id; END $b$",
    );
    // Comment text can never suppress a finding, even after an apostrophe in a
    // nested dollar-quoted string keeps that comment visible to the lexer.
    const analyzeOne = (sql: string) =>
      analyzeMigrationRlsBackfills(fixture({ "0001_base.sql": FORCED_TABLE, "0002_x.sql": sql }));
    const nested = `DO $b$ BEGIN
RAISE NOTICE '%', $m$it's a backfill$m$;
-- SUPPRESSOR
UPDATE widgets SET id = id;
END $b$;`;
    for (const suppressor of [
      "TODO: ALTER TABLE widgets NO FORCE ROW LEVEL SECURITY first",
      "TODO: ALTER TABLE widgets DISABLE ROW LEVEL SECURITY first",
      "PERFORM set_config('opengeni.workspace_id', 'x', true);",
    ]) {
      expect(analyzeOne(nested.replace("SUPPRESSOR", suppressor))).toMatchObject([
        { kind: "write", tables: ["widgets"] },
      ]);
    }
    expect(
      analyzeOne("DO $b$ BEGIN PERFORM '--'; UPDATE widgets SET id = id; END $b$;"),
    ).toMatchObject([{ kind: "write", tables: ["widgets"] }]);
    const patch = `DO $patch$ DECLARE target regprocedure; definition text;
BEGIN
target := pg_catalog.to_regprocedure('example()');
IF target IS NULL THEN RAISE EXCEPTION 'missing catalog routine'; END IF;
definition := pg_catalog.pg_get_functiondef(target);
definition := pg_catalog.replace(definition, 'anchor one', E'  -- runtime note\\n' || E'IF NOT EXISTS (SELECT 1 FROM widgets)\\n');
definition := pg_catalog.replace(definition, 'anchor two', 'DELETE FROM widgets;');
EXECUTE definition;
END $patch$;`;
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE,
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toHaveLength(0);
    // Only pg_catalog is equivalent; any other schema stays opaque.
    expect(
      analyze(patch.replace("pg_catalog.pg_get_functiondef", "other.pg_get_functiondef")),
    ).toHaveLength(1);
    expect(
      analyze(patch.replaceAll("pg_catalog.replace(definition", "other.replace(definition")),
    ).toHaveLength(1);
    // A real guard or write outside the replacements is still visible.
    expect(
      analyze(
        patch.replace(
          "EXECUTE definition;",
          "IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'real guard'; END IF; EXECUTE definition;",
        ),
      ),
    ).toMatchObject([{ kind: "vacuous-guard", tables: ["widgets"] }]);
    expect(
      analyze(patch.replace("EXECUTE definition;", "EXECUTE definition; DELETE FROM widgets;")),
    ).toMatchObject([{ kind: "write", tables: ["widgets"] }]);
  });
  test("flags a bare backfill over a FORCE-RLS table", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `UPDATE "widgets" SET "origin_workspace_id" = "workspace_id" WHERE "origin_workspace_id" IS NULL;`,
    });
    const findings = analyzeMigrationRlsBackfills(directory);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "0002_backfill.sql",
      kind: "write",
      tables: ["widgets"],
    });
  });

  test("flags a preflight guard that can only ever see zero rows", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_guard.sql": `
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM "widgets" WHERE "origin_workspace_id" IS NULL) THEN
    RAISE EXCEPTION 'undrained widgets at cutover';
  END IF;
END $guard$;
`,
    });
    const findings = analyzeMigrationRlsBackfills(directory);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "vacuous-guard", tables: ["widgets"] });
  });

  test("a preflight guard inside the NO FORCE window is effective", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_guard.sql": `
ALTER TABLE "widgets" NO FORCE ROW LEVEL SECURITY;
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM "widgets") THEN RAISE EXCEPTION 'undrained'; END IF;
END $guard$;
ALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("a catalog-only drain guard is not flagged", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_guard.sql": `
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = 'opengeni_app') THEN
    RAISE EXCEPTION 'stop every application writer first';
  END IF;
END $guard$;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("accepts the owner-only NO FORCE window", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
ALTER TABLE "widgets" NO FORCE ROW LEVEL SECURITY;
UPDATE "widgets" SET "origin_workspace_id" = "workspace_id";
ALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("re-arms once the window closes inside the same file", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
ALTER TABLE "widgets" NO FORCE ROW LEVEL SECURITY;
UPDATE "widgets" SET "origin_workspace_id" = "workspace_id";
ALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;
UPDATE "widgets" SET "origin_workspace_id" = NULL;
`,
    });
    const findings = analyzeMigrationRlsBackfills(directory);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.snippet).toContain("= NULL");
  });

  test("the window does not leak into the next migration file", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_window.sql": `ALTER TABLE "widgets" NO FORCE ROW LEVEL SECURITY;\nALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;`,
      "0003_backfill.sql": `UPDATE "widgets" SET "origin_workspace_id" = "workspace_id";`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("accepts a backfill that sets the tenant GUC first", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
SELECT set_config('opengeni.account_id', '00000000-0000-0000-0000-000000000000', true);
UPDATE "widgets" SET "origin_workspace_id" = "workspace_id";
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("accepts a transaction-local capability pinned to the exact table owner", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_owner_repair ON widgets
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
);
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("accepts only the exact governed runner capability for its batched migration", () => {
    const policy = `
CREATE TABLE new_session_drafts (id uuid PRIMARY KEY);
ALTER TABLE new_session_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE new_session_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY draft_owner_repair ON new_session_drafts
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'new_session_drafts'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.new_session_draft_project_provenance_backfill_v1', true
  ) = '1'
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'new_session_drafts'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.new_session_draft_project_provenance_backfill_v1', true
  ) = '1'
);
`;
    const backfill = `-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=500 lock-timeout=1s statement-timeout=10s
WITH candidates AS (SELECT id FROM new_session_drafts LIMIT 500)
UPDATE new_session_drafts SET id = new_session_drafts.id FROM candidates
WHERE new_session_drafts.id = candidates.id RETURNING new_session_drafts.id;
`;
    const accepted = fixture({
      "0409_new_session_draft_project_provenance.sql": policy,
      "0411_new_session_draft_project_provenance_backfill.sql": backfill,
    });
    expect(analyzeMigrationRlsBackfills(accepted)).toHaveLength(0);

    const wrongFile = fixture({
      "0409_new_session_draft_project_provenance.sql": policy,
      "0413_unrelated_backfill.sql": backfill,
    });
    expect(analyzeMigrationRlsBackfills(wrongFile)).toHaveLength(1);
  });

  test("does not trust a custom capability without an exact owner-pinned policy", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("does not trust a capability policy that is not pinned to the table owner", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_repair ON widgets
USING (pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1');
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("does not trust owner-capability policy arms joined with OR", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_owner_repair ON widgets
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  OR pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  OR pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
);
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("does not trust a negated owner-capability policy arm", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_owner_repair ON widgets
FOR ALL
USING (NOT (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
))
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
);
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("does not trust a read-only owner capability for a write backfill", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_owner_read ON widgets
FOR SELECT
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
);
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("ignores a table that only ENABLEd RLS without FORCE", () => {
    const directory = fixture({
      "0001_base.sql": `CREATE TABLE "widgets" ("id" uuid);\nALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;`,
      "0002_backfill.sql": `UPDATE "widgets" SET "id" = "id";`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("a DO block that only defines a trigger function is not a migration-time write", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_define.sql": `
DO $session_visibility_cache_stripping$
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.strip_private_session_list_snapshots()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      UPDATE widgets SET id = id;
      RETURN NULL;
    END;
    $body$;
  $ddl$, current_schema());
END
$session_visibility_cache_stripping$;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("a DO block that executes DML still counts as a write", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
DO $backfill$
BEGIN
  UPDATE widgets SET id = id;
END
$backfill$;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });
});

describe("the shipped migration ledger", () => {
  const migrationsDir = join(import.meta.dir, "..", MIGRATIONS_DIR);

  test("has no unreviewed FORCE-RLS backfill", () => {
    const violations = unreviewedFindings(analyzeMigrationRlsBackfills(migrationsDir));
    expect(violations.map((violation) => `${violation.file}:${violation.statement}`)).toEqual([]);
  });

  test("carries no stale grandfathered entry", () => {
    expect(staleAllowlistEntries(migrationsDir)).toEqual([]);
  });

  test("still recognises the three statements 0296 repairs", () => {
    const findings = analyzeMigrationRlsBackfills(migrationsDir).filter(
      (finding) => finding.kind === "write",
    );
    const tablesFor = (file: string) =>
      findings.filter((finding) => finding.file === file).flatMap((finding) => finding.tables);
    expect(tablesFor("0256_connection_authority_delegation.sql")).toContain("connections");
    expect(tablesFor("0262_scoped_connected_machines_and_rigs.sql")).toContain("enrollments");
    expect(tablesFor("0263_organization_membership_lifecycle.sql")).toContain(
      "organization_memberships",
    );
  });

  test("the repair migration itself is protected, not grandfathered", () => {
    const repair = "0296_force_rls_backfill_noop_repair.sql";
    expect(GRANDFATHERED_MIGRATIONS).not.toContain(repair);
    expect(GRANDFATHERED_VACUOUS_GUARDS).not.toContain(repair);
    expect(
      analyzeMigrationRlsBackfills(migrationsDir).filter((finding) => finding.file === repair),
    ).toEqual([]);
  });
});
