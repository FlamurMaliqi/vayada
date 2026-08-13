# Booking acceptance mode contract

_VAY-1274 target contract. Builds on the Booking/PMS boundary, public
bookability contract, and target checkout schema._

## Decision

Booking owns one canonical `acceptanceMode` setting with two values:

- `instant`: supported card and pay-at-property bookings confirm without a
  property decision;
- `request`: supported card and pay-at-property bookings reserve inventory and
  wait for a property decision.

`booking.booking_settings.acceptance_mode` is authoritative. PMS exposes a
property-scoped read/write control through a typed Booking settings port; PMS
does not own or duplicate the value.

Bank transfer remains pending for manual review in both modes. PayPal keeps its
existing manual-payment lifecycle until a separate contract changes it.

## Public projection and checkout snapshot

Distribution publishes `capabilities.instantBook` as
`acceptance_mode = 'instant'`. Sellable inventory continues to determine
availability/readiness, but never the acceptance policy. A request-mode
property with fresh sellable inventory and a supported payment method remains
publicly bookable.

Quote creation freezes `acceptanceMode` in the Booking-owned quote snapshot.
Booking creation and payment orchestration use only that frozen value. A later
settings update may affect new quotes and the public profile, but cannot change
an active quote or its booking lifecycle.

## Payment and reservation behavior

| Payment method  | `instant`                            | `request`                                                            |
| --------------- | ------------------------------------ | -------------------------------------------------------------------- |
| Card            | automatic capture, then confirmed    | manual capture authorization; capture and confirm only on acceptance |
| Pay at property | confirmed                            | pending property review                                              |
| Bank transfer   | pending manual review                | pending manual review                                                |
| PayPal          | existing pending manual-payment flow | existing pending manual-payment flow                                 |

Inventory is reserved atomically when the booking is created in every mode.
Pending requests retain the same reservation receipt and release guarantees as
confirmed bookings. Stripe capture is idempotent so a retry can finish the
database transition after a provider-side capture without charging twice.

Request-mode card and pay-at-property bookings retain the legacy 24-hour host
response window, frozen as `hostResponseDeadlineAt` on the booking. The Booking
lifecycle sweep releases inventory only after that deadline. For an authorized
card it first reconciles Stripe: a still-capturable authorization is canceled
idempotently and Finance is terminalized; an already-captured race is settled
and confirmed; an unavailable or indeterminate provider response leaves the
booking and inventory unchanged for retry.

## Migration

The legacy `instant_book` boolean maps `true` to `instant` and `false` to
`request`. Existing target-only rows default to `instant`, preserving the
pre-contract target behavior. A missing legacy field also falls back to
`instant`; explicit legacy values always win during backfill.

## Scope boundaries

This contract does not change legacy Python services and does not add booking
emails or host notifications. Notification delivery remains owned by VAY-1275.
