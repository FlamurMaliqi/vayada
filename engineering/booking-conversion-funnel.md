# Booking conversion funnel — VAY-1034

Target contract for [VAY-1034](https://linear.app/vayadacom/issue/VAY-1034), extending
VAY-1284 and `typescript-backend-structure.md`. No legacy event backfill or forwarding.

- Reuse property-scoped `platform.domain_events`, `booking_web.*` events and
  the existing public telemetry sink. Browser events are analytics evidence,
  never payment authority. No guest or card details are included.
- New events carry `funnelVersion: 1`, a session ID, an occurrence UUID and a
  positive session sequence. Sequence preserves interaction order even when
  concurrent network requests arrive out of order. Unversioned history is excluded.
- Count each session once at each stage, only after its preceding stage. All
  evidence must occur inside the inclusive property-local requested dates (at
  most 31 days). No inferred steps for deep links or historical partial sessions.
- Stages: page_visit, room_viewed, rate_selected, addons_step_passed,
  details_completed, complete_booking_clicked, payment_authorized, booking_completed.
  Add-ons are shown only when enabled and active public add-ons exist.
- First valid Complete Booking click selects the session's payment branch.
  Matching subsequent authorization/completion evidence advances that branch;
  retries and repeated visits do not inflate counts. A changed payment method
  starts a new branch attempt while preserving the session's earlier stages.
- Authorization is a card-only branch row: count actual authorizations and divide
  by card clicks. Non-card methods bypass this row. Completion divides by the
  reunited eligible cohort (authorized cards plus submitted non-card sessions).
  The UI labels these denominators explicitly rather than calling non-card guests
  authorized or displaying a misleading all-method authorization percentage.
- Every row includes percent of visits and conversion from its eligible previous
  stage; an empty denominator returns null, displayed as an em dash. Highlight
  the single largest proportional loss with a nonzero denominator (earliest tie).
- Payment method counts are unique sessions at Complete Booking, displayed as a
  split, not another stage. Support the target's card, bank_transfer,
  pay_at_property, xendit and paypal methods.
- Exclude bot/test event markers from VAY-1284 and properties classified as test
  or demo by Platform Admin (`profile_status` other than `complete`).
- Protected GET `/api/booking/properties/:propertyId/dashboard/conversion-funnel`
  accepts `windowStart`/`windowEnd` dates and returns `{contractVersion, propertyId,
funnel}`. Reuse Booking dashboard permission, entitlement and canonical-property
  scope policy. Return 404 for unknown properties and fail closed on missing IANA
  timezone. Currency does not participate.
- Roll out as a stack: domain contract/read model, target repository/API,
  booking-flow instrumentation, dashboard presentation. Existing timeline totals
  count page occurrences; the funnel counts distinct sequential sessions and is
  intentionally not the timeline's raw page-view total.
