-- deployment-mode: rolling
-- Keep 1000 immutable; a missing schema member must refuse rather than yield
-- SQL NULL, which a CHECK accepts. Existing malformed rows fail validation.
--
-- Fork rule (2026-10-26 sync): first recorded as 0669, so a database that
-- recorded the old name runs this file again. Its exact post-image (the
-- COALESCE check) is accepted unchanged; 1000's definition is rewritten NOT
-- VALID and validated by 1012 in its own transaction, so no scan runs under
-- this file's ACCESS EXCLUSIVE lock; any other definition refuses.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $schema_required$
DECLARE definition text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO definition
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'usage_events'::regclass AND c.conname = 'usage_events_call_attributes_check';
  -- Post-image, validated or awaiting 1012's validation: nothing to change.
  IF definition = 'CHECK (((event_type <> ALL (ARRAY[''model.call''::text, ''embedding.call''::text])) OR ((attributes IS NOT NULL) AND COALESCE((jsonb_typeof((attributes -> ''schema''::text)) = ''string''::text), false))))' THEN
    RETURN;
  END IF;
  IF definition IS DISTINCT FROM 'CHECK (((event_type <> ALL (ARRAY[''model.call''::text, ''embedding.call''::text])) OR ((attributes IS NOT NULL) AND (jsonb_typeof((attributes -> ''schema''::text)) = ''string''::text))))' THEN
    RAISE EXCEPTION 'USAGE_EVENT_CALL_ATTRIBUTES_PREIMAGE_DRIFT' USING ERRCODE = '55000';
  END IF;
  ALTER TABLE usage_events
    DROP CONSTRAINT usage_events_call_attributes_check;
  ALTER TABLE usage_events
    ADD CONSTRAINT usage_events_call_attributes_check CHECK (
      event_type NOT IN ('model.call', 'embedding.call')
      OR (attributes IS NOT NULL AND coalesce(jsonb_typeof(attributes -> 'schema') = 'string', false))
    ) NOT VALID;
END
$schema_required$;
