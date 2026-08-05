-- Migration: 0067_finance_invoice_documents; Owner: platform-media, domain-finance; see VAY-1176
CREATE OR REPLACE FUNCTION platform.valid_media_purpose_visibility(
  media_purpose TEXT,
  media_visibility TEXT
)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN media_purpose IN (
      'identity.user.profile_image', 'property.hero_image', 'property.gallery_image',
      'property.logo', 'marketplace.offer.media', 'marketplace.creator.profile_image',
      'pms.room_type.media'
    ) THEN media_visibility IN ('public', 'private')
    WHEN media_purpose IN (
      'marketplace.collaboration_chat.attachment', 'pms.messaging.attachment',
      'pms.import.source_image', 'finance.expense.receipt', 'finance.invoice.document'
    ) THEN media_visibility = 'private'
    ELSE FALSE
  END;
$$;
ALTER TABLE platform.media_objects
  DROP CONSTRAINT chk_platform_media_objects_finance_expense_receipt,
  ADD CONSTRAINT chk_platform_media_objects_finance_evidence CHECK (
    (resource_product <> 'finance'
      AND purpose NOT IN ('finance.expense.receipt', 'finance.invoice.document'))
    OR (purpose = 'finance.expense.receipt' AND resource_product = 'finance'
      AND resource_type = 'expense' AND property_id IS NOT NULL)
    OR (purpose = 'finance.invoice.document' AND resource_product = 'finance'
      AND resource_type = 'invoice_document' AND property_id IS NOT NULL
      AND resource_id IS NOT NULL AND content_type = 'application/pdf'
      AND size_bytes IS NOT NULL AND size_bytes > 0
      AND checksum_sha256 IS NOT NULL AND checksum_sha256 ~ '^[0-9a-fA-F]{64}$')
  ),
  ADD CONSTRAINT uq_platform_media_objects_invoice_document_evidence UNIQUE (
    id, property_id, purpose, resource_product, resource_type, resource_id,
    visibility, content_type, lifecycle_status
  );
ALTER TABLE platform.media_upload_sessions
  DROP CONSTRAINT chk_platform_media_upload_sessions_finance_expense_receipt,
  ADD CONSTRAINT chk_platform_media_upload_sessions_finance_evidence CHECK (
    (resource_product <> 'finance'
      AND requested_purpose NOT IN ('finance.expense.receipt', 'finance.invoice.document'))
    OR (requested_purpose = 'finance.expense.receipt' AND resource_product = 'finance'
      AND resource_type = 'expense' AND property_id IS NOT NULL)
    OR (requested_purpose = 'finance.invoice.document' AND resource_product = 'finance'
      AND resource_type = 'invoice_document' AND property_id IS NOT NULL
      AND resource_id IS NOT NULL AND expected_content_type = 'application/pdf')
  );
CREATE TABLE finance.invoice_documents (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL,
  invoice_id             UUID        NOT NULL,
  invoice_revision       BIGINT      NOT NULL,
  document_version       BIGINT      NOT NULL,
  generation_key         TEXT        NOT NULL,
  media_object_id        UUID        NOT NULL,
  media_purpose          TEXT        GENERATED ALWAYS AS ('finance.invoice.document') STORED,
  media_product          TEXT        GENERATED ALWAYS AS ('finance') STORED,
  media_resource_type    TEXT        GENERATED ALWAYS AS ('invoice_document') STORED,
  media_resource_id      TEXT        GENERATED ALWAYS AS (id::TEXT) STORED,
  media_visibility       TEXT        GENERATED ALWAYS AS ('private') STORED,
  media_content_type     TEXT        GENERATED ALWAYS AS ('application/pdf') STORED,
  media_lifecycle_status TEXT        GENERATED ALWAYS AS ('active') STORED,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_invoice_documents_invoice_version
    UNIQUE (invoice_id, document_version),
  CONSTRAINT uq_finance_invoice_documents_generation UNIQUE (property_id, generation_key),
  CONSTRAINT uq_finance_invoice_documents_media UNIQUE (media_object_id),
  CONSTRAINT chk_finance_invoice_documents_version
    CHECK (document_version BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_finance_invoice_documents_revision
    CHECK (invoice_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_finance_invoice_documents_generation CHECK (
    generation_key = btrim(generation_key) AND char_length(generation_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT fk_finance_invoice_documents_invoice_scope
    FOREIGN KEY (invoice_id, property_id)
    REFERENCES finance.invoices(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_invoice_documents_media_evidence FOREIGN KEY (
    media_object_id, property_id, media_purpose, media_product, media_resource_type,
    media_resource_id, media_visibility, media_content_type, media_lifecycle_status
  ) REFERENCES platform.media_objects (
    id, property_id, purpose, resource_product, resource_type, resource_id,
    visibility, content_type, lifecycle_status
  ) ON DELETE RESTRICT
);
CREATE FUNCTION finance.protect_invoice_document_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'invoice documents are immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM finance.invoices
  WHERE id = NEW.invoice_id AND property_id = NEW.property_id
    AND revision = NEW.invoice_revision AND status = 'issued' AND archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document requires the current issued invoice revision' USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_document_issued_revision';
  END IF;
  PERFORM 1 FROM platform.media_objects WHERE id = NEW.media_object_id FOR UPDATE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_finance_invoice_documents_protect_rows BEFORE UPDATE OR DELETE ON finance.invoice_documents FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_document_history();
CREATE TRIGGER trg_finance_invoice_documents_validate_insert AFTER INSERT ON finance.invoice_documents FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_document_history();
CREATE TRIGGER trg_finance_invoice_documents_protect_truncate BEFORE TRUNCATE ON finance.invoice_documents FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_invoice_document_history();
CREATE FUNCTION platform.protect_invoice_document_content()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance.invoice_documents WHERE media_object_id = OLD.id)
    AND ROW(NEW.storage_kind, NEW.bucket, NEW.storage_key, NEW.source_url,
      NEW.content_type, NEW.size_bytes, NEW.checksum_sha256)
      IS DISTINCT FROM ROW(OLD.storage_kind, OLD.bucket, OLD.storage_key, OLD.source_url,
        OLD.content_type, OLD.size_bytes, OLD.checksum_sha256) THEN
    RAISE EXCEPTION 'invoice document content is immutable' USING ERRCODE = '23514', CONSTRAINT = 'chk_platform_invoice_document_content_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_platform_media_protect_invoice_document_content BEFORE UPDATE ON platform.media_objects FOR EACH ROW WHEN (OLD.purpose = 'finance.invoice.document') EXECUTE FUNCTION platform.protect_invoice_document_content();
