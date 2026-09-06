-- VAY-1279: private, actor-bound previews; no public booking lookup access.
CREATE TABLE booking.host_action_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL,
  guest_booking_id UUID NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  booking_revision TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('edit_dates','reject','cancel')),
  request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  impact JSONB NOT NULL CHECK (jsonb_typeof(impact) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  FOREIGN KEY (guest_booking_id, property_id) REFERENCES booking.guest_bookings(id, property_id)
);
CREATE INDEX host_action_previews_booking ON booking.host_action_previews(property_id, guest_booking_id);
