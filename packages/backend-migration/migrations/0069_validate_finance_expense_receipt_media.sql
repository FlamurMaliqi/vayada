-- Migration: 0069_validate_finance_expense_receipt_media
-- Owner: platform-media, domain-finance

ALTER TABLE platform.media_objects
  VALIDATE CONSTRAINT chk_platform_media_objects_resource_product;
ALTER TABLE platform.media_objects
  VALIDATE CONSTRAINT chk_platform_media_objects_finance_expense_receipt;
ALTER TABLE platform.media_upload_sessions
  VALIDATE CONSTRAINT chk_platform_media_upload_sessions_resource_product;
ALTER TABLE platform.media_upload_sessions
  VALIDATE CONSTRAINT chk_platform_media_upload_sessions_finance_expense_receipt;
