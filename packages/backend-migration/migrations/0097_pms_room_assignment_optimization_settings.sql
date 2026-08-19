-- Migration: 0097_pms_room_assignment_optimization_settings
-- Owner: domain-pms; see VAY-667

CREATE TABLE pms.room_assignment_optimization_settings (
  property_id              UUID        PRIMARY KEY
    REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  auto_rearrange_enabled   BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VIEW pms.effective_room_assignment_optimization_settings AS
SELECT
  property.id AS property_id,
  COALESCE(settings.auto_rearrange_enabled, TRUE) AS auto_rearrange_enabled,
  settings.updated_at
FROM hotel_catalog.properties AS property
LEFT JOIN pms.room_assignment_optimization_settings AS settings
  ON settings.property_id = property.id;
