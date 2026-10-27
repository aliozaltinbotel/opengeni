-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: kept byte-identical to the 0669 body already applied on every deployed database, where it only rewrote the check that 0668 had validated moments earlier in the same release
-- Keep 1000 immutable; a missing schema member must refuse rather than yield
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
