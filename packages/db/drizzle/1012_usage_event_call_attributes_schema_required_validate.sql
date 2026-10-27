-- deployment-mode: rolling
-- Validate the call check 1001 rewrote NOT VALID. VALIDATE CONSTRAINT takes
-- SHARE UPDATE EXCLUSIVE on usage_events, so reads and writes continue while
-- it scans (as 0928 and 1010). An already validated check is left unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60min';

ALTER TABLE usage_events VALIDATE CONSTRAINT usage_events_call_attributes_check;

DO $schema_required_postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'usage_events'::regclass AND c.conname = 'usage_events_call_attributes_check'
      AND c.convalidated
      AND pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK (((event_type <> ALL (ARRAY[''model.call''::text, ''embedding.call''::text])) OR ((attributes IS NOT NULL) AND COALESCE((jsonb_typeof((attributes -> ''schema''::text)) = ''string''::text), false))))'
  ) THEN
    RAISE EXCEPTION 'USAGE_EVENT_CALL_ATTRIBUTES_NOT_VALIDATED' USING ERRCODE = '55000';
  END IF;
END
$schema_required_postflight$;
