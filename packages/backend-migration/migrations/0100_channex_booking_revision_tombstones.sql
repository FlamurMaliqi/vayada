-- Migration: 0100_channex_booking_revision_tombstones
-- Owner: domain-pms; see VAY-845 and VAY-1189.

ALTER TABLE pms.channel_connections
  ADD COLUMN binding_generation UUID NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE pms.channel_booking_revision_tombstones (
  connection_id UUID NOT NULL,
  property_id UUID NOT NULL,
  binding_generation UUID NOT NULL,
  external_booking_id TEXT NOT NULL,
  authoritative_revision_id TEXT NOT NULL,
  inserted_at TIMESTAMPTZ(6) NOT NULL,
  status TEXT NOT NULL DEFAULT 'canceled' CHECK (status = 'canceled'),
  retention_expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '90 days',
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, binding_generation, external_booking_id),
  FOREIGN KEY (connection_id, property_id)
    REFERENCES pms.channel_connections(id, property_id) ON DELETE CASCADE,
  CHECK (length(external_booking_id) BETWEEN 1 AND 200),
  CHECK (length(authoritative_revision_id) BETWEEN 1 AND 200),
  CHECK (
    retention_expires_at > created_at
    AND retention_expires_at <= created_at + INTERVAL '90 days'
  ),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE INDEX idx_pms_channex_booking_tombstones_retention
  ON pms.channel_booking_revision_tombstones (retention_expires_at, connection_id)
  WHERE resolved_at IS NULL;

CREATE FUNCTION pms.rotate_channel_connection_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.external_property_id IS DISTINCT FROM NEW.external_property_id THEN
    UPDATE pms.channel_booking_revision_tombstones
      SET resolved_at = COALESCE(resolved_at, now()), updated_at = now()
      WHERE connection_id = OLD.id AND binding_generation = OLD.binding_generation
        AND resolved_at IS NULL;
    NEW.binding_generation := gen_random_uuid();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_pms_channel_connection_binding
  BEFORE UPDATE OF external_property_id ON pms.channel_connections
  FOR EACH ROW EXECUTE FUNCTION pms.rotate_channel_connection_binding();
