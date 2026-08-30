-- VAY-1355: durable provenance for production source-to-target migrations.

CREATE TABLE platform.production_migration_source_links (
  source_database     TEXT        NOT NULL
                                  CHECK (source_database IN ('auth', 'booking', 'marketplace', 'pms')),
  source_table        TEXT        NOT NULL,
  source_id           TEXT        NOT NULL,
  target_product      TEXT        NOT NULL
                                  CHECK (target_product IN (
                                    'identity', 'hotel_catalog', 'booking', 'pms',
                                    'finance', 'marketplace', 'distribution', 'platform'
                                  )),
  target_table        TEXT        NOT NULL,
  target_id           TEXT        NOT NULL,
  first_run_id        TEXT        NOT NULL,
  last_run_id         TEXT        NOT NULL,
  source_checksum     TEXT        NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  source_updated_at   TIMESTAMPTZ,
  first_migrated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_migrated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    source_database,
    source_table,
    source_id,
    target_product,
    target_table,
    target_id
  ),
  CONSTRAINT chk_production_migration_run_ids
    CHECK (
      first_run_id ~ '^vay1351-[0-9a-f]{24}$'
      AND last_run_id ~ '^vay1351-[0-9a-f]{24}$'
    )
);

CREATE INDEX idx_production_migration_source_links_target
  ON platform.production_migration_source_links (target_product, target_table, target_id);

COMMENT ON TABLE platform.production_migration_source_links IS
  'Durable production migration provenance. A surviving link with an absent target row prevents a later legacy snapshot from resurrecting a target-side deletion.';
