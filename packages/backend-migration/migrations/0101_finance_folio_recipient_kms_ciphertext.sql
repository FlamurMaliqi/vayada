-- Owner: domain-finance. AWS KMS Decrypt accepts CiphertextBlob values up to 6,144 bytes.

ALTER TABLE finance.folio_revisions
  ADD CONSTRAINT chk_finance_folio_revisions_recipient_kms_ciphertext
  CHECK (octet_length(recipient_snapshot_ciphertext) BETWEEN 29 AND 6144) NOT VALID;
