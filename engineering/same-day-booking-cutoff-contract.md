# Same-day booking cutoff contract

Status: canonical target contract for VAY-1282.

## Ownership and storage

- Booking owns the property-level policy in `booking.same_day_booking_policies`.
- Hotel Catalog owns the property's canonical IANA timezone in
  `hotel_catalog.property_locations.timezone`.
- PMS exposes the host setting and Distribution consumes policy-change events;
  neither owns a second copy of the policy.

## Policy semantics

The effective default is `{ enabled: true, cutoffLocalTime: "18:00" }`, matching
legacy properties that never changed the setting. `cutoffLocalTime` is either
null or a local `HH:mm` value on a 30-minute boundary.

For a stay whose check-in date is the property's current local date:

- `enabled: false` makes the stay ineligible for direct booking.
- `enabled: true` with a null cutoff leaves the stay eligible all day.
- `enabled: true` with a cutoff leaves the stay eligible before the cutoff and
  makes it ineligible at or after the cutoff.

The comparison is minute-precise in the canonical property timezone. This
means an `18:00` cutoff is closed at exactly `18:00`, including across daylight
saving changes. Other stay dates are unaffected by this policy.

## Enforcement and propagation

Calendar, public offer quotes, checkout quotes, and final booking creation all
evaluate the same policy contract. Final creation re-evaluates the current
policy so a quote issued before cutoff cannot be accepted after cutoff.

Settings writes are idempotent and emit a durable Distribution outbox event.
Properties with an active Channex connection also receive a retryable,
dead-lettered management job. The Channex adapter maps the enabled timed policy
to the provider's same-day cutoff fields, maps a disabled policy to a persistent
one-day cutoff, and applies the direct-booking result to same-day ARI availability.

## Migration

Legacy `pms.hotels.same_day_bookings_enabled` and
`same_day_booking_cutoff_time` map one-to-one into the Booking-owned policy.
Missing legacy fields use the effective legacy defaults above. Migration
provenance preserves newer target edits and makes repeated migration runs
idempotent.
