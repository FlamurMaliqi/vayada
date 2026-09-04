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

## Offer matching criteria

Offer create/update accepts optional `matchingCriteria`; authenticated offer
reads always return it. The versioned v1 document contains:

- `primaryCampaignGoal`: `ugc_asset_creation`, `awareness`, `direct_bookings`,
  `affiliate_conversion`, `seasonal_demand`, `other`, or `null`;
- an exact or flexible inclusive availability range, its
  `required`/`preferred` level, and ordered non-overlapping blackout ranges;
- required/preferred content-category and content-style code selections;
- usage channels and either a fixed 1–3650 day term or perpetual usage;
- included revision rounds, expected effort range, and estimated compensation
  value/currency;
- whether applications are accepted and an optional active-application limit.

Content and usage codes are stable lowercase `snake_case` product codes, not
free-form copy. All keys are required inside a supplied document; unknown
answers are represented by `null`, not an inferred default. `matchingCriteria:
null` deletes the document. An absent field on the enclosing create/update
request leaves legacy behavior unchanged.

Offer deliverables expose optional `requirementLevel`, compensation options
expose optional `followerRequirementLevel`, and creator requirements expose
optional platform, country, and creator-type requirement levels. The only
levels are `required` and `preferred`; `null` means legacy/unknown. A migration
does not turn an existing value into a mandatory filter.

The criteria document, requirement levels, contract version, revision, and
update timestamp are owner-visible. Every create or matching-affecting update,
including criteria deletion, writes a transactional internal product-audit
event with actor and request metadata. Those audit details are never returned.
Matching criteria are not added to the public discovery projection by this
contract; VAY-1413 decides which public-safe facts or reason codes may be shown.

Date ranges use valid `YYYY-MM-DD` dates. Blackouts must fall inside the main
range and may not overlap. Required selections cannot be empty. Effort ranges,
capacity, follower requirements, deliverable platforms, and compensation
currency must be internally consistent. A follower requirement must identify at
least one platform. Update validation merges omitted fields from the stored
offer, so a partial request cannot bypass cross-field checks. Audience
age/gender requirement levels remain unavailable in this MVP, as required by
the matching contract.

## Offer ownership

An offer belongs to one property and contains only:

- title and summary;
- requested deliverables;
- compensation options and limits;
- creator requirements;
- the optional versioned offer matching-criteria document and explicit
  required/preferred flags;
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
