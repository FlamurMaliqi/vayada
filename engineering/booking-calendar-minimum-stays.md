# Booking calendar minimum stays — VAY-700

Target-only extension of `public-bookability.v1`, following
[the backend domain boundaries](typescript-backend-structure.md).

The public calendar adds `validCheckOutsByArrival`: dates verified within the
requested coverage using a single public offer, room type, rate plan and currency
for all occupied nights. The checkout date does not consume inventory.
Arrival min/max restrictions match `loadTargetCheckoutOffer` in the TypeScript
checkout adapter. Only fresh, publicly sellable nights with inventory participate;
the existing property-local same-day policy remains authoritative.

`minStayByArrival` is the shortest valid stay when one exists, otherwise the
lowest available arrival restriction. Missing nights fail closed. The calendar
loads an additional month for stays crossing the displayed month boundary and
explains when no valid stay exists in loaded coverage. Navigating reloads the
coverage including the selected arrival. Final quotes still validate occupancy,
price, payment readiness and live availability; calendar guidance is not a hold.

The optional new field permits rolling deployment. Without it the frontend
retains the previous calendar selection behavior.
