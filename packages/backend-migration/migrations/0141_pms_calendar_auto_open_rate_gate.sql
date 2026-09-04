-- Migration: 0141_pms_calendar_auto_open_rate_gate
-- Owner: domain-pms / VAY-1436

ALTER TABLE pms.inventory_days
  ADD COLUMN generated_pricing_source_fingerprint TEXT,
  ADD COLUMN rate_gate_open BOOLEAN,
  ADD CONSTRAINT chk_pms_inventory_days_generated_pricing_fingerprint
    CHECK (
      generated_pricing_source_fingerprint IS NULL
      OR generated_pricing_source_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  DROP CONSTRAINT fk_pms_inventory_days_operating_calendar_room;

ALTER TABLE pms.operating_calendar_room_bindings
  ADD CONSTRAINT uq_pms_operating_calendar_room_capacity
    UNIQUE (property_id, calendar_revision, room_type_id, physical_capacity_count);

ALTER TABLE pms.inventory_days
  ADD CONSTRAINT fk_pms_inventory_days_operating_calendar_room
    FOREIGN KEY (property_id, calendar_revision, room_type_id, total_count)
    REFERENCES pms.operating_calendar_room_bindings(
      property_id, calendar_revision, room_type_id, physical_capacity_count
    );

ALTER TABLE pms.inventory_materialization_coverage
  ADD COLUMN generated_pricing_source_fingerprint TEXT,
  ADD CONSTRAINT chk_pms_inventory_coverage_generated_pricing_fingerprint
    CHECK (
      generated_pricing_source_fingerprint IS NULL
      OR generated_pricing_source_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  DROP CONSTRAINT chk_pms_inventory_coverage_horizon,
  ADD CONSTRAINT chk_pms_inventory_coverage_horizon
    CHECK (coverage_through >= coverage_from);

CREATE OR REPLACE FUNCTION pms.validate_inventory_coverage_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory materialization coverage cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.property_id, NEW.organization_id)
        IS DISTINCT FROM ROW(OLD.property_id, OLD.organization_id)
      OR NEW.calendar_revision < OLD.calendar_revision
      OR (
        OLD.generated_pricing_source_fingerprint IS NOT NULL
        AND NEW.generated_pricing_source_fingerprint IS NOT NULL
        AND NEW.coverage_through < OLD.coverage_through
      )
      OR ROW(
        NEW.calendar_revision,
        NEW.materialized_revision,
        NEW.coverage_from,
        NEW.coverage_through,
        NEW.room_type_count,
        NEW.expected_day_count,
        NEW.materialized_day_count,
        NEW.generated_pricing_source_fingerprint
      ) IS NOT DISTINCT FROM ROW(
        OLD.calendar_revision,
        OLD.materialized_revision,
        OLD.coverage_from,
        OLD.coverage_through,
        OLD.room_type_count,
        OLD.expected_day_count,
        OLD.materialized_day_count,
        OLD.generated_pricing_source_fingerprint
      )
      OR NEW.last_changed_materialization_idempotency_key_id
        IS NOT DISTINCT FROM OLD.last_changed_materialization_idempotency_key_id
      OR NEW.last_changed_materialization_domain_event_id
        IS NOT DISTINCT FROM OLD.last_changed_materialization_domain_event_id
      OR NEW.last_changed_materialization_outbox_event_id
        IS NOT DISTINCT FROM OLD.last_changed_materialization_outbox_event_id
      OR NEW.updated_at <= OLD.updated_at
    THEN
      RAISE EXCEPTION 'coverage update must represent one newly changed materialization'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_inventory_coverage_changed_transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION pms.validate_inventory_day_canonical_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  generated_changed BOOLEAN;
  channel_changed BOOLEAN;
  manual_changed BOOLEAN;
  block_changed BOOLEAN;
  booking_changed BOOLEAN;
  linked_changed BOOLEAN;
  owner_change_count INTEGER;
BEGIN
  IF OLD.calendar_revision IS NULL THEN
    IF NEW.calendar_revision IS NOT NULL
      AND NEW.source_freshness IS DISTINCT FROM OLD.source_freshness
    THEN
      RAISE EXCEPTION 'canonical inventory adoption must freeze legacy source freshness'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_inventory_days_source_freshness_frozen';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.calendar_revision IS NULL THEN
    RAISE EXCEPTION 'canonical inventory envelope cannot be removed'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_inventory_days_canonical_transition';
  END IF;

  IF ROW(NEW.property_id, NEW.room_type_id, NEW.stay_date, NEW.source_freshness)
      IS DISTINCT FROM
     ROW(OLD.property_id, OLD.room_type_id, OLD.stay_date, OLD.source_freshness)
  THEN
    RAISE EXCEPTION 'canonical inventory identity and source freshness are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_inventory_days_source_freshness_frozen';
  END IF;

  generated_changed := ROW(
    NEW.calendar_revision, NEW.total_count, NEW.generated_sellable_limit_count,
    NEW.status, NEW.generated_source_revision, NEW.generated_pricing_source_fingerprint,
    NEW.rate_gate_open
  ) IS DISTINCT FROM ROW(
    OLD.calendar_revision, OLD.total_count, OLD.generated_sellable_limit_count,
    OLD.status, OLD.generated_source_revision, OLD.generated_pricing_source_fingerprint,
    OLD.rate_gate_open
  );
  channel_changed := ROW(NEW.channel_sellable_limit_count, NEW.channel_source_revision)
    IS DISTINCT FROM ROW(OLD.channel_sellable_limit_count, OLD.channel_source_revision);
  manual_changed := ROW(NEW.manual_sellable_limit_count, NEW.manual_source_revision)
    IS DISTINCT FROM ROW(OLD.manual_sellable_limit_count, OLD.manual_source_revision);
  block_changed := ROW(NEW.blocked_count, NEW.block_source_revision)
    IS DISTINCT FROM ROW(OLD.blocked_count, OLD.block_source_revision);
  booking_changed := ROW(NEW.assigned_count, NEW.booking_source_revision)
    IS DISTINCT FROM ROW(OLD.assigned_count, OLD.booking_source_revision);
  linked_changed := ROW(NEW.linked_stop_sell, NEW.linked_source_revision)
    IS DISTINCT FROM ROW(OLD.linked_stop_sell, OLD.linked_source_revision);
  owner_change_count := generated_changed::INTEGER
    + channel_changed::INTEGER
    + manual_changed::INTEGER
    + booking_changed::INTEGER
    + CASE WHEN linked_changed THEN 1 ELSE block_changed::INTEGER END;

  IF owner_change_count <> 1
    OR OLD.inventory_revision = 2147483647
    OR NEW.inventory_revision <> OLD.inventory_revision + 1
  THEN
    RAISE EXCEPTION 'canonical inventory update must advance exactly one owner and inventory revision'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_inventory_days_owner_revision_transition';
  END IF;

  IF generated_changed THEN
    IF NEW.calendar_revision < OLD.calendar_revision
      OR (
        NEW.calendar_revision = OLD.calendar_revision
        AND (
          NEW.total_count IS DISTINCT FROM OLD.total_count
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.generated_source_revision IS DISTINCT FROM OLD.generated_source_revision
          OR NEW.generated_pricing_source_fingerprint IS NOT DISTINCT FROM OLD.generated_pricing_source_fingerprint
        )
      )
    THEN
      RAISE EXCEPTION 'generated inventory update did not advance its calendar or pricing source'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_inventory_days_generated_transition';
    END IF;
  ELSIF channel_changed THEN
    IF NEW.channel_sellable_limit_count IS NOT DISTINCT FROM OLD.channel_sellable_limit_count
      OR OLD.channel_source_revision = 2147483647
      OR NEW.channel_source_revision <> OLD.channel_source_revision + 1
    THEN
      RAISE EXCEPTION 'channel inventory update did not advance value and revision'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_inventory_days_channel_transition';
    END IF;
  ELSIF manual_changed THEN
    IF NEW.manual_sellable_limit_count IS NOT DISTINCT FROM OLD.manual_sellable_limit_count
      OR OLD.manual_source_revision = 2147483647
      OR NEW.manual_source_revision <> OLD.manual_source_revision + 1
    THEN
      RAISE EXCEPTION 'manual inventory update did not advance value and revision'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_inventory_days_manual_transition';
    END IF;
  ELSIF linked_changed THEN
    IF OLD.linked_source_revision = 2147483647
      OR NEW.linked_source_revision <> OLD.linked_source_revision + 1
      OR (
        NEW.blocked_count IS DISTINCT FROM OLD.blocked_count
        AND (
          OLD.block_source_revision = 2147483647
          OR NEW.block_source_revision <> OLD.block_source_revision + 1
        )
      )
      OR (
        NEW.blocked_count IS NOT DISTINCT FROM OLD.blocked_count
        AND NEW.block_source_revision IS DISTINCT FROM OLD.block_source_revision
      )
    THEN
      RAISE EXCEPTION 'linked inventory update did not advance linked state and revisions'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_inventory_days_linked_transition';
    END IF;
  ELSIF block_changed THEN
    IF NEW.blocked_count = OLD.blocked_count
      OR OLD.block_source_revision = 2147483647
      OR NEW.block_source_revision <> OLD.block_source_revision + 1
    THEN
      RAISE EXCEPTION 'block inventory update did not advance value and revision'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_inventory_days_block_transition';
    END IF;
  ELSIF booking_changed THEN
    IF NEW.assigned_count = OLD.assigned_count
      OR OLD.booking_source_revision = 2147483647
      OR NEW.booking_source_revision <> OLD.booking_source_revision + 1
    THEN
      RAISE EXCEPTION 'booking inventory update did not advance value and revision'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_inventory_days_booking_transition';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
