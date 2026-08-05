-- Migration: 0061_finance_expense_receipt_media
-- Owner: platform-media, domain-finance
-- See: VAY-1124, engineering/pms-financials-contracts.md

ALTER TABLE platform.media_objects
  DROP CONSTRAINT media_objects_resource_product_check,
  ADD CONSTRAINT chk_platform_media_objects_resource_product
    CHECK (resource_product IN (
      'hotel_catalog', 'booking', 'pms', 'finance', 'marketplace',
      'distribution', 'platform', 'migration'
    ));

ALTER TABLE platform.media_upload_sessions
  DROP CONSTRAINT media_upload_sessions_resource_product_check,
  ADD CONSTRAINT chk_platform_media_upload_sessions_resource_product
    CHECK (resource_product IN (
      'hotel_catalog', 'booking', 'pms', 'finance', 'marketplace',
      'distribution', 'platform', 'migration'
    ));

CREATE OR REPLACE FUNCTION platform.valid_media_purpose_visibility(
  media_purpose TEXT,
  media_visibility TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN media_purpose IN (
      'identity.user.profile_image',
      'property.hero_image',
      'property.gallery_image',
      'property.logo',
      'marketplace.offer.media',
      'marketplace.creator.profile_image',
      'pms.room_type.media'
    ) THEN media_visibility IN ('public', 'private')
    WHEN media_purpose IN (
      'marketplace.collaboration_chat.attachment',
      'pms.messaging.attachment',
      'pms.import.source_image',
      'finance.expense.receipt'
    ) THEN media_visibility = 'private'
    ELSE FALSE
  END;
$$;

ALTER TABLE platform.media_objects
  ADD CONSTRAINT chk_platform_media_objects_finance_expense_receipt
    CHECK (
      (
        purpose <> 'finance.expense.receipt'
        AND resource_product <> 'finance'
      )
      OR (
        purpose = 'finance.expense.receipt'
        AND resource_product = 'finance'
        AND resource_type = 'expense'
        AND property_id IS NOT NULL
      )
    );

ALTER TABLE platform.media_upload_sessions
  ADD CONSTRAINT chk_platform_media_upload_sessions_finance_expense_receipt
    CHECK (
      (
        requested_purpose <> 'finance.expense.receipt'
        AND resource_product <> 'finance'
      )
      OR (
        requested_purpose = 'finance.expense.receipt'
        AND resource_product = 'finance'
        AND resource_type = 'expense'
        AND property_id IS NOT NULL
      )
    );
