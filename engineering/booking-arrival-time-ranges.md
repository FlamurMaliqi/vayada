# Booking arrival and departure windows — VAY-1283

This extends the two local times in the VAY-1066 guest-policy contract and the
Arrival and departure section of `hotel-onboarding-information-inventory.md`.
Booking remains the canonical owner. PMS uses the existing guest-policy
GET/preview/PUT boundary, expected revision, source fingerprint, confirmation,
immutable revision, audit and outbox. Catalog remains a public projection.

`checkInTime` retains its meaning: guests can check in from this local time.
`checkOutTime` retains its meaning: guests must check out by this local time.
Optional `checkInUntil` and `checkOutFrom` bound the respective same-day windows.
Absent bounds mean from-only check-in and by-only check-out, as before. No
missing bound is defaulted or inferred. Supplied bounds must be HH:MM and strictly
ordered within their own window; overnight windows are not represented by this
contract. Never compare arrival and departure times against each other.
The property's canonical IANA timezone applies; no UTC fallback is allowed.

Optional keys are omitted, not inserted into historical bundles. Existing
immutable revisions, hashes, confirmations and publication snapshots retain
exactly their previous interpretation. New bounds participate in the bundle hash
and command fingerprint, so changing a window requires policy confirmation.

Legacy nonempty check_in_from/check_out_until take precedence over the old
single-time values; check_in_until/check_out_from are optional bounds. Invalid or
incomplete source windows block migration rather than silently dropping values.
Migration cannot overwrite a newer target-owned policy or synthesize the other
choices needed for a confirmed Booking policy.

PMS loads the canonical policy and preserves its other choices. Where no policy
exists, the setup draft prefills stored Catalog arrival values, while language
and child policy require explicit choices. Initial confirmation uses expected
revision zero through the same Booking command. No arrival default is invented.
Missing owner evidence blocks confirmation. Equal-timestamp migration replays may
recover arrival values only for migration-owned rows without target edits or
unrelated policy differences.
Saving a working revision does not rewrite an immutable public snapshot. Guest
publication must follow the existing publication flow and report pending status
until the selected revision is published.
