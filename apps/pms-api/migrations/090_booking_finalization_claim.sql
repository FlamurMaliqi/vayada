-- Serialize booking acceptance across browser, webhook, and host actions.
-- The start/completion checkpoints remain as audit markers; the active token
-- is cleared after success or failure so later retries can recover safely.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS finalization_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finalization_token UUID,
    ADD COLUMN IF NOT EXISTS finalization_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS guest_confirmation_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS host_confirmation_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ari_handoff_completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS booking_notification_deliveries (
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (booking_id, notification_type, recipient_email)
);

-- Existing confirmed bookings completed through the legacy path before these
-- delivery checkpoints existed. Do not replay their historical notifications.
UPDATE bookings
SET finalization_completed_at = COALESCE(finalization_completed_at, updated_at)
WHERE status = 'confirmed';
