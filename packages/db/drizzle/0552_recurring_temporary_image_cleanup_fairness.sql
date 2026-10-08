-- MAINT-P09-425: fair recurring temporary-image cleanup after late PUT completion.
-- Only selection order changes. Preserve the installed function, global reaper
-- authorization, claim eligibility, locking, bounded batch and result shape.
DO $fair_cleanup$
DECLARE
  function_id oid := 'opengeni_private.claim_expired_file_upload_cleanup(bigint,bigint,integer)'::regprocedure;
  before_metadata jsonb;
  before_source text;
  definition text;
  after_metadata jsonb;
BEGIN
  SELECT to_jsonb(p) - 'prosrc', p.prosrc, pg_get_functiondef(p.oid)
    INTO before_metadata, before_source, definition
    FROM pg_proc AS p WHERE p.oid = function_id;
  IF md5(before_source) <> 'f9c5c9a6b0fdf5885eee7cb94828769f' OR
     length(before_source) - length(replace(before_source, $anchor$    ORDER BY U.expires_at, U.id$anchor$, '')) <> length($anchor$    ORDER BY U.expires_at, U.id$anchor$) THEN
    RAISE EXCEPTION 'TEMPORARY_IMAGE_CLEANUP_PREIMAGE_DRIFT';
  END IF;
  EXECUTE replace(definition, $anchor$    ORDER BY U.expires_at, U.id$anchor$, $replacement$    ORDER BY CASE WHEN U.status = 'cleanup_pending' THEN U.updated_at ELSE U.expires_at END, U.id$replacement$);
  SELECT to_jsonb(p) - 'prosrc' INTO after_metadata FROM pg_proc AS p WHERE p.oid = function_id;
  IF after_metadata IS DISTINCT FROM before_metadata OR
     (SELECT p.prosrc FROM pg_proc AS p WHERE p.oid = function_id) IS DISTINCT FROM
       replace(before_source, $anchor$    ORDER BY U.expires_at, U.id$anchor$, $replacement$    ORDER BY CASE WHEN U.status = 'cleanup_pending' THEN U.updated_at ELSE U.expires_at END, U.id$replacement$) THEN
    RAISE EXCEPTION 'TEMPORARY_IMAGE_CLEANUP_POSTIMAGE_DRIFT';
  END IF;
END;
$fair_cleanup$;
