-- Owner: domain-finance. Validate after 0101's low-lock constraint installation.

ALTER TABLE finance.folio_revisions
  VALIDATE CONSTRAINT chk_finance_folio_revisions_recipient_kms_ciphertext;
