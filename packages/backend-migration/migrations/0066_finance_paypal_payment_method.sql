ALTER TABLE finance.payment_settings
  DROP CONSTRAINT chk_finance_payment_settings_accepted_methods;

ALTER TABLE finance.payment_settings
  ADD CONSTRAINT chk_finance_payment_settings_accepted_methods
  CHECK (
    accepted_methods <@ ARRAY[
      'card', 'pay_at_property', 'xendit', 'cash',
      'bank_transfer', 'paypal', 'manual_card', 'wallet', 'other'
    ]::TEXT[]
  );

ALTER TABLE finance.payments
  DROP CONSTRAINT payments_payment_method_check;

ALTER TABLE finance.payments
  ADD CONSTRAINT payments_payment_method_check
  CHECK (
    payment_method IN (
      'card', 'pay_at_property', 'xendit', 'bank_transfer', 'paypal',
      'wallet', 'cash', 'manual_card', 'other', 'unknown'
    )
  );

ALTER TABLE distribution.public_room_offer_snapshots
  DROP CONSTRAINT chk_distribution_room_offer_snapshots_payment_options;

ALTER TABLE distribution.public_room_offer_snapshots
  ADD CONSTRAINT chk_distribution_room_offer_snapshots_payment_options
  CHECK (
    payment_options <@ ARRAY[
      'card', 'pay_at_property', 'xendit', 'cash',
      'bank_transfer', 'paypal', 'manual_card', 'wallet', 'other'
    ]::TEXT[]
  );
