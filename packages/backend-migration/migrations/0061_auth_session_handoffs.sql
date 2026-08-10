-- Migration: 0061_auth_session_handoffs
-- Owner: domain-identity
-- Opaque, one-time browser-session handoffs between first-party Vayada surfaces.

CREATE TABLE identity.auth_session_handoffs (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_digest          TEXT        NOT NULL UNIQUE,
  source_surface       TEXT        NOT NULL,
  target_surface       TEXT        NOT NULL,
  source_public_origin TEXT        NOT NULL,
  target_public_origin TEXT        NOT NULL,
  sealed_session       TEXT,
  target_path          TEXT        NOT NULL,
  routing_hints        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  expires_at           TIMESTAMPTZ NOT NULL,
  redemption_id        UUID,
  redemption_started_at TIMESTAMPTZ,
  consumed_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_auth_session_handoffs_digest
    CHECK (code_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_auth_session_handoffs_surfaces
    CHECK (
      source_surface IN (
        'platform-admin', 'booking-admin', 'pms-web',
        'affiliate-dashboard', 'marketplace-web'
      )
      AND target_surface IN (
        'platform-admin', 'booking-admin', 'pms-web',
        'affiliate-dashboard', 'marketplace-web'
      )
      AND source_surface <> target_surface
    ),
  CONSTRAINT chk_auth_session_handoffs_origins
    CHECK (
      btrim(source_public_origin) <> ''
      AND btrim(target_public_origin) <> ''
    ),
  CONSTRAINT chk_auth_session_handoffs_sealed_session
    CHECK (
      (consumed_at IS NULL AND sealed_session IS NOT NULL AND btrim(sealed_session) <> '')
      OR (consumed_at IS NOT NULL AND sealed_session IS NULL)
    ),
  CONSTRAINT chk_auth_session_handoffs_target_path
    CHECK (
      target_path LIKE '/%'
      AND target_path NOT LIKE '//%'
      AND position(chr(92) IN target_path) = 0
    ),
  CONSTRAINT chk_auth_session_handoffs_routing_hints
    CHECK (jsonb_typeof(routing_hints) = 'object'),
  CONSTRAINT chk_auth_session_handoffs_dates
    CHECK (
      expires_at > created_at
      AND ((redemption_id IS NULL) = (redemption_started_at IS NULL))
      AND (redemption_started_at IS NULL OR redemption_started_at >= created_at)
      AND (consumed_at IS NULL OR consumed_at >= created_at)
    )
);

CREATE INDEX idx_auth_session_handoffs_expiry
  ON identity.auth_session_handoffs (expires_at)
  WHERE consumed_at IS NULL;
