-- Migration: 0125_source_extraction_snapshot_time
-- Owner: migration-cutover; see VAY-1351 and VAY-1356

ALTER TABLE platform.source_extraction_sources
  ADD COLUMN source_snapshot_at TIMESTAMPTZ,
  ADD CONSTRAINT chk_source_extraction_source_snapshot_time
    CHECK (status <> 'completed' OR source_snapshot_at IS NOT NULL) NOT VALID;

COMMENT ON COLUMN platform.source_extraction_sources.source_snapshot_at IS
  'Transaction timestamp from the read-only source snapshot; required by time-sensitive production transforms.';
