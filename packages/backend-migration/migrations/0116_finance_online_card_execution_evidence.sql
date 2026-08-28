-- Migration: 0116_finance_online_card_execution_evidence
-- Owner: domain-finance; see VAY-1345 and ONB-25A

ALTER TABLE finance.payment_provider_accounts
  ADD COLUMN card_capability_revision BIGINT NOT NULL DEFAULT 0
    CHECK (card_capability_revision BETWEEN 0 AND 2147483647);

ALTER TABLE finance.payment_settings
  ADD COLUMN online_card_readiness_revision BIGINT NOT NULL DEFAULT 1
    CHECK (online_card_readiness_revision BETWEEN 1 AND 2147483647);

-- Existing real property-scoped Stripe rows already represent one observed
-- provider state. Seed that state so an unchanged first reconciliation cannot
-- leave an otherwise valid account permanently unable to accept evidence.
UPDATE finance.payment_provider_accounts
SET card_capability_revision = 1
WHERE account_scope = 'property'
  AND provider = 'stripe'
  AND provider_account_id IS NOT NULL
  AND provider_account_id NOT LIKE 'settings-choice:%';

-- Execution evidence is valid only for the exact external provider binding
-- and canonical capability tuple. Every writer shares this trigger so no
-- alternate Finance path can preserve evidence across a readiness change.
CREATE FUNCTION finance.bump_card_capability_revision_for_readiness_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.card_capability_revision >= 2147483647 THEN
    RAISE EXCEPTION 'Stripe capability revision is exhausted' USING ERRCODE = '22003';
  END IF;
  NEW.card_capability_revision := OLD.card_capability_revision + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_provider_account_readiness_revision
  BEFORE UPDATE OF provider_account_id, account_scope, provider, property_id,
    status, onboarding_status, charges_enabled, payouts_enabled, capabilities,
    account_metadata
  ON finance.payment_provider_accounts
  FOR EACH ROW
  WHEN (
    OLD.provider_account_id IS DISTINCT FROM NEW.provider_account_id
    OR OLD.account_scope IS DISTINCT FROM NEW.account_scope
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.property_id IS DISTINCT FROM NEW.property_id
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.onboarding_status IS DISTINCT FROM NEW.onboarding_status
    OR OLD.charges_enabled IS DISTINCT FROM NEW.charges_enabled
    OR OLD.payouts_enabled IS DISTINCT FROM NEW.payouts_enabled
    OR (OLD.capabilities @> ARRAY['card_payments']::TEXT[])
      IS DISTINCT FROM (NEW.capabilities @> ARRAY['card_payments']::TEXT[])
    OR COALESCE(OLD.account_metadata ->> 'detailsSubmitted', 'false')
      IS DISTINCT FROM COALESCE(NEW.account_metadata ->> 'detailsSubmitted', 'false')
    OR OLD.account_metadata ->> 'cardPaymentsStatus'
      IS DISTINCT FROM NEW.account_metadata ->> 'cardPaymentsStatus'
  )
  EXECUTE FUNCTION finance.bump_card_capability_revision_for_readiness_change();

-- Evidence also belongs to the exact property-side gate inputs. Advancing this
-- revision prevents deselecting/reselecting card, changing currency, disabling
-- payments, or rebinding the account from resurrecting an obsolete ONB-25A run.
CREATE FUNCTION finance.bump_online_card_readiness_revision_for_settings_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.online_card_readiness_revision >= 2147483647 THEN
    RAISE EXCEPTION 'Online-card readiness revision is exhausted' USING ERRCODE = '22003';
  END IF;
  NEW.online_card_readiness_revision := OLD.online_card_readiness_revision + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_payment_settings_online_card_readiness_revision
  BEFORE UPDATE OF payment_readiness_contract_version, payment_methods_revision,
    payments_enabled, accepted_methods, default_currency, provider_account_id
  ON finance.payment_settings
  FOR EACH ROW
  WHEN (
    OLD.payment_readiness_contract_version IS DISTINCT FROM NEW.payment_readiness_contract_version
    OR OLD.payment_methods_revision IS DISTINCT FROM NEW.payment_methods_revision
    OR OLD.payments_enabled IS DISTINCT FROM NEW.payments_enabled
    OR OLD.accepted_methods IS DISTINCT FROM NEW.accepted_methods
    OR OLD.default_currency IS DISTINCT FROM NEW.default_currency
    OR OLD.provider_account_id IS DISTINCT FROM NEW.provider_account_id
  )
  EXECUTE FUNCTION finance.bump_online_card_readiness_revision_for_settings_change();

CREATE TABLE finance.online_card_execution_evidence (
  id                           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id                  UUID        NOT NULL,
  provider_account_id          UUID        NOT NULL,
  contract_version             TEXT        NOT NULL
    CHECK (contract_version = 'finance-online-card-execution-evidence.v1'),
  test_suite                   TEXT        NOT NULL CHECK (test_suite = 'onb-25a'),
  provider_capability_revision BIGINT      NOT NULL
    CHECK (provider_capability_revision BETWEEN 1 AND 2147483647),
  property_readiness_revision  BIGINT      NOT NULL
    CHECK (property_readiness_revision BETWEEN 1 AND 2147483647),
  evidence_fingerprint_hash    CHAR(64)    NOT NULL
    CHECK (evidence_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  executed_at                  TIMESTAMPTZ NOT NULL,
  accepted_at                  TIMESTAMPTZ NOT NULL,
  accepted_by_organization_id  UUID        NOT NULL REFERENCES identity.organizations(id),
  accepted_by_user_id          UUID        NOT NULL REFERENCES identity.users(id),
  revoked_at                   TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_online_card_execution_evidence_account
    FOREIGN KEY (provider_account_id, property_id)
    REFERENCES finance.payment_provider_accounts(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT uq_finance_online_card_execution_evidence_source
    UNIQUE (provider_account_id, evidence_fingerprint_hash),
  CONSTRAINT chk_finance_online_card_execution_evidence_times
    CHECK (
      executed_at <= accepted_at
      AND (revoked_at IS NULL OR revoked_at >= accepted_at)
    )
);

CREATE UNIQUE INDEX uq_finance_online_card_execution_evidence_current
  ON finance.online_card_execution_evidence (provider_account_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_finance_online_card_execution_evidence_property
  ON finance.online_card_execution_evidence (property_id, provider_account_id, accepted_at DESC);

CREATE FUNCTION finance.protect_online_card_execution_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Online-card execution evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.id,
    NEW.property_id,
    NEW.provider_account_id,
    NEW.contract_version,
    NEW.test_suite,
    NEW.provider_capability_revision,
    NEW.property_readiness_revision,
    NEW.evidence_fingerprint_hash,
    NEW.executed_at,
    NEW.accepted_at,
    NEW.accepted_by_organization_id,
    NEW.accepted_by_user_id,
    NEW.created_at
  ) IS DISTINCT FROM (
    OLD.id,
    OLD.property_id,
    OLD.provider_account_id,
    OLD.contract_version,
    OLD.test_suite,
    OLD.provider_capability_revision,
    OLD.property_readiness_revision,
    OLD.evidence_fingerprint_hash,
    OLD.executed_at,
    OLD.accepted_at,
    OLD.accepted_by_organization_id,
    OLD.accepted_by_user_id,
    OLD.created_at
  ) OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Online-card execution evidence is immutable except for one-way revocation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_online_card_execution_evidence_rows
  BEFORE UPDATE OR DELETE ON finance.online_card_execution_evidence
  FOR EACH ROW EXECUTE FUNCTION finance.protect_online_card_execution_evidence();

CREATE TRIGGER trg_finance_online_card_execution_evidence_truncate
  BEFORE TRUNCATE ON finance.online_card_execution_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE VIEW finance.online_card_readiness AS
SELECT
  settings.property_id,
  account.id AS provider_account_id,
  account.provider,
  account.account_scope,
  (
    account.provider_account_id IS NOT NULL
    AND account.provider_account_id NOT LIKE 'settings-choice:%'
  ) AS provider_binding_active,
  account.status AS provider_status,
  account.onboarding_status AS provider_onboarding_status,
  account.charges_enabled,
  account.payouts_enabled,
  COALESCE(account.account_metadata ->> 'detailsSubmitted' = 'true', FALSE)
    AS details_submitted,
  account.account_metadata ->> 'cardPaymentsStatus' AS card_payments_status,
  account.capabilities,
  account.card_capability_revision,
  settings.online_card_readiness_revision AS property_readiness_revision,
  COALESCE(
    upper(trim(settings.default_currency)) NOT IN ('BHD', 'JOD', 'KWD', 'OMR', 'TND'),
    FALSE
  ) AS currency_eligible,
  evidence.id AS execution_evidence_id,
  evidence.contract_version AS execution_evidence_contract_version,
  evidence.provider_account_id AS execution_evidence_provider_account_id,
  evidence.provider_capability_revision AS execution_evidence_capability_revision,
  evidence.property_readiness_revision AS execution_evidence_property_readiness_revision,
  evidence.accepted_at AS execution_evidence_accepted_at,
  evidence.revoked_at AS execution_evidence_revoked_at,
  COALESCE(
    settings.payment_readiness_contract_version = 'finance-payment-readiness.v1'
      AND settings.payment_methods_revision IS NOT NULL
      AND settings.payments_enabled
      AND 'card' = ANY(settings.accepted_methods)
      AND upper(trim(settings.default_currency)) NOT IN ('BHD', 'JOD', 'KWD', 'OMR', 'TND')
      AND account.account_scope = 'property'
      AND account.provider = 'stripe'
      AND account.provider_account_id IS NOT NULL
      AND account.provider_account_id NOT LIKE 'settings-choice:%'
      AND account.status = 'active'
      AND account.onboarding_status = 'completed'
      AND account.charges_enabled
      AND account.payouts_enabled
      AND account.account_metadata ->> 'detailsSubmitted' = 'true'
      AND account.account_metadata ->> 'cardPaymentsStatus' = 'active'
      AND account.capabilities @> ARRAY['card_payments']::TEXT[]
      AND account.card_capability_revision > 0
      AND evidence.contract_version = 'finance-online-card-execution-evidence.v1'
      AND evidence.test_suite = 'onb-25a'
      AND evidence.provider_capability_revision = account.card_capability_revision
      AND evidence.property_readiness_revision = settings.online_card_readiness_revision
      AND evidence.revoked_at IS NULL,
    FALSE
  ) AS online_card_ready
FROM finance.payment_settings settings
LEFT JOIN finance.payment_provider_accounts account
  ON account.id = settings.provider_account_id
 AND account.property_id = settings.property_id
LEFT JOIN LATERAL (
  SELECT current_evidence.*
  FROM finance.online_card_execution_evidence current_evidence
  WHERE current_evidence.property_id = settings.property_id
    AND current_evidence.provider_account_id = account.id
    AND current_evidence.revoked_at IS NULL
  LIMIT 1
) evidence ON TRUE;

COMMENT ON TABLE finance.online_card_execution_evidence IS
  'Secret-safe acceptance of an ONB-25A test suite for one exact Stripe capability revision.';
COMMENT ON VIEW finance.online_card_readiness IS
  'Finance-owned online-card release predicate consumed by setup and public projections.';
