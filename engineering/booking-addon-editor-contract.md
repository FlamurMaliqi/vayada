# VAY-902 shared add-on editor

[VAY-902](https://linear.app/vayadacom/issue/VAY-902) extends the existing target
`/api/booking/hotels/:hotelId/addon-items` contract. Architecture:
[TypeScript backend](typescript-backend-structure.md),
[PMS pricing read model](../apps/api/src/domains/pmsPricingReadModel.ts).

The existing `booking.addon_definitions.pricing_model` enum and `price_amount`
remain authoritative. The four toggle combinations already map to `per_stay`,
`per_guest`, `per_night`, and `per_guest_night`; existing target records need no
pricing conversion. This change does not touch legacy databases or APIs.

The existing metadata object gains `photos` (ordered, maximum five, exactly one
cover unless empty), `location`, `leadTime` (descriptive text), `maxGuests`
(optional positive integer), and `maxQuantity` (positive integer, default one).
The single `imageUrl`/`mediaObjectId` fields mirror the cover for compatibility.
Existing single images are projected as a one-photo gallery on read, so no
schema or destructive data migration is needed. Existing highlights and included
items remain archived in metadata; the new form never asks for them.

Writes resolve every managed image through the existing property-scoped approved
media registry. Client URLs cannot substitute for managed media. Imported image
URLs can only be retained on the original property's existing add-on. Photo order
and the cover flag persist independently. Empty galleries explicitly clear cover.

Currency is read from the PMS pricing read model, returned as `propertyCurrency`
in the list context, and inherited on price writes. Missing currency blocks saves.
Creation appends after the highest saved sort position while holding the existing
property lock. Edits and reorder operations retain their existing behavior.

Guest per-person counts retain the existing selected-adult policy, defaulting to
all adults; dates default to the stay and may be selected individually. A EUR 15
per-person-per-night breakfast for two adults and four nights costs EUR 120.
An optional `addonPackageQuantities` map carries package counts independently
of guests and dates through the quote and booking request. Max quantity limits
packages for all four models; existing requests default to one package. Lead time is descriptive copy,
not an availability cutoff rule.

The shared AddonEditor is used by Booking Flow settings and the exported
AddonsStep. Current first-run onboarding no longer mounts AddonsStep; restoring
an onboarding navigation step is a separate product decision.
