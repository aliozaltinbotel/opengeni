-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: every deployed database already holds this check from 0957 and skips it as this file's post-image, so the add only runs on a fresh install with no pending tool calls yet
-- Optional source provenance for new interruptions; historical rows remain unknown.
-- Fork rule (2026-10-26 sync): first recorded as 0957. Each object is created when absent,
-- accepted when it is exactly this migration's post-image, and refused otherwise.
ALTER TABLE session_pending_tool_calls ADD COLUMN IF NOT EXISTS model_output_sources jsonb;
DO $column_shape$
BEGIN
  IF (SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'session_pending_tool_calls'::regclass AND a.attname = 'model_output_sources' AND NOT a.attisdropped)
    IS DISTINCT FROM 'jsonb'
  THEN
    RAISE EXCEPTION 'PENDING_TOOL_MODEL_OUTPUT_SOURCES_COLUMN_DRIFT' USING ERRCODE = '55000';
  END IF;
END
$column_shape$;
--> statement-breakpoint
DO $constraint_shape$
DECLARE definition text; validated boolean;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid), c.convalidated INTO definition, validated
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'session_pending_tool_calls'::regclass
    AND c.conname = 'pending_tool_model_output_sources_array';
  IF definition IS NULL THEN
    ALTER TABLE session_pending_tool_calls ADD CONSTRAINT pending_tool_model_output_sources_array
      CHECK (model_output_sources IS NULL OR jsonb_typeof(model_output_sources) = 'array');
  ELSIF definition IS DISTINCT FROM
      'CHECK (((model_output_sources IS NULL) OR (jsonb_typeof(model_output_sources) = ''array''::text)))'
    OR NOT validated
  THEN
    RAISE EXCEPTION 'PENDING_TOOL_MODEL_OUTPUT_SOURCES_CHECK_DRIFT' USING ERRCODE = '55000';
  END IF;
END
$constraint_shape$;
--> statement-breakpoint
DO $function_preimage$
BEGIN
  IF pg_catalog.to_regprocedure('guard_pending_tool_model_output_sources()') IS NOT NULL
    AND (SELECT pg_catalog.md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('guard_pending_tool_model_output_sources()'))
      IS DISTINCT FROM 'f26bfeaca06acba97bd8b40d0ae76d2e'
  THEN
    RAISE EXCEPTION 'PENDING_TOOL_MODEL_OUTPUT_SOURCES_GUARD_DRIFT' USING ERRCODE = '55000';
  END IF;
END
$function_preimage$;
CREATE OR REPLACE FUNCTION guard_pending_tool_model_output_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.model_output_sources IS NOT NULL AND OLD.model_output_sources IS DISTINCT FROM NEW.model_output_sources THEN
    RAISE EXCEPTION 'OPEN_SUFFIX_SOURCE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION guard_pending_tool_model_output_sources() FROM PUBLIC;
--> statement-breakpoint
DO $trigger_shape$
DECLARE trigger_row record;
BEGIN
  SELECT t.tgfoid, t.tgtype, t.tgattr::text AS tgattr, t.tgenabled INTO trigger_row
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'session_pending_tool_calls'::regclass AND t.tgname = 'pending_tool_model_output_sources_immutable' AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER pending_tool_model_output_sources_immutable
      BEFORE UPDATE OF model_output_sources ON session_pending_tool_calls
      FOR EACH ROW EXECUTE FUNCTION guard_pending_tool_model_output_sources();
  ELSIF trigger_row.tgfoid IS DISTINCT FROM 'guard_pending_tool_model_output_sources()'::regprocedure::oid
    OR trigger_row.tgtype <> 19 OR trigger_row.tgenabled <> 'O'
    OR trigger_row.tgattr IS DISTINCT FROM (
      SELECT pg_catalog.string_agg(a.attnum::text, ' ' ORDER BY u.ordinal)
      FROM unnest(ARRAY['model_output_sources']::name[]) WITH ORDINALITY u(attname, ordinal)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = 'session_pending_tool_calls'::regclass AND a.attname = u.attname
    )
  THEN
    RAISE EXCEPTION 'PENDING_TOOL_MODEL_OUTPUT_SOURCES_TRIGGER_DRIFT' USING ERRCODE = '55000';
  END IF;
END
$trigger_shape$;
