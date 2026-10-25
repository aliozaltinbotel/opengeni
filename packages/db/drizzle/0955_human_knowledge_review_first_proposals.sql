-- deployment-mode: rolling
-- An authenticated HUMAN may only narrow an already-authorized Knowledge save to review first.
-- No permission, owner, scope, agent-policy, operation-replay or ordinary save behavior is widened.
DO $human_knowledge_proposals$
DECLARE
  target regprocedure:=format('%I.knowledge_entry_apply(uuid,uuid,jsonb,jsonb)',current_schema())::regprocedure;
  definition text;actor_anchor text;write_anchor text;before_metadata record;after_metadata record;
BEGIN
  SELECT p.proowner,p.proacl,p.prosecdef,p.proconfig,
    encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
    INTO STRICT before_metadata FROM pg_proc p WHERE p.oid=target;
  IF NOT before_metadata.prosecdef OR before_metadata.body_sha256<>'c77dcb40d9efc5c57fc6d2ffbe77b55bc73b82cfb54752921d5a113e90eaef45'
    THEN RAISE EXCEPTION 'knowledge_entry_apply HUMAN proposal predecessor drifted'; END IF;
  definition:=pg_get_functiondef(target);
  actor_anchor:=$actor$  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);$actor$;
  write_anchor:=$write$  IF e.id IS NULL THEN
    IF operation NOT IN ('save','promote_note')$write$;
  IF cardinality(string_to_array(definition,actor_anchor))<>2
    OR cardinality(string_to_array(definition,write_anchor))<>2
    THEN RAISE EXCEPTION 'knowledge_entry_apply HUMAN proposal anchor drifted'; END IF;
  definition:=replace(definition,actor_anchor,actor_anchor||$guard$
  IF p_request?'reviewMode' AND(operation IS DISTINCT FROM 'save'
    OR actor->>'kind' IS DISTINCT FROM 'human' OR p_request->>'reviewMode' IS DISTINCT FROM 'review_first') THEN
    RAISE EXCEPTION 'Only a human Knowledge save may require review' USING ERRCODE='22023';
  END IF;$guard$);
  -- The existing actor/current-scope/writeScopes checks above remain authoritative.
  -- The request field is part of the existing immutable operation fingerprint.
  definition:=replace(definition,write_anchor,$pending$  IF actor->>'kind'='human' AND p_request->>'reviewMode'='review_first' THEN
    mode:='review_first';
  END IF;
$pending$||write_anchor);
  EXECUTE definition;
  SELECT p.proowner,p.proacl,p.prosecdef,p.proconfig INTO STRICT after_metadata FROM pg_proc p WHERE p.oid=target;
  IF(after_metadata.proowner,after_metadata.proacl,after_metadata.prosecdef,after_metadata.proconfig)
    IS DISTINCT FROM(before_metadata.proowner,before_metadata.proacl,before_metadata.prosecdef,before_metadata.proconfig)
    THEN RAISE EXCEPTION 'knowledge_entry_apply HUMAN proposal metadata changed'; END IF;
END $human_knowledge_proposals$;
