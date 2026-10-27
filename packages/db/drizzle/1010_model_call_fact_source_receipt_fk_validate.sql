-- deployment-mode: rolling
-- Validate the key 1009 re-added NOT VALID. Every existing row already
-- satisfied the same reference under the previous constraint, so validation
-- only proves it again; VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on
-- model_call_facts and ROW SHARE on model_call_source_receipts (as 0928).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60min';

ALTER TABLE model_call_facts VALIDATE CONSTRAINT model_call_fact_source_receipt_fk;

DO $receipt_fk_postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'model_call_facts'::regclass AND c.conname = 'model_call_fact_source_receipt_fk'
      AND c.contype = 'f' AND c.condeferrable AND NOT c.condeferred AND c.convalidated
      AND c.confdeltype = 'a'
  ) THEN
    RAISE EXCEPTION 'MODEL_CALL_FACT_SOURCE_RECEIPT_FK_NOT_DEFERRABLE' USING ERRCODE = '55000';
  END IF;
END
$receipt_fk_postflight$;
