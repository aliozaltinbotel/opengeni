-- deployment-mode: rolling
-- Migration 1025 already enforces admission states on every new write. Validate
-- historical rows separately, without retaining its expansion table lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_host_session_create_state_check;
