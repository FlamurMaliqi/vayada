-- VAY-1466. Lifecycle writes advance independently of immutable encryption revision.
ALTER TABLE finance.bank_transfer_destinations
  ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0);
UPDATE finance.bank_transfer_destinations SET state_version = revision;
