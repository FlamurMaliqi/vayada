-- Migration: 0123_production_pms_cutover_compatibility
-- Owner: migration-cutover; see VAY-1356

-- Legacy reservations can carry exact stay/occupancy evidence before a physical
-- room is assigned. Keep the normal exact-assignment invariant, but permit that
-- one shape only for rows with immutable migration-run evidence.
CREATE OR REPLACE FUNCTION pms.enforce_assignment_positions_contiguous()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stay_evidence_kind = 'exact' AND NEW.room_id IS NULL
    AND NOT (
      NEW.source = 'migration'
      AND NEW.assignment_payload #>> '{migrationRunId}' ~ '^vay1351-[0-9a-f]{24}$'
    )
    AND (TG_OP = 'INSERT' OR NEW.stay_evidence_kind IS DISTINCT FROM OLD.stay_evidence_kind)
  THEN
    RAISE EXCEPTION 'new exact assignments require a room' USING
      ERRCODE = 'check_violation', CONSTRAINT = 'chk_pms_exact_assignments_room';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.source = 'manual' AND NEW.stay_evidence_kind <> 'exact'
    AND (TG_OP = 'INSERT' OR (NEW.source, NEW.stay_evidence_kind)
      IS DISTINCT FROM (OLD.source, OLD.stay_evidence_kind)) THEN
    RAISE EXCEPTION 'new manual assignments require exact stay evidence' USING
      ERRCODE = 'check_violation', CONSTRAINT = 'chk_pms_manual_assignments_exact';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM pms.assert_assignment_positions_contiguous(OLD.guest_booking_id, OLD.property_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (
    TG_OP = 'INSERT'
    OR (NEW.guest_booking_id, NEW.property_id) IS DISTINCT FROM
       (OLD.guest_booking_id, OLD.property_id)
  ) THEN
    PERFORM pms.assert_assignment_positions_contiguous(NEW.guest_booking_id, NEW.property_id);
  END IF;
  RETURN NULL;
END;
$$;

-- VAY-1356 inventory rows keep the legacy envelope until normal calendar
-- materialization. Linked stop-sell still needs a causal revision so the
-- runtime reconciler can release it after the final linked cause disappears.
ALTER TABLE pms.inventory_days
  DROP CONSTRAINT chk_pms_inventory_days_linked_requires_canonical,
  ADD CONSTRAINT chk_pms_inventory_days_linked_requires_revision
    CHECK (
      NOT linked_stop_sell
      OR (
        linked_source_revision > 0
        AND (
          calendar_revision IS NOT NULL
          OR COALESCE(
            source_freshness ->> 'migrationRunId' ~ '^vay1351-[0-9a-f]{24}$'
              AND jsonb_typeof(source_freshness -> 'legacy') = 'object',
            FALSE
          )
        )
      )
    );

-- Provider property ownership must be globally unambiguous for webhook routing.
CREATE UNIQUE INDEX uq_pms_channel_connections_provider_external_property
  ON pms.channel_connections (provider, external_property_id)
  WHERE external_property_id IS NOT NULL;

COMMENT ON CONSTRAINT chk_pms_inventory_days_linked_requires_revision
  ON pms.inventory_days IS
  'Canonical and immutable VAY-1351 inventory may carry linked stop-sell only with a causal revision.';
