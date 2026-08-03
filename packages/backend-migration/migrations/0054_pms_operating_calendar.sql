-- Migration: 0054_pms_operating_calendar
-- Owner: domain-pms
-- See: VAY-1071, engineering/hotel-onboarding-information-inventory.md (ONB-19)
--
-- Operating configuration is immutable owner state. It is independent from
-- dated availability, sellout, pricing, and rolling-horizon materialization.

CREATE FUNCTION pms.operating_calendar_month_day_is_valid(month SMALLINT, day SMALLINT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT month BETWEEN 1 AND 12
    AND day BETWEEN 1 AND CASE month
      WHEN 2 THEN 28
      WHEN 4 THEN 30
      WHEN 6 THEN 30
      WHEN 9 THEN 30
      WHEN 11 THEN 30
      ELSE 31
    END;
$$;

CREATE TABLE pms.operating_calendar_revisions (
  organization_id                 UUID        NOT NULL,
  property_id                     UUID        NOT NULL,
  calendar_revision               INTEGER     NOT NULL,
  contract_version                TEXT        NOT NULL,
  source_owner_domain             TEXT        GENERATED ALWAYS AS ('pms') STORED,
  source_entity_type              TEXT        GENERATED ALWAYS AS (
                                               'pms_operating_calendar.v1'
                                             ) STORED,
  source_entity_id                UUID        GENERATED ALWAYS AS (property_id) STORED,
  source_revision                 TEXT        GENERATED ALWAYS AS (
                                               'calendar:' || calendar_revision::TEXT
                                             ) STORED,
  property_profile_owner_domain   TEXT        GENERATED ALWAYS AS ('hotel_catalog') STORED,
  property_profile_entity_type    TEXT        GENERATED ALWAYS AS ('property_profile') STORED,
  property_profile_entity_id      UUID        GENERATED ALWAYS AS (property_id) STORED,
  property_profile_revision       INTEGER     NOT NULL,
  property_profile_source_revision TEXT       GENERATED ALWAYS AS (
                                               'profile:' || property_profile_revision::TEXT
                                             ) STORED,
  property_time_zone              TEXT        NOT NULL,
  schedule_mode                   TEXT        NOT NULL,
  recurring_period_count          SMALLINT    NOT NULL,
  room_binding_count              INTEGER     NOT NULL,
  default_minimum_stay_nights     SMALLINT    NOT NULL,
  idempotency_key_id              UUID        NOT NULL UNIQUE,
  domain_event_id                 UUID        NOT NULL UNIQUE,
  outbox_event_id                 UUID        NOT NULL UNIQUE,
  created_by_user_id              UUID        NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL,
  updated_at                      TIMESTAMPTZ NOT NULL,
  scope_key                       TEXT        GENERATED ALWAYS AS (
                                               platform.tenant_scope_key(
                                                 'property', NULL::UUID, property_id
                                               )
                                             ) STORED,
  PRIMARY KEY (property_id, calendar_revision),
  CONSTRAINT uq_pms_operating_calendar_revision_mode
    UNIQUE (property_id, calendar_revision, schedule_mode),
  CONSTRAINT uq_pms_operating_calendar_source
    UNIQUE (
      source_owner_domain, source_entity_type, source_entity_id, source_revision
    ),
  CONSTRAINT chk_pms_operating_calendar_revision
    CHECK (calendar_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_pms_operating_calendar_contract
    CHECK (contract_version = 'pms-operating-calendar.v1'),
  CONSTRAINT chk_pms_operating_calendar_profile_revision
    CHECK (property_profile_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_pms_operating_calendar_time_zone_shape
    CHECK (
      property_time_zone = btrim(property_time_zone)
      AND char_length(property_time_zone) BETWEEN 3 AND 100
      AND property_time_zone ~ '^[A-Za-z_]+/[A-Za-z0-9_+./-]+$'
    ),
  CONSTRAINT chk_pms_operating_calendar_schedule
    CHECK (
      (schedule_mode = 'year_round' AND recurring_period_count = 0)
      OR (schedule_mode = 'recurring' AND recurring_period_count BETWEEN 1 AND 24)
    ),
  CONSTRAINT chk_pms_operating_calendar_room_count
    CHECK (room_binding_count BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_pms_operating_calendar_minimum_stay
    CHECK (default_minimum_stay_nights BETWEEN 1 AND 366),
  CONSTRAINT chk_pms_operating_calendar_immutable_timestamps
    CHECK (updated_at = created_at),
  CONSTRAINT fk_pms_operating_calendar_idempotency_scope
    FOREIGN KEY (idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key),
  CONSTRAINT fk_pms_operating_calendar_domain_event_property
    FOREIGN KEY (domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  CONSTRAINT fk_pms_operating_calendar_outbox_event
    FOREIGN KEY (outbox_event_id, domain_event_id)
    REFERENCES platform.outbox_events(id, domain_event_id),
  CONSTRAINT fk_pms_operating_calendar_outbox_scope
    FOREIGN KEY (outbox_event_id, scope_key)
    REFERENCES platform.outbox_events(id, scope_key)
);

CREATE TABLE pms.operating_calendar_recurring_periods (
  property_id       UUID     NOT NULL,
  calendar_revision INTEGER  NOT NULL,
  schedule_mode     TEXT     NOT NULL DEFAULT 'recurring',
  period_index      SMALLINT NOT NULL,
  start_month       SMALLINT NOT NULL,
  start_day         SMALLINT NOT NULL,
  end_month         SMALLINT NOT NULL,
  end_day           SMALLINT NOT NULL,
  PRIMARY KEY (property_id, calendar_revision, period_index),
  CONSTRAINT uq_pms_operating_calendar_recurring_period
    UNIQUE (
      property_id, calendar_revision, start_month, start_day, end_month, end_day
    ),
  CONSTRAINT fk_pms_operating_calendar_recurring_period_parent
    FOREIGN KEY (property_id, calendar_revision, schedule_mode)
    REFERENCES pms.operating_calendar_revisions(
      property_id, calendar_revision, schedule_mode
    ),
  CONSTRAINT chk_pms_operating_calendar_recurring_mode
    CHECK (schedule_mode = 'recurring'),
  CONSTRAINT chk_pms_operating_calendar_period_index
    CHECK (period_index BETWEEN 0 AND 23),
  CONSTRAINT chk_pms_operating_calendar_period_start
    CHECK (pms.operating_calendar_month_day_is_valid(start_month, start_day)),
  CONSTRAINT chk_pms_operating_calendar_period_end
    CHECK (pms.operating_calendar_month_day_is_valid(end_month, end_day))
);

CREATE TABLE pms.operating_calendar_room_bindings (
  property_id                   UUID     NOT NULL,
  calendar_revision             INTEGER  NOT NULL,
  room_type_id                  UUID     NOT NULL,
  source_room_facts_revision    INTEGER  NOT NULL,
  source_room_units_revision    INTEGER  NOT NULL,
  physical_capacity_count       SMALLINT NOT NULL,
  starting_sellable_limit_count SMALLINT NOT NULL,
  PRIMARY KEY (property_id, calendar_revision, room_type_id),
  CONSTRAINT fk_pms_operating_calendar_room_binding_parent
    FOREIGN KEY (property_id, calendar_revision)
    REFERENCES pms.operating_calendar_revisions(property_id, calendar_revision),
  CONSTRAINT chk_pms_operating_calendar_room_revisions
    CHECK (
      source_room_facts_revision BETWEEN 1 AND 2147483647
      AND source_room_units_revision BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT chk_pms_operating_calendar_room_capacity
    CHECK (physical_capacity_count BETWEEN 1 AND 500),
  CONSTRAINT chk_pms_operating_calendar_sellable_limit
    CHECK (
      starting_sellable_limit_count BETWEEN 1 AND physical_capacity_count
  )
);

CREATE FUNCTION pms.operating_calendar_periods_are_canonical(
  checked_property_id UUID,
  checked_calendar_revision INTEGER,
  expected_period_count SMALLINT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  WITH periods AS (
    SELECT
      period_index,
      (make_date(2001, start_month, start_day) - DATE '2001-01-01') + 1 AS start_ordinal,
      (make_date(2001, end_month, end_day) - DATE '2001-01-01') + 1 AS end_ordinal
    FROM pms.operating_calendar_recurring_periods
    WHERE property_id = checked_property_id
      AND calendar_revision = checked_calendar_revision
  ),
  ordered AS (
    SELECT
      *,
      row_number() OVER (ORDER BY start_ordinal, end_ordinal) - 1 AS canonical_index
    FROM periods
  ),
  occupied AS (
    SELECT
      period_index,
      ((linear_day - 1) % 365) + 1 AS occupied_ordinal
    FROM periods
    CROSS JOIN LATERAL generate_series(
      start_ordinal,
      CASE WHEN end_ordinal >= start_ordinal THEN end_ordinal ELSE end_ordinal + 365 END
    ) AS linear_day
  )
  SELECT
    (SELECT count(*) FROM periods) = expected_period_count
    AND (SELECT bool_and(period_index = canonical_index) FROM ordered)
    AND (SELECT count(*) FROM occupied) =
      (SELECT count(DISTINCT occupied_ordinal) FROM occupied)
    AND (SELECT count(DISTINCT occupied_ordinal) FROM occupied) < 365
    AND NOT EXISTS (
      SELECT 1
      FROM periods AS ending_period
      JOIN periods AS starting_period
        ON starting_period.start_ordinal = (ending_period.end_ordinal % 365) + 1
       AND starting_period.period_index <> ending_period.period_index
    );
$$;

CREATE FUNCTION pms.validate_operating_calendar_manifest()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  checked_property_id UUID := NEW.property_id;
  checked_calendar_revision INTEGER := NEW.calendar_revision;
  parent pms.operating_calendar_revisions%ROWTYPE;
  actual_period_count BIGINT;
  actual_room_count BIGINT;
BEGIN
  SELECT * INTO parent
  FROM pms.operating_calendar_revisions
  WHERE property_id = checked_property_id
    AND calendar_revision = checked_calendar_revision;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO actual_period_count
  FROM pms.operating_calendar_recurring_periods
  WHERE property_id = checked_property_id
    AND calendar_revision = checked_calendar_revision;
  SELECT count(*) INTO actual_room_count
  FROM pms.operating_calendar_room_bindings
  WHERE property_id = checked_property_id
    AND calendar_revision = checked_calendar_revision;

  IF actual_period_count <> parent.recurring_period_count
    OR actual_room_count <> parent.room_binding_count
  THEN
    RAISE EXCEPTION 'operating calendar manifest counts do not match the immutable revision'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_operating_calendar_manifest_counts';
  END IF;

  IF parent.schedule_mode = 'recurring'
    AND NOT pms.operating_calendar_periods_are_canonical(
      checked_property_id,
      checked_calendar_revision,
      parent.recurring_period_count
    )
  THEN
    RAISE EXCEPTION 'operating calendar recurring periods are not canonical'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_operating_calendar_periods_canonical';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_pms_operating_calendar_revision_manifest
  AFTER INSERT ON pms.operating_calendar_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_operating_calendar_manifest();
CREATE CONSTRAINT TRIGGER trg_pms_operating_calendar_period_manifest
  AFTER INSERT ON pms.operating_calendar_recurring_periods
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_operating_calendar_manifest();
CREATE CONSTRAINT TRIGGER trg_pms_operating_calendar_room_manifest
  AFTER INSERT ON pms.operating_calendar_room_bindings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_operating_calendar_manifest();

CREATE TRIGGER trg_pms_operating_calendar_revisions_append_only
  BEFORE UPDATE OR DELETE ON pms.operating_calendar_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_pms_operating_calendar_revisions_no_truncate
  BEFORE TRUNCATE ON pms.operating_calendar_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_pms_operating_calendar_periods_append_only
  BEFORE UPDATE OR DELETE ON pms.operating_calendar_recurring_periods
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_pms_operating_calendar_periods_no_truncate
  BEFORE TRUNCATE ON pms.operating_calendar_recurring_periods
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_pms_operating_calendar_rooms_append_only
  BEFORE UPDATE OR DELETE ON pms.operating_calendar_room_bindings
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_pms_operating_calendar_rooms_no_truncate
  BEFORE TRUNCATE ON pms.operating_calendar_room_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
