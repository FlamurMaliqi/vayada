-- Migration: 0139_booking_header_controls
-- Owner: domain-booking
--
-- Persists the Booking Engine header controls configured in Design Studio.

ALTER TABLE booking.booking_settings
ADD COLUMN show_contact_button BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN show_refer_a_guest_button BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN show_language_selector BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN show_currency_selector BOOLEAN NOT NULL DEFAULT TRUE;
