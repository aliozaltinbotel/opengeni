-- deployment-mode: rolling
-- The legacy external-member PATCH contract accepts an empty permission set.
-- Route that narrowing through the keyed lifecycle so its authorization
-- revision and receipt advance atomically. Empty grants remain forbidden;
-- preserve the running function's authority checks, locks, owner and ACLs.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $migration$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(
    'prepare_external_workspace_membership_operation(jsonb)'::regprocedure
  );
  anchor text := $anchor$OR jsonb_array_length(p_command -> 'permissions') = 0$anchor$;
  replacement text := $replacement$OR (action_value = 'grant' AND jsonb_array_length(p_command -> 'permissions') = 0)$replacement$;
BEGIN
  IF definition IS NULL OR
    (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1
  THEN
    RAISE EXCEPTION 'external workspace permission-update source contract changed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$migration$;
