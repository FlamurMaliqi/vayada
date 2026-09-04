-- Migration: 0135_pms_calendar_auto_open_settings
-- Owner: domain-pms / VAY-1433

CREATE TABLE pms.calendar_auto_open_settings (
  property_id      UUID        PRIMARY KEY
                              REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  revision         INTEGER     NOT NULL CHECK (revision > 0),
  enabled          BOOLEAN     NOT NULL,
  mode             TEXT        NOT NULL CHECK (mode IN ('rolling', 'fixed')),
  rolling_months   SMALLINT    CHECK (rolling_months IN (12, 18, 24)),
  fixed_end_month  DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_calendar_auto_open_mode_parameter CHECK (
    (mode = 'rolling' AND rolling_months IS NOT NULL AND fixed_end_month IS NULL)
    OR
    (mode = 'fixed' AND rolling_months IS NULL AND fixed_end_month IS NOT NULL)
  ),
  CONSTRAINT chk_calendar_auto_open_fixed_month_start CHECK (
    fixed_end_month IS NULL
    OR fixed_end_month = date_trunc('month', fixed_end_month)::date
  )
);

CREATE VIEW pms.effective_calendar_auto_open_settings AS
SELECT
  property.id AS property_id,
  COALESCE(settings.revision, 0) AS revision,
  COALESCE(settings.enabled, FALSE) AS enabled,
  COALESCE(settings.mode, 'rolling') AS mode,
  CASE WHEN settings.property_id IS NULL THEN 18 ELSE settings.rolling_months END AS rolling_months,
  settings.fixed_end_month,
  settings.updated_at
FROM hotel_catalog.properties AS property
LEFT JOIN pms.calendar_auto_open_settings AS settings
  ON settings.property_id = property.id;
