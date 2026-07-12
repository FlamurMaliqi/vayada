# Marketplace discovery contract

Public discovery exposes collaboration offers and creators. It does not expose a
second hotel listing model.

## Routes

| Resource | Route                           | Client                                                     |
| -------- | ------------------------------- | ---------------------------------------------------------- |
| Offers   | `GET /api/marketplace/offers`   | `getMarketplaceOffers()` / `getAllMarketplaceOffers()`     |
| Creators | `GET /api/marketplace/creators` | `getMarketplaceCreators()` / `getAllMarketplaceCreators()` |

Both routes accept `limit` and `offset`, return `{ items, pagination }`, clamp
numeric values to supported bounds, and reject invalid or duplicated query
parameters with `400 invalid_query`.

## Offer response

```ts
type MarketplaceOfferReadModel = {
  offerId: string;
  offerPublicId: string;
  offerTitle: string;
  offerSummary: string | null;
  hotelName: string;
  hotelSlug: string;
  hotelAccommodationType: string | null;
  hotelLocation: {
    displayText: string;
    countryCode?: string;
    city?: string;
  };
  hotelCoverImageUrl: string | null;
  hotelImageUrls: string[];
  deliverables: MarketplaceOfferDeliverable[];
  compensationOptions: MarketplaceCompensationOptionSummary[];
  creatorRequirements: MarketplaceCreatorRequirements | null;
  createdAt: string;
  projectedAt: string;
};
```

Offer identity, title, summary, deliverables, compensation options, and
creator requirements come from Marketplace-owned tables. Hotel name, slug,
location, and media come from `hotel_catalog.property_public_profile_read_model`;
accommodation type comes from `hotel_catalog.properties`. These hotel facts are
never copied from the offer row.

`offerId` is the target `marketplace.marketplace_offers.id`. Source migration
IDs remain migration provenance and are not the public API identity.

## Visibility and privacy

The offer query reads `marketplace.marketplace_offer_read_model` rows with
`visibility_status = 'public'` and requires a matching canonical public hotel
profile. Public JSON must not contain private identity, contact, negotiated
terms, source IDs, precise geo data, or affiliate-link fields.

Default offer ordering is `createdAt DESC, offerId ASC`. Creator behavior and
privacy rules remain unchanged.

## Compatibility

Marketplace web, landing, and Vayada admin temporarily adapt this offer response
into their older hotel-card view models. Those adapters may use legacy field
names internally, but all network calls and shared client types use the offer
contract above. The retired `/api/marketplace/listings` route is not mounted.

Fixture coverage lives in
`engineering/fixtures/marketplace-discovery/cases.json`.
