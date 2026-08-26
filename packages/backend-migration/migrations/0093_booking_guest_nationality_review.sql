-- VAY-637 expand step: reserve raw/manual-review evidence without changing live writer semantics.

ALTER TABLE booking.booking_guests
  ADD COLUMN country_code_raw TEXT,
  ADD COLUMN country_code_review_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT chk_booking_guests_country_review_evidence
    CHECK (
      (
        country_code_review_required = FALSE
        AND country_code_raw IS NULL
      )
      OR (
        country_code_review_required = TRUE
        AND country_code IS NULL
        AND NULLIF(BTRIM(country_code_raw), '') IS NOT NULL
      )
    ) NOT VALID;
