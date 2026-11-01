-- deployment-mode: rolling
-- No-host and predecessor writers retain ready admission; only the optional
-- host-created callback opts a new shell into the fail-closed pending state.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS host_session_create_state text NOT NULL DEFAULT 'ready';
-- Enforce new writes now; migration 1027 validates historical rows separately
-- so this expansion never holds its ALTER lock through a table scan.
ALTER TABLE sessions ADD CONSTRAINT sessions_host_session_create_state_check
  CHECK (host_session_create_state IN ('ready', 'pending', 'failed')) NOT VALID;

CREATE OR REPLACE FUNCTION opengeni_private.require_host_session_create_ready()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $host_create$
DECLARE admission text;
BEGIN
  SELECT s.host_session_create_state INTO admission FROM public.sessions s
    WHERE s.account_id = NEW.account_id AND s.workspace_id = NEW.workspace_id AND s.id = NEW.session_id
    FOR SHARE;
  IF admission IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'HOST_SESSION_CREATE_NOT_READY' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$host_create$;
CREATE OR REPLACE TRIGGER host_session_create_admission
  BEFORE INSERT ON session_turns FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.require_host_session_create_ready();

-- Realtime voice has a separate native admission record; it may not bypass
-- the same creation callback while a concurrent browser discovers the shell.
CREATE OR REPLACE TRIGGER host_session_create_admission
  BEFORE INSERT ON session_realtime_modes FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.require_host_session_create_ready();
