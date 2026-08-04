-- Migration: 0057_pms_inventory_readiness_reservations
-- Owner: domain-pms
-- See: VAY-1063, engineering/hotel-onboarding-information-inventory.md (ONB-20)
--
-- Existing inventory rows remain valid for legacy writers. The nullable
-- canonical envelope fails readiness closed until every required field exists.
-- Reservation receipts are PMS-owned opaque capabilities and are deliberately
-- distinct from the legacy pms.inventory-reservation.v1 Booking marker.

ALTER TABLE pms.operating_calendar_revisions
  ADD CONSTRAINT uq_pms_operating_calendar_organization_revision
  UNIQUE (organization_id, property_id, calendar_revision);

ALTER TABLE pms.operating_calendar_room_bindings
  ADD CONSTRAINT uq_pms_operating_calendar_room_capacity_limit
  UNIQUE (
    property_id,
    calendar_revision,
    room_type_id,
    physical_capacity_count,
    starting_sellable_limit_count
  );

ALTER TABLE pms.inventory_days
  ADD COLUMN calendar_revision               INTEGER,
  ADD COLUMN inventory_revision              INTEGER,
  ADD COLUMN generated_sellable_limit_count  INTEGER,
  ADD COLUMN channel_sellable_limit_count    INTEGER,
  ADD COLUMN manual_sellable_limit_count     INTEGER,
  ADD COLUMN effective_sellable_limit_count  INTEGER,
  ADD COLUMN generated_source_revision       INTEGER,
  ADD COLUMN channel_source_revision         INTEGER,
  ADD COLUMN manual_source_revision          INTEGER,
  ADD COLUMN block_source_revision           INTEGER,
  ADD COLUMN booking_source_revision         INTEGER,
  ADD CONSTRAINT chk_pms_inventory_days_canonical_envelope
    CHECK (
      (
        calendar_revision IS NULL
        AND inventory_revision IS NULL
        AND generated_sellable_limit_count IS NULL
        AND channel_sellable_limit_count IS NULL
        AND manual_sellable_limit_count IS NULL
        AND effective_sellable_limit_count IS NULL
        AND generated_source_revision IS NULL
        AND channel_source_revision IS NULL
        AND manual_source_revision IS NULL
        AND block_source_revision IS NULL
        AND booking_source_revision IS NULL
      )
      OR
      (
        calendar_revision IS NOT NULL
        AND inventory_revision IS NOT NULL
        AND generated_sellable_limit_count IS NOT NULL
        AND effective_sellable_limit_count IS NOT NULL
        AND generated_source_revision IS NOT NULL
        AND channel_source_revision IS NOT NULL
        AND manual_source_revision IS NOT NULL
        AND block_source_revision IS NOT NULL
        AND booking_source_revision IS NOT NULL
      )
    ),
  ADD CONSTRAINT chk_pms_inventory_days_canonical_revisions
    CHECK (
      calendar_revision IS NULL
      OR inventory_revision IS NULL
      OR generated_source_revision IS NULL
      OR channel_source_revision IS NULL
      OR manual_source_revision IS NULL
      OR block_source_revision IS NULL
      OR booking_source_revision IS NULL
      OR (
        calendar_revision BETWEEN 1 AND 2147483647
        AND inventory_revision BETWEEN 1 AND 2147483647
        AND generated_source_revision = calendar_revision
        AND channel_source_revision BETWEEN 0 AND 2147483647
        AND manual_source_revision BETWEEN 0 AND 2147483647
        AND block_source_revision BETWEEN 0 AND 2147483647
        AND booking_source_revision BETWEEN 0 AND 2147483647
      )
    ),
  ADD CONSTRAINT chk_pms_inventory_days_canonical_limits
    CHECK (
      calendar_revision IS NULL
      OR generated_sellable_limit_count IS NULL
      OR effective_sellable_limit_count IS NULL
      OR (
        generated_sellable_limit_count BETWEEN 0 AND total_count
        AND (
          channel_sellable_limit_count IS NULL
          OR channel_sellable_limit_count BETWEEN 0 AND total_count
        )
        AND (
          manual_sellable_limit_count IS NULL
          OR manual_sellable_limit_count BETWEEN 0 AND total_count
        )
        AND effective_sellable_limit_count = COALESCE(
          manual_sellable_limit_count,
          channel_sellable_limit_count,
          generated_sellable_limit_count
        )
        AND assigned_count + blocked_count <= total_count
      )
    ),
  ADD CONSTRAINT chk_pms_inventory_days_canonical_availability
    CHECK (
      calendar_revision IS NULL
      OR effective_sellable_limit_count IS NULL
      OR (
        status IN ('open', 'closed')
        AND available_count = CASE
          WHEN status = 'closed' THEN 0
          ELSE GREATEST(
            0,
            effective_sellable_limit_count - assigned_count - blocked_count
          )
        END
      )
    ),
  ADD CONSTRAINT fk_pms_inventory_days_operating_calendar_room
    FOREIGN KEY (
      property_id,
      calendar_revision,
      room_type_id,
      total_count,
      generated_sellable_limit_count
    )
    REFERENCES pms.operating_calendar_room_bindings(
      property_id,
      calendar_revision,
      room_type_id,
      physical_capacity_count,
      starting_sellable_limit_count
    );

CREATE FUNCTION pms.validate_inventory_day_canonical_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  generated_changed BOOLEAN;
  channel_changed BOOLEAN;
  manual_changed BOOLEAN;
  block_changed BOOLEAN;
  booking_changed BOOLEAN;
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
    NEW.calendar_revision,
    NEW.total_count,
    NEW.generated_sellable_limit_count,
    NEW.status,
    NEW.generated_source_revision
  ) IS DISTINCT FROM ROW(
    OLD.calendar_revision,
    OLD.total_count,
    OLD.generated_sellable_limit_count,
    OLD.status,
    OLD.generated_source_revision
  );
  channel_changed := ROW(
    NEW.channel_sellable_limit_count,
    NEW.channel_source_revision
  ) IS DISTINCT FROM ROW(
    OLD.channel_sellable_limit_count,
    OLD.channel_source_revision
  );
  manual_changed := ROW(
    NEW.manual_sellable_limit_count,
    NEW.manual_source_revision
  ) IS DISTINCT FROM ROW(
    OLD.manual_sellable_limit_count,
    OLD.manual_source_revision
  );
  block_changed := ROW(NEW.blocked_count, NEW.block_source_revision)
    IS DISTINCT FROM ROW(OLD.blocked_count, OLD.block_source_revision);
  booking_changed := ROW(NEW.assigned_count, NEW.booking_source_revision)
    IS DISTINCT FROM ROW(OLD.assigned_count, OLD.booking_source_revision);
  owner_change_count := generated_changed::INTEGER
    + channel_changed::INTEGER
    + manual_changed::INTEGER
    + block_changed::INTEGER
    + booking_changed::INTEGER;

  IF owner_change_count <> 1
    OR OLD.inventory_revision = 2147483647
    OR NEW.inventory_revision <> OLD.inventory_revision + 1
  THEN
    RAISE EXCEPTION 'canonical inventory update must advance exactly one owner and inventory revision'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_inventory_days_owner_revision_transition';
  END IF;

  IF generated_changed THEN
    IF NEW.calendar_revision <= OLD.calendar_revision
    THEN
      RAISE EXCEPTION 'generated inventory update did not advance calendar'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_inventory_days_generated_transition';
    END IF;
  ELSIF channel_changed THEN
    IF NEW.channel_sellable_limit_count IS NOT DISTINCT FROM OLD.channel_sellable_limit_count
      OR OLD.channel_source_revision = 2147483647
      OR NEW.channel_source_revision <> OLD.channel_source_revision + 1
    THEN
      RAISE EXCEPTION 'channel inventory update did not advance value and revision'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_inventory_days_channel_transition';
    END IF;
  ELSIF manual_changed THEN
    IF NEW.manual_sellable_limit_count IS NOT DISTINCT FROM OLD.manual_sellable_limit_count
      OR OLD.manual_source_revision = 2147483647
      OR NEW.manual_source_revision <> OLD.manual_source_revision + 1
    THEN
      RAISE EXCEPTION 'manual inventory update did not advance value and revision'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_inventory_days_manual_transition';
    END IF;
  ELSIF block_changed THEN
    IF NEW.blocked_count = OLD.blocked_count
      OR OLD.block_source_revision = 2147483647
      OR NEW.block_source_revision <> OLD.block_source_revision + 1
    THEN
      RAISE EXCEPTION 'block inventory update did not advance value and revision'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_inventory_days_block_transition';
    END IF;
  ELSIF booking_changed THEN
    IF NEW.assigned_count = OLD.assigned_count
      OR OLD.booking_source_revision = 2147483647
      OR NEW.booking_source_revision <> OLD.booking_source_revision + 1
    THEN
      RAISE EXCEPTION 'booking inventory update did not advance value and revision'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_inventory_days_booking_transition';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pms_inventory_days_canonical_transition
  BEFORE UPDATE ON pms.inventory_days
  FOR EACH ROW EXECUTE FUNCTION pms.validate_inventory_day_canonical_transition();

CREATE TABLE pms.inventory_materialization_coverage (
  property_id          UUID        PRIMARY KEY,
  organization_id      UUID        NOT NULL,
  calendar_revision    INTEGER     NOT NULL,
  materialized_revision INTEGER    NOT NULL,
  coverage_from        DATE        NOT NULL,
  coverage_through     DATE        NOT NULL,
  room_type_count      INTEGER     NOT NULL,
  expected_day_count   INTEGER     NOT NULL,
  materialized_day_count INTEGER   NOT NULL,
  last_changed_materialization_idempotency_key_id UUID NOT NULL,
  last_changed_materialization_domain_event_id    UUID NOT NULL,
  last_changed_materialization_outbox_event_id    UUID NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL,
  scope_key            TEXT        GENERATED ALWAYS AS (
                                    platform.tenant_scope_key(
                                      'property', NULL::UUID, property_id
                                    )
                                  ) STORED,
  CONSTRAINT chk_pms_inventory_coverage_revision_identity
    CHECK (
      calendar_revision BETWEEN 1 AND 2147483647
      AND materialized_revision = calendar_revision
    ),
  CONSTRAINT chk_pms_inventory_coverage_horizon
    CHECK (coverage_through - coverage_from BETWEEN 0 AND 365),
  CONSTRAINT chk_pms_inventory_coverage_counts
    CHECK (
      room_type_count BETWEEN 1 AND 2147483647
      AND expected_day_count = room_type_count * (
        (coverage_through - coverage_from) + 1
      )
      AND materialized_day_count = expected_day_count
    ),
  CONSTRAINT fk_pms_inventory_coverage_calendar_organization
    FOREIGN KEY (organization_id, property_id, calendar_revision)
    REFERENCES pms.operating_calendar_revisions(
      organization_id, property_id, calendar_revision
    ),
  CONSTRAINT fk_pms_inventory_coverage_idempotency_scope
    FOREIGN KEY (last_changed_materialization_idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key),
  CONSTRAINT fk_pms_inventory_coverage_domain_event_property
    FOREIGN KEY (last_changed_materialization_domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  CONSTRAINT fk_pms_inventory_coverage_outbox_domain_event
    FOREIGN KEY (
      last_changed_materialization_outbox_event_id,
      last_changed_materialization_domain_event_id
    ) REFERENCES platform.outbox_events(id, domain_event_id),
  CONSTRAINT fk_pms_inventory_coverage_outbox_scope
    FOREIGN KEY (last_changed_materialization_outbox_event_id, scope_key)
    REFERENCES platform.outbox_events(id, scope_key)
);

CREATE FUNCTION pms.validate_inventory_coverage_transition()
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
      OR ROW(
        NEW.calendar_revision,
        NEW.materialized_revision,
        NEW.coverage_from,
        NEW.coverage_through,
        NEW.room_type_count,
        NEW.expected_day_count,
        NEW.materialized_day_count
      ) IS NOT DISTINCT FROM ROW(
        OLD.calendar_revision,
        OLD.materialized_revision,
        OLD.coverage_from,
        OLD.coverage_through,
        OLD.room_type_count,
        OLD.expected_day_count,
        OLD.materialized_day_count
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

CREATE TRIGGER trg_pms_inventory_coverage_transition
  BEFORE UPDATE OR DELETE ON pms.inventory_materialization_coverage
  FOR EACH ROW EXECUTE FUNCTION pms.validate_inventory_coverage_transition();
CREATE TRIGGER trg_pms_inventory_coverage_no_truncate
  BEFORE TRUNCATE ON pms.inventory_materialization_coverage
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TABLE pms.inventory_coverage_validation_queue (
  transaction_id BIGINT NOT NULL,
  property_id     UUID   NOT NULL,
  PRIMARY KEY (transaction_id, property_id)
);
REVOKE ALL ON pms.inventory_coverage_validation_queue FROM PUBLIC;

CREATE FUNCTION pms.queue_inventory_coverage_validation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  checked_property_id UUID := COALESCE(NEW.property_id, OLD.property_id);
BEGIN
  INSERT INTO pms.inventory_coverage_validation_queue (transaction_id, property_id)
  VALUES (txid_current(), checked_property_id)
  ON CONFLICT DO NOTHING;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION pms.validate_inventory_materialization_coverage_manifest()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  checked_property_id UUID := COALESCE(NEW.property_id, OLD.property_id);
  queued_property_id UUID;
  coverage pms.inventory_materialization_coverage%ROWTYPE;
  actual_room_count BIGINT;
  expected_rows BIGINT;
  present_rows BIGINT;
  all_rows_current BOOLEAN;
BEGIN
  DELETE FROM pms.inventory_coverage_validation_queue
  WHERE transaction_id = txid_current()
    AND property_id = checked_property_id
  RETURNING property_id INTO queued_property_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO coverage
  FROM pms.inventory_materialization_coverage
  WHERE property_id = checked_property_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO actual_room_count
  FROM pms.operating_calendar_room_bindings
  WHERE property_id = coverage.property_id
    AND calendar_revision = coverage.calendar_revision;

  SELECT
    count(*),
    count(inventory.property_id),
    COALESCE(bool_and(
      inventory.calendar_revision = coverage.calendar_revision
      AND inventory.generated_source_revision = coverage.calendar_revision
    ), FALSE)
  INTO expected_rows, present_rows, all_rows_current
  FROM pms.operating_calendar_room_bindings AS binding
  CROSS JOIN LATERAL generate_series(
    coverage.coverage_from,
    coverage.coverage_through,
    INTERVAL '1 day'
  ) AS expected(stay_date)
  LEFT JOIN pms.inventory_days AS inventory
    ON inventory.property_id = binding.property_id
   AND inventory.room_type_id = binding.room_type_id
   AND inventory.stay_date = expected.stay_date::DATE
  WHERE binding.property_id = coverage.property_id
    AND binding.calendar_revision = coverage.calendar_revision;

  IF actual_room_count <> coverage.room_type_count
    OR expected_rows <> coverage.expected_day_count
    OR present_rows <> coverage.materialized_day_count
    OR NOT all_rows_current
  THEN
    RAISE EXCEPTION 'inventory materialization coverage is not exact and gap-free'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_inventory_coverage_manifest';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_pms_inventory_coverage_manifest_queue
  BEFORE INSERT OR UPDATE ON pms.inventory_materialization_coverage
  FOR EACH ROW EXECUTE FUNCTION pms.queue_inventory_coverage_validation();
CREATE CONSTRAINT TRIGGER trg_pms_inventory_coverage_manifest
  AFTER INSERT OR UPDATE ON pms.inventory_materialization_coverage
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_inventory_materialization_coverage_manifest();
CREATE TRIGGER trg_pms_inventory_days_coverage_manifest_queue
  BEFORE INSERT OR UPDATE OR DELETE ON pms.inventory_days
  FOR EACH ROW EXECUTE FUNCTION pms.queue_inventory_coverage_validation();
CREATE CONSTRAINT TRIGGER trg_pms_inventory_days_coverage_manifest
  AFTER INSERT OR UPDATE OR DELETE ON pms.inventory_days
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_inventory_materialization_coverage_manifest();
REVOKE ALL ON FUNCTION pms.queue_inventory_coverage_validation() FROM PUBLIC;
REVOKE ALL ON FUNCTION pms.validate_inventory_materialization_coverage_manifest() FROM PUBLIC;

CREATE TABLE pms.inventory_reservation_receipts (
  receipt_id            UUID        PRIMARY KEY,
  contract_version      TEXT        NOT NULL,
  receipt_owner         TEXT        NOT NULL,
  organization_id       UUID        NOT NULL,
  property_id           UUID        NOT NULL,
  room_type_id          UUID        NOT NULL,
  check_in              DATE        NOT NULL,
  check_out             DATE        NOT NULL,
  room_count            INTEGER     NOT NULL,
  quote_session_id      TEXT        NOT NULL,
  public_offer_key      TEXT        NOT NULL,
  calendar_revision     INTEGER     NOT NULL,
  materialized_revision INTEGER     NOT NULL,
  reserve_fingerprint_hash TEXT     NOT NULL,
  reserve_idempotency_key_id UUID   NOT NULL UNIQUE,
  reserve_domain_event_id    UUID   NOT NULL UNIQUE,
  reserve_outbox_event_id    UUID   NOT NULL UNIQUE,
  reserved_at           TIMESTAMPTZ NOT NULL,
  scope_key              TEXT       GENERATED ALWAYS AS (
                                     platform.tenant_scope_key(
                                       'property', NULL::UUID, property_id
                                     )
                                   ) STORED,
  UNIQUE (receipt_id, organization_id, property_id),
  UNIQUE (
    receipt_id,
    organization_id,
    property_id,
    room_type_id,
    calendar_revision
  ),
  CONSTRAINT chk_pms_inventory_reservation_receipt_contract
    CHECK (
      contract_version = 'pms-inventory-reservation-lifecycle.v1'
      AND receipt_owner = 'pms'
    ),
  CONSTRAINT chk_pms_inventory_reservation_receipt_range
    CHECK (check_out - check_in BETWEEN 1 AND 366),
  CONSTRAINT chk_pms_inventory_reservation_receipt_count
    CHECK (room_count BETWEEN 1 AND 500),
  CONSTRAINT chk_pms_inventory_reservation_receipt_correlation
    CHECK (
      quote_session_id = btrim(quote_session_id)
      AND char_length(quote_session_id) BETWEEN 1 AND 200
      AND public_offer_key = btrim(public_offer_key)
      AND char_length(public_offer_key) BETWEEN 1 AND 200
    ),
  CONSTRAINT chk_pms_inventory_reservation_receipt_revision_identity
    CHECK (
      calendar_revision BETWEEN 1 AND 2147483647
      AND materialized_revision = calendar_revision
    ),
  CONSTRAINT chk_pms_inventory_reservation_reserve_fingerprint
    CHECK (reserve_fingerprint_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT fk_pms_inventory_reservation_receipt_calendar_organization
    FOREIGN KEY (organization_id, property_id, calendar_revision)
    REFERENCES pms.operating_calendar_revisions(
      organization_id, property_id, calendar_revision
    ),
  CONSTRAINT fk_pms_inventory_reservation_receipt_room_binding
    FOREIGN KEY (property_id, calendar_revision, room_type_id)
    REFERENCES pms.operating_calendar_room_bindings(
      property_id, calendar_revision, room_type_id
    ),
  CONSTRAINT fk_pms_inventory_reservation_receipt_idempotency_scope
    FOREIGN KEY (reserve_idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key),
  CONSTRAINT fk_pms_inventory_reservation_receipt_domain_event_property
    FOREIGN KEY (reserve_domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  CONSTRAINT fk_pms_inventory_reservation_receipt_outbox_domain_event
    FOREIGN KEY (reserve_outbox_event_id, reserve_domain_event_id)
    REFERENCES platform.outbox_events(id, domain_event_id),
  CONSTRAINT fk_pms_inventory_reservation_receipt_outbox_scope
    FOREIGN KEY (reserve_outbox_event_id, scope_key)
    REFERENCES platform.outbox_events(id, scope_key)
);

CREATE TABLE pms.inventory_reservation_statuses (
  receipt_id              UUID        PRIMARY KEY,
  organization_id         UUID        NOT NULL,
  property_id             UUID        NOT NULL,
  lifecycle_state         TEXT        NOT NULL,
  lifecycle_revision      INTEGER     NOT NULL,
  release_fingerprint_hash TEXT,
  release_idempotency_key_id UUID     UNIQUE,
  release_domain_event_id    UUID     UNIQUE,
  release_outbox_event_id    UUID     UNIQUE,
  released_at             TIMESTAMPTZ,
  handed_off_at           TIMESTAMPTZ,
  scope_key                TEXT        GENERATED ALWAYS AS (
                                       platform.tenant_scope_key(
                                         'property', NULL::UUID, property_id
                                       )
                                     ) STORED,
  CONSTRAINT chk_pms_inventory_reservation_status_shape
    CHECK (
      (
        lifecycle_state = 'reserved'
        AND lifecycle_revision = 1
        AND release_fingerprint_hash IS NULL
        AND release_idempotency_key_id IS NULL
        AND release_domain_event_id IS NULL
        AND release_outbox_event_id IS NULL
        AND released_at IS NULL
        AND handed_off_at IS NULL
      )
      OR
      (
        lifecycle_state = 'released'
        AND lifecycle_revision = 2
        AND release_fingerprint_hash IS NOT NULL
        AND release_fingerprint_hash ~ '^sha256:[0-9a-f]{64}$'
        AND release_idempotency_key_id IS NOT NULL
        AND release_domain_event_id IS NOT NULL
        AND release_outbox_event_id IS NOT NULL
        AND released_at IS NOT NULL
        AND handed_off_at IS NULL
      )
      OR
      (
        lifecycle_state = 'handed_off'
        AND lifecycle_revision = 2
        AND release_fingerprint_hash IS NULL
        AND release_idempotency_key_id IS NULL
        AND release_domain_event_id IS NULL
        AND release_outbox_event_id IS NULL
        AND released_at IS NULL
        AND handed_off_at IS NOT NULL
      )
    ),
  CONSTRAINT fk_pms_inventory_reservation_status_receipt_scope
    FOREIGN KEY (receipt_id, organization_id, property_id)
    REFERENCES pms.inventory_reservation_receipts(
      receipt_id, organization_id, property_id
    ),
  CONSTRAINT fk_pms_inventory_reservation_status_release_idempotency_scope
    FOREIGN KEY (release_idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key),
  CONSTRAINT fk_pms_inventory_reservation_status_release_event_property
    FOREIGN KEY (release_domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  CONSTRAINT fk_pms_inventory_reservation_status_release_outbox_event
    FOREIGN KEY (release_outbox_event_id, release_domain_event_id)
    REFERENCES platform.outbox_events(id, domain_event_id),
  CONSTRAINT fk_pms_inventory_reservation_status_release_outbox_scope
    FOREIGN KEY (release_outbox_event_id, scope_key)
    REFERENCES platform.outbox_events(id, scope_key)
);

CREATE FUNCTION pms.validate_inventory_reservation_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_reserved_at TIMESTAMPTZ;
  receipt_reserve_idempotency_key_id UUID;
  receipt_reserve_domain_event_id UUID;
  receipt_reserve_outbox_event_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory reservation status cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_state <> 'reserved' OR NEW.lifecycle_revision <> 1 THEN
      RAISE EXCEPTION 'inventory reservation status must start reserved at revision one'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_inventory_reservation_status_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.lifecycle_state <> 'reserved'
    OR OLD.lifecycle_revision <> 1
    OR NEW.lifecycle_state NOT IN ('released', 'handed_off')
    OR NEW.lifecycle_revision <> 2
    OR ROW(NEW.receipt_id, NEW.organization_id, NEW.property_id)
      IS DISTINCT FROM ROW(OLD.receipt_id, OLD.organization_id, OLD.property_id)
  THEN
    RAISE EXCEPTION 'inventory reservation status transition is terminal and exact'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_inventory_reservation_status_transition';
  END IF;

  SELECT
    reserved_at,
    reserve_idempotency_key_id,
    reserve_domain_event_id,
    reserve_outbox_event_id
  INTO
    receipt_reserved_at,
    receipt_reserve_idempotency_key_id,
    receipt_reserve_domain_event_id,
    receipt_reserve_outbox_event_id
  FROM pms.inventory_reservation_receipts
  WHERE receipt_id = NEW.receipt_id
    AND organization_id = NEW.organization_id
    AND property_id = NEW.property_id;
  IF NEW.lifecycle_state = 'released'
    AND (
      NEW.release_idempotency_key_id = receipt_reserve_idempotency_key_id
      OR NEW.release_domain_event_id = receipt_reserve_domain_event_id
      OR NEW.release_outbox_event_id = receipt_reserve_outbox_event_id
    )
  THEN
    RAISE EXCEPTION 'inventory reservation release cannot reuse reserve evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_inventory_reservation_status_transition';
  END IF;
  IF (NEW.lifecycle_state = 'released' AND NEW.released_at < receipt_reserved_at)
    OR (NEW.lifecycle_state = 'handed_off' AND NEW.handed_off_at < receipt_reserved_at)
  THEN
    RAISE EXCEPTION 'inventory reservation terminal time precedes reserve time'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_inventory_reservation_status_time';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pms_inventory_reservation_status_transition
  BEFORE INSERT OR UPDATE OR DELETE ON pms.inventory_reservation_statuses
  FOR EACH ROW EXECUTE FUNCTION pms.validate_inventory_reservation_status_transition();
CREATE TRIGGER trg_pms_inventory_reservation_status_no_truncate
  BEFORE TRUNCATE ON pms.inventory_reservation_statuses
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TABLE pms.inventory_reservation_day_watermarks (
  receipt_id                UUID    NOT NULL,
  organization_id           UUID    NOT NULL,
  property_id               UUID    NOT NULL,
  room_type_id              UUID    NOT NULL,
  stay_date                 DATE    NOT NULL,
  calendar_revision         INTEGER NOT NULL,
  inventory_revision        INTEGER NOT NULL,
  generated_source_revision INTEGER NOT NULL,
  channel_source_revision   INTEGER NOT NULL,
  manual_source_revision    INTEGER NOT NULL,
  block_source_revision     INTEGER NOT NULL,
  booking_source_revision   INTEGER NOT NULL,
  PRIMARY KEY (receipt_id, stay_date),
  CONSTRAINT chk_pms_inventory_reservation_watermark_revisions
    CHECK (
      calendar_revision BETWEEN 1 AND 2147483647
      AND inventory_revision BETWEEN 1 AND 2147483647
      AND generated_source_revision = calendar_revision
      AND channel_source_revision BETWEEN 0 AND 2147483647
      AND manual_source_revision BETWEEN 0 AND 2147483647
      AND block_source_revision BETWEEN 0 AND 2147483647
      AND booking_source_revision BETWEEN 0 AND 2147483647
    ),
  CONSTRAINT fk_pms_inventory_reservation_watermark_receipt_scope
    FOREIGN KEY (
      receipt_id,
      organization_id,
      property_id,
      room_type_id,
      calendar_revision
    ) REFERENCES pms.inventory_reservation_receipts(
      receipt_id,
      organization_id,
      property_id,
      room_type_id,
      calendar_revision
    ),
  CONSTRAINT fk_pms_inventory_reservation_watermark_inventory_day
    FOREIGN KEY (property_id, room_type_id, stay_date)
    REFERENCES pms.inventory_days(property_id, room_type_id, stay_date)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION pms.validate_inventory_reservation_manifest()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  checked_receipt_id UUID := COALESCE(NEW.receipt_id, OLD.receipt_id);
  receipt pms.inventory_reservation_receipts%ROWTYPE;
  status_count BIGINT;
  watermark_count BIGINT;
  first_date DATE;
  last_date DATE;
BEGIN
  SELECT * INTO receipt
  FROM pms.inventory_reservation_receipts
  WHERE receipt_id = checked_receipt_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO status_count
  FROM pms.inventory_reservation_statuses
  WHERE receipt_id = checked_receipt_id
    AND organization_id = receipt.organization_id
    AND property_id = receipt.property_id;
  SELECT count(*), min(stay_date), max(stay_date)
  INTO watermark_count, first_date, last_date
  FROM pms.inventory_reservation_day_watermarks
  WHERE receipt_id = checked_receipt_id
    AND organization_id = receipt.organization_id
    AND property_id = receipt.property_id
    AND room_type_id = receipt.room_type_id
    AND calendar_revision = receipt.calendar_revision;

  IF status_count <> 1
    OR watermark_count <> receipt.check_out - receipt.check_in
    OR first_date <> receipt.check_in
    OR last_date <> receipt.check_out - 1
    OR EXISTS (
      SELECT expected.stay_date::DATE
      FROM generate_series(
        receipt.check_in,
        receipt.check_out - 1,
        INTERVAL '1 day'
      ) AS expected(stay_date)
      EXCEPT
      SELECT watermark.stay_date
      FROM pms.inventory_reservation_day_watermarks AS watermark
      WHERE watermark.receipt_id = checked_receipt_id
    )
  THEN
    RAISE EXCEPTION 'inventory reservation manifest is not exact and gap-free'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_inventory_reservation_manifest';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_pms_inventory_reservation_receipt_manifest
  AFTER INSERT ON pms.inventory_reservation_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_inventory_reservation_manifest();
CREATE CONSTRAINT TRIGGER trg_pms_inventory_reservation_status_manifest
  AFTER INSERT OR UPDATE ON pms.inventory_reservation_statuses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_inventory_reservation_manifest();
CREATE CONSTRAINT TRIGGER trg_pms_inventory_reservation_watermark_manifest
  AFTER INSERT ON pms.inventory_reservation_day_watermarks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_inventory_reservation_manifest();

CREATE TRIGGER trg_pms_inventory_reservation_receipts_append_only
  BEFORE UPDATE OR DELETE ON pms.inventory_reservation_receipts
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_pms_inventory_reservation_receipts_no_truncate
  BEFORE TRUNCATE ON pms.inventory_reservation_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_pms_inventory_reservation_watermarks_append_only
  BEFORE UPDATE OR DELETE ON pms.inventory_reservation_day_watermarks
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_pms_inventory_reservation_watermarks_no_truncate
  BEFORE TRUNCATE ON pms.inventory_reservation_day_watermarks
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE INDEX idx_pms_inventory_days_canonical_coverage
  ON pms.inventory_days (
    property_id, calendar_revision, stay_date, room_type_id
  )
  WHERE calendar_revision IS NOT NULL;
CREATE INDEX idx_pms_inventory_reservation_receipts_scope
  ON pms.inventory_reservation_receipts (
    organization_id, property_id, receipt_id
  );
CREATE INDEX idx_pms_inventory_reservation_receipts_checkout
  ON pms.inventory_reservation_receipts (property_id, check_out, receipt_id);
CREATE INDEX idx_pms_inventory_reservation_statuses_reserved_reconciliation
  ON pms.inventory_reservation_statuses (property_id, receipt_id)
  WHERE lifecycle_state = 'reserved';
