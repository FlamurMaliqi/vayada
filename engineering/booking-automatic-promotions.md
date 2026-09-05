# Automatic Booking Engine promotions (VAY-1424)

Extends the Booking domain and target booking settings described in
`typescript-backend-structure.md`. Python services are outside this change.

The existing `booking.booking_settings.last_minute_discount` JSON document
remains the owner. An optional `promotions` array is the canonical configuration
once saved through Promos. Before that, existing enabled last-minute tiers are
read as one Last minute escape promotion without changing their windows or rates.
The legacy stackWithPromo flag is retained for compatibility but never enables
stacking in target pricing. Pausing preserves parameters; deletion removes them.

One entry per type: LAST_MINUTE, EARLY_BIRD, EXTENDED_STAY, MIDWEEK.
Room scope uses canonical room type IDs, with an empty list meaning all rooms.
Thresholds include their boundaries and lead time uses the property's local date.
Midweek applies to occupied nights only, excluding checkout. Extended-stay free
nights mean the cheapest N nights per stay (not repeated bundles). Discounts apply
to room charges after the selected rate, excluding taxes and add-ons.

V1 applies the highest single automatic discount. A valid promo code competes
with that amount using its existing eligible basis; the better deal wins, with
code winning ties. An unused code consumes no redemption. Invalid codes retain
the existing validation error. Prices and the winning named discount are frozen
in the server quote for its existing 15-minute validity and consumed by booking.
Date-based room previews and checkout use the same promotion evaluator.
