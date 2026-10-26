-- deployment-mode: rolling
-- Optional source provenance for new interruptions; historical rows remain unknown.
ALTER TABLE session_pending_tool_calls ADD COLUMN model_output_sources jsonb;
--> statement-breakpoint
ALTER TABLE session_pending_tool_calls ADD CONSTRAINT pending_tool_model_output_sources_array
  CHECK (model_output_sources IS NULL OR jsonb_typeof(model_output_sources) = 'array');
--> statement-breakpoint
CREATE FUNCTION guard_pending_tool_model_output_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.model_output_sources IS NOT NULL AND OLD.model_output_sources IS DISTINCT FROM NEW.model_output_sources THEN
    RAISE EXCEPTION 'OPEN_SUFFIX_SOURCE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION guard_pending_tool_model_output_sources() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER pending_tool_model_output_sources_immutable
  BEFORE UPDATE OF model_output_sources ON session_pending_tool_calls
  FOR EACH ROW EXECUTE FUNCTION guard_pending_tool_model_output_sources();
