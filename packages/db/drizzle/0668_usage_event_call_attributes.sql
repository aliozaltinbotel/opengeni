-- deployment-mode: rolling
-- Per-call AI usage facts on usage_events (Cendra fork, MAINT-P09-430).
--
-- usage_events.attributes carries the bounded per-call facts of a `model.call`
-- or `embedding.call` row: provider, provider API, model, the token pools the
-- provider reported (null when it did not), the estimated provider cost (null
-- when OpenGeni cannot price the call, never 0), its pricing source and price
-- schedule identity, the billing path and the call outcome. Every other usage
-- type keeps a NULL column, and every row written before this migration stays
-- NULL. A row's attributes are written once with the row and never change: an
-- idempotent replay must present the same object (the writer compares it).
--
-- The host usage export copies the column into its immutable outbox payload,
-- so an embedding host receives exactly the durable row's facts. The enqueue
-- function below is 0533's definition with one change: the payload names
-- `attributes`. Export rows enqueued before this migration carry no such key,
-- and the published claim functions and their signatures are unchanged.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS attributes jsonb;

-- The same byte bound the export applies to initiator context.
ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_attributes_shape_check CHECK (
    attributes IS NULL
    OR (jsonb_typeof(attributes) = 'object' AND octet_length(attributes::text) <= 4096)
  ) NOT VALID;

ALTER TABLE usage_events
  VALIDATE CONSTRAINT usage_events_attributes_shape_check;

-- A per-call row is meaningless without its facts; every other type may omit them.
ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_call_attributes_check CHECK (
    event_type NOT IN ('model.call', 'embedding.call')
    OR (attributes IS NOT NULL AND jsonb_typeof(attributes -> 'schema') = 'string')
  ) NOT VALID;

ALTER TABLE usage_events
  VALIDATE CONSTRAINT usage_events_call_attributes_check;

CREATE FUNCTION opengeni_private.reject_usage_event_attributes_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.attributes IS DISTINCT FROM OLD.attributes THEN
    RAISE EXCEPTION 'usage event attributes are immutable after insert'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.reject_usage_event_attributes_mutation() FROM PUBLIC;

CREATE TRIGGER usage_events_attributes_immutable
BEFORE UPDATE OF attributes ON usage_events
FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_usage_event_attributes_mutation();

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.enqueue_host_usage_event_export()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_enabled boolean;
      v_initiator jsonb := CASE
        WHEN NEW.initiator_kind IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
          'kind', NEW.initiator_kind,
          'subjectId', NEW.initiator_subject_id,
          'label', CASE
            WHEN jsonb_typeof(NEW.initiator_context -> 'label') = 'string'
            THEN left(NEW.initiator_context ->> 'label', 256)
            ELSE NULL
          END
        ))
        ELSE NULL
      END;
      v_context jsonb := jsonb_strip_nulls(jsonb_build_object(
        'label', CASE
          WHEN jsonb_typeof(NEW.initiator_context -> 'label') = 'string'
          THEN left(NEW.initiator_context ->> 'label', 256)
          ELSE NULL
        END,
        'backfill', CASE
          WHEN jsonb_typeof(NEW.initiator_context -> 'backfill') = 'boolean'
          THEN NEW.initiator_context -> 'backfill'
          ELSE NULL
        END
      ));
      v_origin text := NEW.origin;
      v_surface text;
      v_model_provider text;
      v_payload jsonb;
      v_payload_bytes integer;
    BEGIN
      SELECT c.usage_events_enabled INTO v_enabled
      FROM %1$I.host_export_config c WHERE c.id = 1
      FOR SHARE;
      IF coalesce(v_enabled, false) = false THEN
        RETURN NEW;
      END IF;

      -- Export-specific bounds apply only while the optional host stream is
      -- enabled. Standalone/custom usage writers retain their historical
      -- behavior; an embedded writer that cannot be represented fails its
      -- source transaction visibly instead of committing a poison outbox row.
      IF octet_length(NEW.event_type) NOT BETWEEN 1 AND 256
        OR octet_length(NEW.unit) NOT BETWEEN 1 AND 128
        OR (NEW.subject_id IS NOT NULL AND octet_length(NEW.subject_id) > 1024)
        OR (NEW.source_resource_type IS NOT NULL
          AND octet_length(NEW.source_resource_type) > 256)
        OR (NEW.source_resource_id IS NOT NULL
          AND octet_length(NEW.source_resource_id) > 2048)
        OR octet_length(NEW.idempotency_key) NOT BETWEEN 1 AND 2048
        OR (NEW.billing_provider_event_id IS NOT NULL
          AND octet_length(NEW.billing_provider_event_id) > 2048) THEN
        RAISE EXCEPTION 'usage event exceeds the enabled host-export wire bounds'
          USING ERRCODE = '22001';
      END IF;

      IF NEW.turn_id IS NOT NULL THEN
        SELECT
          CASE WHEN octet_length(t.initiator_subject_id) <= 1024 THEN
            jsonb_strip_nulls(jsonb_build_object(
              'kind', t.initiator_kind,
              'subjectId', t.initiator_subject_id,
              'label', CASE
                WHEN jsonb_typeof(t.initiator_context -> 'label') = 'string'
                THEN left(t.initiator_context ->> 'label', 256)
                ELSE NULL
              END
            ))
          ELSE NULL END,
          jsonb_strip_nulls(jsonb_build_object(
            'label', CASE
              WHEN jsonb_typeof(t.initiator_context -> 'label') = 'string'
              THEN left(t.initiator_context ->> 'label', 256)
              ELSE NULL
            END,
            'backfill', CASE
              WHEN jsonb_typeof(t.initiator_context -> 'backfill') = 'boolean'
              THEN t.initiator_context -> 'backfill'
              ELSE NULL
            END,
            'attributionOmitted', CASE
              WHEN octet_length(t.initiator_subject_id) > 1024 THEN 'subject_id_too_large'
              ELSE NULL
            END
          )),
          t.source,
          t.surface,
          opengeni_private.analytics_model_provider(
            CASE
              WHEN jsonb_typeof(t.metadata #> '{turnExecutionPolicyV1,providerId}') = 'string'
              THEN t.metadata #>> '{turnExecutionPolicyV1,providerId}'
              ELSE NULL
            END
          )
        INTO v_initiator, v_context, v_origin, v_surface, v_model_provider
        FROM %1$I.session_turns t
        WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.turn_id;
      ELSIF v_initiator IS NULL AND NEW.subject_id IS NOT NULL
        AND octet_length(NEW.subject_id) <= 1024 THEN
        v_initiator := jsonb_build_object('kind', 'subject', 'subjectId', NEW.subject_id);
      END IF;
      IF v_surface IS NOT NULL AND v_surface NOT IN (
        'web', 'slack', 'api_key', 'embedded', 'scheduled', 'agent',
        'voice', 'site', 'automation', 'mcp', 'system'
      ) THEN
        v_surface := NULL;
      END IF;

      v_payload := jsonb_build_object(
        'id', NEW.id,
        'workspaceId', NEW.workspace_id,
        'accountId', NEW.account_id,
        'subjectId', NEW.subject_id,
        'eventType', NEW.event_type,
        'quantity', NEW.quantity,
        'unit', NEW.unit,
        'sourceResourceType', NEW.source_resource_type,
        'sourceResourceId', NEW.source_resource_id,
        'idempotencyKey', NEW.idempotency_key,
        'occurredAt', NEW.occurred_at,
        'recordedAt', NEW.recorded_at,
        'exportedToBillingAt', NEW.exported_to_billing_at,
        'billingProviderEventId', NEW.billing_provider_event_id,
        'attributes', NEW.attributes
      );
      v_payload_bytes := octet_length(v_payload::text)
        + octet_length(coalesce(v_initiator, 'null'::jsonb)::text)
        + octet_length(v_context::text)
        + coalesce(octet_length(v_surface), 0)
        + coalesce(octet_length(v_model_provider), 0)
        + 768;
      INSERT INTO %1$I.host_export_outbox (
        export_kind, source_id, account_id, workspace_id, session_id,
        turn_id, turn_attempt_id, event_type, idempotency_key, initiator,
        initiator_context, origin, surface, model_provider, payload,
        envelope_bytes, occurred_at, source_recorded_at, enqueued_at
      ) VALUES (
        'usage_event', NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id,
        NEW.turn_id, NEW.turn_attempt_id, NEW.event_type, NEW.idempotency_key,
        v_initiator, coalesce(v_context, '{}'::jsonb), v_origin,
        v_surface, v_model_provider, v_payload,
        greatest(1, v_payload_bytes), NEW.occurred_at,
        NEW.recorded_at, clock_timestamp()
      )
      ON CONFLICT (export_kind, source_id) DO NOTHING;
      RETURN NEW;
    END $function$;
  $create$, target_schema);
END
$migration$;

REVOKE ALL ON FUNCTION
  opengeni_private.enqueue_host_usage_event_export() FROM PUBLIC;
