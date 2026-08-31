-- Migration: 0128_channex_binding_claims
-- Owner: domain-pms; see engineering/channex-property-adoption-proof-contract.md, VAY-1366
SET LOCAL lock_timeout = '5s';
LOCK TABLE pms.channel_connections IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE pms.channel_binding_claims (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  provider              TEXT        NOT NULL CHECK (provider = 'channex'),
  external_property_id  TEXT        NOT NULL CHECK (btrim(external_property_id) <> ''),
  claim_state           TEXT        NOT NULL CHECK (claim_state IN ('historical', 'verified_non_active', 'active', 'released')),
  claim_source          TEXT        NOT NULL CHECK (claim_source IN ('migration', 'enable', 'adoption', 'repair')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_channel_binding_claims_property_provider UNIQUE (property_id, provider),
  CONSTRAINT uq_pms_channel_binding_claims_provider_external UNIQUE (provider, external_property_id)
);
INSERT INTO pms.channel_binding_claims (property_id, provider, external_property_id, claim_state, claim_source, created_at, updated_at)
SELECT property_id, provider, external_property_id, CASE WHEN connection_metadata ->> 'migrationRunId' ~ '^vay1351-[0-9a-f]{24}$' THEN 'active' ELSE 'historical' END, 'migration', created_at, updated_at FROM pms.channel_connections
WHERE provider = 'channex' AND external_property_id IS NOT NULL;
-- Retain every identity in the registry; only immutable production-migration evidence preserves the live connection.
UPDATE pms.channel_connections
SET external_property_id = NULL, connection_status = 'disconnected', messaging_app_installed = FALSE, connection_metadata = connection_metadata - 'connectedChannels', updated_at = now()
WHERE provider = 'channex' AND external_property_id IS NOT NULL AND COALESCE(connection_metadata ->> 'migrationRunId', '') !~ '^vay1351-[0-9a-f]{24}$';
CREATE FUNCTION pms.enforce_channex_binding_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  matched_state TEXT;
BEGIN
  IF NEW.provider <> 'channex' OR NEW.external_property_id IS NULL THEN RETURN NEW; END IF;
  SELECT claim_state INTO matched_state FROM pms.channel_binding_claims WHERE property_id = NEW.property_id AND provider = NEW.provider
    AND external_property_id = NEW.external_property_id;
  IF matched_state IS NULL THEN
    IF EXISTS (SELECT 1 FROM pms.channel_binding_claims claim WHERE claim.provider = NEW.provider AND (claim.property_id = NEW.property_id OR claim.external_property_id = NEW.external_property_id)) THEN RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'uq_pms_channel_binding_claims_provider_external', MESSAGE = 'Channex binding is retained by an existing claim'; END IF;
    IF COALESCE(NEW.connection_metadata ->> 'migrationRunId', '') !~ '^vay1351-[0-9a-f]{24}$' THEN RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_channel_connections_active_binding_claim', MESSAGE = 'Channex connection requires an active binding claim'; END IF;
    INSERT INTO pms.channel_binding_claims (property_id, provider, external_property_id, claim_state, claim_source)
    VALUES (NEW.property_id, NEW.provider, NEW.external_property_id, 'active', 'migration') ON CONFLICT DO NOTHING;
    SELECT claim_state INTO matched_state FROM pms.channel_binding_claims WHERE property_id = NEW.property_id AND provider = NEW.provider
      AND external_property_id = NEW.external_property_id;
  END IF;
  IF matched_state IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'uq_pms_channel_binding_claims_provider_external',
      MESSAGE = 'Channex external property is reserved by another target property';
  END IF;
  IF matched_state <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_channel_connections_active_binding_claim',
      MESSAGE = 'Channex connection requires an active binding claim';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_pms_channel_connections_binding_claim
BEFORE INSERT OR UPDATE OF property_id, provider, external_property_id, connection_status ON pms.channel_connections
FOR EACH ROW EXECUTE FUNCTION pms.enforce_channex_binding_claim();
