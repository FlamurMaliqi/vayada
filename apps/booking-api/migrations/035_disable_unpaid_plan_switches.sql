-- VAY-1084: plan changes are now driven by paid Stripe subscriptions.
-- Clear legacy calendar-month switches so they cannot activate without payment.
UPDATE booking_hotels
SET billing_pending_switch = NULL,
    billing_switch_effective_date = NULL
WHERE billing_pending_switch IS NOT NULL
   OR billing_switch_effective_date IS NOT NULL;
