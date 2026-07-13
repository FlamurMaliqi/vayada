# Marketplace hotel self-service

Marketplace hotel setup is property-scoped. The hotel catalog owns hotel facts;
Marketplace owns the hotel profile and collaboration offers.

## Current target routes

`GET /api/marketplace/hotels/me/profile-status` requires a hotel-group request
context, `marketplace.profile.manage`, and an active hotel-profile resource link.

```ts
type HotelProfileStatusResponse = {
  profile_complete: boolean;
  missing_fields: string[];
  has_defaults: { location: boolean };
  missing_offers: boolean;
  completion_steps: string[];
};
```

An active, non-archived `marketplace_offer` satisfies the Marketplace offer
step. The route no longer calls it a property listing.

The signed-in hotel editor uses the selected canonical property:

- `GET/PUT /api/marketplace/properties/:propertyId/profile`
- `GET/POST /api/marketplace/properties/:propertyId/offers`
- `PUT/DELETE /api/marketplace/properties/:propertyId/offers/:offerId`

Profile writes accept only Marketplace-owned pitch and collaboration guidance.
The shared hotel setup API owns canonical hotel facts and media.

## Offer ownership

An offer belongs to one property and contains only:

- title and summary;
- requested deliverables;
- compensation options and limits;
- creator requirements;
- Marketplace lifecycle state.

Name, classification, address, public descriptions, contact channels, and hotel
media come from `hotel_catalog`. Offer writes must not accept or persist those
fields.

Existing migrated values in `marketplace_offers.accommodation_type`,
`raw_location_text`, and `image_urls` are compatibility evidence only. The
shared hotel setup projection may consume them during migration fallback, but
new offer APIs never expose or write them.

## Authorization

Hotel-side offer reads and mutations require an active resource link:

```ts
{
  product: "marketplace",
  resourceType: "marketplace_offer",
  resourceId: offer.id,
  relationship: "owner" | "operator"
}
```

Create is authorized through the parent hotel profile because the offer does
not exist yet. Target-native `marketplace_offers.id` is the API `offerId`.

## Compatibility client

The regular hotel editor retains its legacy in-process TypeScript names while
calling the target offer routes above. Its adapter maps the existing form into
offer terminology and sends location and gallery changes to the canonical
property profile. It does not expose or write the migrated compatibility
columns on `marketplace_offers`.
