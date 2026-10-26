-- deployment-mode: rolling
-- MAINT-P09-430: narrow installed dispatcher accounting operation. No new
-- table/ledger/grants, no content read, no timeout-derived settlement authority.
DO $receipt_owner$
DECLARE fn regprocedure:='knowledge_index_work(uuid,uuid,uuid,jsonb)'::regprocedure;
  src text;before_body text;before_facts jsonb;after_facts jsonb;anchor text;replacement text;
BEGIN
  SELECT pg_get_functiondef(fn),prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'definer',prosecdef,'config',proconfig,'language',prolang,'volatility',provolatile)
    INTO src,before_body,before_facts FROM pg_proc WHERE oid=fn;
  IF md5(before_body)<>'7c635c9dbd7c69dc91a522f873dcfbc6' THEN RAISE EXCEPTION 'KNOWLEDGE_INDEX_RECEIPT_OWNER_PREIMAGE_MOVED'; END IF;
  anchor:=$a$  SELECT * INTO job FROM knowledge_index_jobs j WHERE j.account_id=p_account AND j.revision_id=p_revision
    AND j.lease_id=p_lease AND j.state='running' AND j.lease_until>clock_timestamp() FOR UPDATE;$a$;
  replacement:=$r$  IF operation='receipt_owner' THEN
    DECLARE dispatch usage_events%ROWTYPE;
      previous text:=current_setting('opengeni.knowledge_index_dispatcher',true);can_settle boolean;completed boolean;
    BEGIN
      SELECT * INTO dispatch FROM usage_events u WHERE u.account_id=p_account
        AND u.event_type='knowledge.index.dispatched' AND u.source_resource_type='knowledge_revision'
        AND u.source_resource_id=p_revision::text AND u.attributes->>'leaseId'=p_lease::text
        AND u.attributes->>'callId'=p_request->>'callId'
        AND u.idempotency_key='usage:knowledge.index.dispatched:index:'||(p_request->>'callId');
      IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge index receipt owner unavailable' USING ERRCODE='42501'; END IF;
      SELECT EXISTS(SELECT 1 FROM usage_events u WHERE u.account_id=p_account AND u.workspace_id=dispatch.workspace_id
        AND u.event_type='embedding.call' AND u.source_resource_type='knowledge_revision' AND u.source_resource_id=p_revision::text
        AND u.idempotency_key=dispatch.attributes->>'completionKey' AND u.attributes->>'outcome'='completed') INTO completed;
      PERFORM set_config('opengeni.knowledge_index_dispatcher','1',true);
      SELECT EXISTS(SELECT 1 FROM knowledge_index_jobs j WHERE j.account_id=p_account AND j.revision_id=p_revision
        AND j.lease_id=p_lease AND j.state='running' AND j.generation::text=dispatch.attributes->>'generation'
        AND j.next_index::text=dispatch.attributes->>'nextIndex' FOR SHARE) INTO can_settle;
      PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
      -- Expiry is deliberately absent: a timed-out activity may still run.
      -- A known completed provider and lost exact settlement owner permit release.
      RETURN jsonb_build_object('pending',NOT completed OR can_settle);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);RAISE;
    END;
  END IF;
  SELECT * INTO job FROM knowledge_index_jobs j WHERE j.account_id=p_account AND j.revision_id=p_revision
    AND j.lease_id=p_lease AND j.state='running' AND j.lease_until>clock_timestamp() FOR UPDATE;$r$;
  IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'KNOWLEDGE_INDEX_RECEIPT_OWNER_ANCHOR_MOVED'; END IF;
  src:=replace(src,anchor,replacement);EXECUTE src;
  SELECT jsonb_build_object('owner',proowner,'acl',proacl,'definer',prosecdef,'config',proconfig,'language',prolang,'volatility',provolatile) INTO after_facts FROM pg_proc WHERE oid=fn;
  IF after_facts IS DISTINCT FROM before_facts THEN RAISE EXCEPTION 'KNOWLEDGE_INDEX_RECEIPT_OWNER_AUTHORITY_MOVED'; END IF;
END $receipt_owner$;
