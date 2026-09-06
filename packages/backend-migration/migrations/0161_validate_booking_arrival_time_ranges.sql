-- Validate separately from the write-blocking additive ALTER in 0160.
ALTER TABLE hotel_catalog.property_policy_summaries
  VALIDATE CONSTRAINT chk_property_check_in_window;
ALTER TABLE hotel_catalog.property_policy_summaries
  VALIDATE CONSTRAINT chk_property_check_out_window;
