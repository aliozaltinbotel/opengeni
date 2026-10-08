-- deployment-mode: rolling
-- MAINT-P09-425: fair recurring temporary-image cleanup after late PUT completion.
-- Only selection order changes. Preserve the installed function, global reaper
-- authorization, claim eligibility, locking, bounded batch and result shape.
--
-- Cendra fork migration, first shipped as
-- 0552_recurring_temporary_image_cleanup_fairness.sql and renumbered after
-- upstream 0655 by the 2026-10-08 upstream sync (MAINT-P09-433): upstream
-- assigned 0552 to a different file. A database that recorded the old name
-- already holds the exact post-image; this file then verifies it and changes
-- nothing. Exactly one of the two exact images is accepted.
SET LOCAL lock_timeout = '5s';
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
  IF md5(before_source) = '59b622ef41598f5d016bb3b596edd672' AND
     length(before_source) - length(replace(before_source, $anchor$    ORDER BY U.expires_at, U.id$anchor$, '')) = 0 AND
     length(before_source) - length(replace(before_source, $replacement$    ORDER BY CASE WHEN U.status = 'cleanup_pending' THEN U.updated_at ELSE U.expires_at END, U.id$replacement$, '')) =
       length($replacement$    ORDER BY CASE WHEN U.status = 'cleanup_pending' THEN U.updated_at ELSE U.expires_at END, U.id$replacement$) THEN
    -- Recorded under the fork's former name: already the exact post-image.
    RETURN;
  END IF;
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
