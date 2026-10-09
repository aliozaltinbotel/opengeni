-- deployment-mode: rolling
-- Keep 0668 immutable; a missing schema member must refuse rather than yield
-- SQL NULL, which a CHECK accepts. Existing malformed rows fail validation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE usage_events
  DROP CONSTRAINT usage_events_call_attributes_check;

ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_call_attributes_check CHECK (
    event_type NOT IN ('model.call', 'embedding.call')
    OR (attributes IS NOT NULL AND coalesce(jsonb_typeof(attributes -> 'schema') = 'string', false))
  ) NOT VALID;

ALTER TABLE usage_events
  VALIDATE CONSTRAINT usage_events_call_attributes_check;
