-- Migration: 0080_pms_room_block_revisions
-- Owner: domain-pms; see VAY-1286

ALTER TABLE pms.room_blocks
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
