-- Migration: 0109_pms_linked_inventory_stop_sell
-- Owner: domain-pms; see VAY-1338 and engineering/linked-inventory-contract.md

ALTER TABLE pms.inventory_days
  DROP CONSTRAINT chk_pms_inventory_days_canonical_availability,
  ADD COLUMN linked_stop_sell BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN linked_source_revision INTEGER NOT NULL DEFAULT 0
    CHECK (linked_source_revision BETWEEN 0 AND 2147483647),
  ADD CONSTRAINT chk_pms_inventory_days_linked_requires_canonical
    CHECK (
      calendar_revision IS NOT NULL
      OR (NOT linked_stop_sell AND linked_source_revision = 0)
    ),
  ADD CONSTRAINT chk_pms_inventory_days_linked_availability
    CHECK (NOT linked_stop_sell OR available_count = 0),
  ADD CONSTRAINT chk_pms_inventory_days_canonical_availability
    CHECK (
      calendar_revision IS NULL
      OR effective_sellable_limit_count IS NULL
      OR (
        status IN ('open', 'closed')
        AND available_count = CASE
          WHEN status = 'closed' OR linked_stop_sell THEN 0
          ELSE GREATEST(
            0,
            effective_sellable_limit_count - assigned_count - blocked_count
          )
        END
      )
    );

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
    NEW.status, NEW.generated_source_revision
  ) IS DISTINCT FROM ROW(
    OLD.calendar_revision, OLD.total_count, OLD.generated_sellable_limit_count,
    OLD.status, OLD.generated_source_revision
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
    IF NEW.calendar_revision <= OLD.calendar_revision THEN
      RAISE EXCEPTION 'generated inventory update did not advance calendar'
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
