-- deployment-mode: rolling
-- PQA-0197: append-only, exact-call source receipts; historical facts remain unattributed.
ALTER TABLE session_history_items ADD COLUMN source_basis jsonb;
CREATE TABLE model_call_source_receipts (
 id uuid PRIMARY KEY, account_id uuid NOT NULL, workspace_id uuid NOT NULL,
 session_id uuid NOT NULL, turn_id uuid NOT NULL, attempt_id uuid NOT NULL,
 execution_generation integer NOT NULL CHECK(execution_generation>0),
 source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 256),
 request_index integer NOT NULL CHECK(request_index>0),
 receipt jsonb NOT NULL, canonical text NOT NULL, digest text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,session_id,source_key),
 UNIQUE(id,account_id,workspace_id,session_id,turn_id,source_key),
 FOREIGN KEY(account_id,workspace_id,session_id,turn_id,attempt_id)
 REFERENCES session_turn_attempts(account_id,workspace_id,session_id,turn_id,id) ON DELETE CASCADE,
 CHECK(octet_length(canonical)<=16777216),
 CHECK(digest=encode(sha256(convert_to(canonical,'UTF8')),'hex')),
 CHECK(canonical::jsonb=receipt-'digest'),
 CHECK(receipt->>'digest'=digest AND receipt->>'id'=id::text
 AND receipt->>'accountId'=account_id::text AND receipt->>'workspaceId'=workspace_id::text
 AND receipt->>'sessionId'=session_id::text AND receipt->>'turnId'=turn_id::text
 AND receipt->>'attemptId'=attempt_id::text AND receipt->>'sourceKey'=source_key
 AND(receipt->>'executionGeneration')::integer=execution_generation
 AND(receipt->>'requestIndex')::integer=request_index)
);
ALTER TABLE model_call_source_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_call_source_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON model_call_source_receipts
 USING(opengeni_private.workspace_rls_visible(account_id,workspace_id))
 WITH CHECK(opengeni_private.workspace_rls_visible(account_id,workspace_id));
CREATE FUNCTION guard_model_call_source_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a session_turn_attempts%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'MODEL_CALL_SOURCE_RECEIPT_IMMUTABLE'; END IF;
 SELECT * INTO a FROM session_turn_attempts WHERE(account_id,workspace_id,session_id,turn_id,id)
 =(NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.turn_id,NEW.attempt_id) FOR SHARE;
 IF a.id IS NULL OR a.execution_generation<>NEW.execution_generation OR a.closed_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM sessions s JOIN session_turns t ON t.session_id=s.id AND t.workspace_id=s.workspace_id
 WHERE s.account_id=NEW.account_id AND s.workspace_id=NEW.workspace_id AND s.id=NEW.session_id AND s.active_turn_id=NEW.turn_id
 AND t.id=NEW.turn_id AND t.active_attempt_id=NEW.attempt_id AND t.execution_generation=NEW.execution_generation
 AND t.status IN ('running','requires_action') AND a.state IN ('claimed','running')
 AND s.authority_epoch=a.authority_epoch AND s.visibility=a.authority_visibility
 AND s.owner_organization_membership_id IS NOT DISTINCT FROM a.authority_owner_organization_membership_id)
 OR EXISTS(SELECT 1 FROM session_attempt_interruptions i WHERE i.workspace_id=NEW.workspace_id AND i.attempt_id=NEW.attempt_id AND i.state IN ('pending','delivered','acknowledged'))
 THEN RAISE EXCEPTION 'MODEL_CALL_SOURCE_RECEIPT_ATTEMPT_NOT_CURRENT';END IF;
 IF jsonb_typeof(NEW.receipt->'inputs')<>'array' OR jsonb_typeof(NEW.receipt->'complete')<>'boolean'
 OR ((NEW.receipt->>'complete')::boolean AND(jsonb_array_length(NEW.receipt->'inputs')=0
 OR jsonb_array_length(NEW.receipt->'incompleteReasons')<>0
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.receipt->'inputs') item WHERE item->'sourceRef'='null'::jsonb)))
 THEN RAISE EXCEPTION 'MODEL_CALL_SOURCE_RECEIPT_SHAPE_INVALID';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER model_call_source_receipt_guard BEFORE INSERT OR UPDATE ON model_call_source_receipts
 FOR EACH ROW EXECUTE FUNCTION guard_model_call_source_receipt();
ALTER TABLE model_call_facts ADD COLUMN source_receipt_id uuid;
ALTER TABLE model_call_facts ADD CONSTRAINT model_call_fact_source_receipt_fk
 FOREIGN KEY(source_receipt_id,account_id,workspace_id,session_id,turn_id,source_key)
 REFERENCES model_call_source_receipts(id,account_id,workspace_id,session_id,turn_id,source_key);
DO $grants$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
  GRANT SELECT,INSERT ON model_call_source_receipts TO opengeni_app;
 END IF;
END $grants$;

-- Preserve the installed copy owner's source row identity. This is an anchored successor,
-- not a rewrite of0429 or0502/0513. Destination source edges share the existing atomic fork.
DO $copy$ DECLARE definition text;anchor text;replacement text;candidate record;metadata jsonb;BEGIN
 FOR candidate IN SELECT oid FROM pg_proc WHERE proname='fork_session_content' AND pronamespace=current_schema()::regnamespace LOOP
 definition:=pg_get_functiondef(candidate.oid);
 IF position('opengeni_session_fork_history_spool' in definition)=0 THEN CONTINUE;END IF;
 SELECT to_jsonb(p)-'prosrc' INTO metadata FROM pg_proc p WHERE oid=candidate.oid;
 anchor:=E'position numeric NOT NULL,\n    item jsonb NOT NULL,';
 replacement:=E'position numeric NOT NULL,\n    source_id uuid NOT NULL,\n    item jsonb NOT NULL,';
 IF(length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'SOURCE_COPY_SPOOL_ANCHOR_DRIFT';END IF;
 definition:=replace(definition,anchor,replacement);
 anchor:=E'INSERT INTO pg_temp.opengeni_session_fork_history_spool (\n    position, item, item_ordered, item_codec_version, active,';
 replacement:=E'INSERT INTO pg_temp.opengeni_session_fork_history_spool (\n    position, source_id, item, item_ordered, item_codec_version, active,';
 IF(length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'SOURCE_COPY_READ_ANCHOR_DRIFT';END IF;
 definition:=replace(definition,anchor,replacement);
 anchor:='SELECT source_item.position, source_item.item,';
 IF(length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'SOURCE_COPY_ID_ANCHOR_DRIFT';END IF;
 definition:=replace(definition,anchor,'SELECT source_item.position, source_item.id, source_item.item,');
 anchor:=E'provider_artifact_invalidated_by_attempt_id, created_at\n  ) SELECT p_account_id';
 IF(length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'SOURCE_COPY_WRITE_ANCHOR_DRIFT';END IF;
 definition:=replace(definition,anchor,E'provider_artifact_invalidated_by_attempt_id, created_at, source_basis\n  ) SELECT p_account_id');
 anchor:=E'source_item.provider_artifact_invalidated_by_attempt_id, source_item.created_at\n    FROM pg_temp.opengeni_session_fork_history_spool';
 IF(length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'SOURCE_COPY_PARENT_ANCHOR_DRIFT';END IF;
 definition:=replace(definition,anchor,E'source_item.provider_artifact_invalidated_by_attempt_id, source_item.created_at, jsonb_build_object(''kind'',''COPIED'',''parents'',jsonb_build_array(jsonb_build_object(''owner'',''session_history_items'',''id'',source_item.source_id::text,''sha256'',encode(sha256(convert_to(source_item.item_ordered::text,''UTF8'')),''hex''))))\n    FROM pg_temp.opengeni_session_fork_history_spool');
 EXECUTE definition;
 IF metadata IS DISTINCT FROM (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=candidate.oid) THEN RAISE EXCEPTION 'SOURCE_COPY_METADATA_DRIFT';END IF;
 END LOOP;
END $copy$;
CREATE FUNCTION guard_history_source_basis_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.source_basis IS DISTINCT FROM NEW.source_basis THEN RAISE EXCEPTION 'HISTORY_SOURCE_BASIS_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER history_source_basis_immutable BEFORE UPDATE OF source_basis ON session_history_items FOR EACH ROW EXECUTE FUNCTION guard_history_source_basis_immutable();
REVOKE ALL ON FUNCTION guard_model_call_source_receipt(),guard_history_source_basis_immutable() FROM PUBLIC;

-- Trigger relation resolution is pinned to this installed data schema. Temporary
-- caller objects must not replace the attempt/session owners during admission.
DO $source_path$ BEGIN
 EXECUTE format('ALTER FUNCTION %I.guard_model_call_source_receipt() SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
 EXECUTE format('ALTER FUNCTION %I.guard_history_source_basis_immutable() SET search_path = pg_catalog, %I, pg_temp',current_schema(),current_schema());
END $source_path$;
