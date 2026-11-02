-- deployment-mode: rolling
-- The legacy external-member PATCH contract accepts an empty permission set.
-- Route that narrowing through the keyed lifecycle so its authorization
-- revision and receipt advance atomically. Empty grants remain forbidden;
-- preserve the running function's authority checks, locks, owner and ACLs.
--
-- Cendra fork migration, first shipped as
-- 0550_external_workspace_member_empty_permission_updates.sql and renumbered
-- after upstream 0664 by the 2026-10-08 upstream sync (MAINT-P09-433): upstream
-- assigned 0550 to a different file. A database that recorded the old name
-- already holds the post-image; this file then verifies it and changes nothing.
-- Exactly one of the two exact images is accepted; anything else is refused.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $migration$
DECLARE
  function_id oid := 'prepare_external_workspace_membership_operation(jsonb)'::regprocedure;
  anchor text := $anchor$OR jsonb_array_length(p_command -> 'permissions') = 0$anchor$;
  replacement text := $replacement$OR (action_value = 'grant' AND jsonb_array_length(p_command -> 'permissions') = 0)$replacement$;
  before_metadata jsonb;
  before_source text;
  definition text;
  anchors integer;
  replacements integer;
BEGIN
  SELECT to_jsonb(p) - 'prosrc', p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    INTO before_metadata, before_source, definition
    FROM pg_catalog.pg_proc AS p WHERE p.oid = function_id;
  IF definition IS NULL THEN
    RAISE EXCEPTION 'external workspace permission-update source contract changed'
      USING ERRCODE = '55000';
  END IF;
  anchors := (length(before_source) - length(replace(before_source, anchor, ''))) / length(anchor);
  replacements :=
    (length(before_source) - length(replace(before_source, replacement, ''))) / length(replacement);
  IF md5(before_source) = 'b7505fb52a7fae3ad4525d647aeee5f6' AND anchors = 0 AND replacements = 1 THEN
    -- Recorded under the fork's former name: already the exact post-image.
    RETURN;
  END IF;
  IF md5(before_source) <> '0b629b034147b2cc1ad7ae3df7c3e344' OR anchors <> 1 OR replacements <> 0 OR
    (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1
  THEN
    RAISE EXCEPTION 'external workspace permission-update source contract changed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
  IF (SELECT to_jsonb(p) - 'prosrc' FROM pg_catalog.pg_proc AS p WHERE p.oid = function_id)
       IS DISTINCT FROM before_metadata OR
     (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc AS p WHERE p.oid = function_id)
       IS DISTINCT FROM 'b7505fb52a7fae3ad4525d647aeee5f6'
  THEN
    RAISE EXCEPTION 'external workspace permission-update postimage drift'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;
