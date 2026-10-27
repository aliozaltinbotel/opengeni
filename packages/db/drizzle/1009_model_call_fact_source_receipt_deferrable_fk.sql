-- deployment-mode: rolling
-- Cendra fork. model_call_facts.source_receipt_id (0998) references
-- model_call_source_receipts, and a workspace deletion removes both tables
-- (facts cascade from workspaces, receipts from session_turn_attempts). The
-- key was an immediate NO ACTION check, which upstream 0927 shows can refuse a
-- whole workspace deletion in the middle of its cascade, and which
-- defer_workspace_cascade_foreign_keys() does not defer. It becomes a
-- deferrable NO ACTION check like the keys 0927 converted: ordinary writes keep
-- their immediate check. Re-added NOT VALID here and validated by 1010.
-- A database installed with the deferrable key (0998 since 2026-10-26) is
-- accepted unchanged; any other definition refuses.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $receipt_fk$
DECLARE
  current_key record;
  expected text := 'FOREIGN KEY (source_receipt_id, account_id, workspace_id, session_id, turn_id, source_key) REFERENCES model_call_source_receipts(id, account_id, workspace_id, session_id, turn_id, source_key)';
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid) AS definition, c.condeferrable, c.condeferred,
    c.confdeltype, c.confupdtype
  INTO current_key
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'model_call_facts'::regclass AND c.conname = 'model_call_fact_source_receipt_fk'
    AND c.contype = 'f';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MODEL_CALL_FACT_SOURCE_RECEIPT_FK_MISSING' USING ERRCODE = '55000';
  END IF;
  IF current_key.confdeltype <> 'a' OR current_key.confupdtype <> 'a' OR current_key.condeferred THEN
    RAISE EXCEPTION 'MODEL_CALL_FACT_SOURCE_RECEIPT_FK_DRIFT' USING ERRCODE = '55000';
  END IF;
  IF current_key.condeferrable THEN
    IF current_key.definition IS DISTINCT FROM expected || ' DEFERRABLE'
      AND current_key.definition IS DISTINCT FROM expected || ' DEFERRABLE NOT VALID'
    THEN
      RAISE EXCEPTION 'MODEL_CALL_FACT_SOURCE_RECEIPT_FK_DRIFT' USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;
  IF current_key.definition IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'MODEL_CALL_FACT_SOURCE_RECEIPT_FK_DRIFT' USING ERRCODE = '55000';
  END IF;
  ALTER TABLE model_call_facts
    DROP CONSTRAINT model_call_fact_source_receipt_fk,
    ADD CONSTRAINT model_call_fact_source_receipt_fk
      FOREIGN KEY (source_receipt_id, account_id, workspace_id, session_id, turn_id, source_key)
      REFERENCES model_call_source_receipts(id, account_id, workspace_id, session_id, turn_id, source_key)
      DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
END
$receipt_fk$;
