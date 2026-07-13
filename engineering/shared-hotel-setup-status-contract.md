# Shared Hotel Setup Status Contract

_VAY-966 contract record. Parent: VAY-965._

## Purpose

Vayada hotel users should choose the systems their hotel group uses once, then
create a small shared record for each hotel/listing. The account-level system
choice applies to every property under the hotel group; product-specific setup
collects the remaining details per property. This contract defines the shared
setup status response that those product apps use after login.

The contract deliberately models the new canonical setup world. It does not use
legacy Booking/PMS/Marketplace product links as the normal authorization or
routing source.

## Decision

Shared setup has an account-level system choice and property-centered profile
setup.

```text
hotel_group organization
-> account-scope identity.product_entitlements rows
   product IN ('booking', 'pms', 'marketplace')
   entitlement_key = product's primary access key
     booking: booking-engine
     pms: property-management
     marketplace: marketplace-hotel-profile
   resource_product/resource_type/resource_id = NULL
-> systems selected for every property/listing in the group
```

```text
hotel_group organization
-> direct identity.organization_resource_links row
   product = 'hotel_catalog'
   resource_type = 'property'
   resource_id = hotel_catalog.properties.id
-> shared setup status for that canonical property
```

Product-native records remain product-specific:

```text
Booking hotel / PMS property / Marketplace hotel profile
-> hotel_catalog.property_source_links
-> hotel_catalog.properties.id
```

`property_source_links` is provenance and product-record mapping. It is not the
authorization model for shared setup.

## Implementation Prerequisites

Before VAY-967 implements this API, identity must support the canonical hotel
catalog resource scope:

- Add `hotel_catalog` to the identity product enum used by
  `identity.organization_resource_links`, `identity.product_entitlements`, and
  `@vayada/backend-auth` `Product`.
- Ensure `property` is accepted as a resource type in identity DDL and
  `@vayada/backend-auth` `ResourceType`.
- Add `hotel_catalog.setup.read` to `@vayada/backend-auth` `PermissionKey` and
  seed `identity.permission_catalog`.
- Seed role grants for hotel-group roles that may read setup status.
- Backfill direct active property resource links for every hotel-group property
  that should appear in shared setup.

No VAY-967 route should fall back to `property_source_links` to infer ownership.
If direct property links are missing, the property is not in the status
response.

## VAY-975 Compatibility Audit

`property_source_links` remains an active provenance and product-record mapping
table. A runtime `rg "property_source_links"` audit still finds active
dependencies that are intentionally retained:

- Booking/settings and product profile routes: blocked on VAY-967 and VAY-969
  because those routes still need product-to-property mapping until the shared
  setup API and profile write path own canonical property routing.
- Migration transforms, parity checks, and smoke backfill scripts: retained by
  VAY-975 because they need source/product provenance to create direct canonical
  links during backfill and fixture rebuild.
- Product-specific Booking, PMS, and Marketplace reads/writes: out of scope for
  VAY-975 because current product tables remain active sources of truth before a
  reviewed cutover ticket removes them.

VAY-967 must authorize shared setup by reading direct active
`identity.organization_resource_links` rows for `hotel_catalog/property` under
the resolved `hotel_group` organization. If a route needs product-specific
Booking, PMS, or Marketplace state after authorization, it may use
`property_source_links` only as product provenance/mapping from an already
authorized canonical property.

## Endpoint

```http
GET /api/hotel-setup/status?entryProduct=booking&returnTo=/dashboard&propertyId=<uuid>
```

The final route adapter may choose a different prefix, but it must preserve the
response contract below.

### Query

| Field          | Type                                | Required | Notes                                                                |
| -------------- | ----------------------------------- | -------- | -------------------------------------------------------------------- |
| `entryProduct` | `booking` \| `pms` \| `marketplace` | no       | Product surface the user entered from. Defaults to server inference. |
| `returnTo`     | string                              | no       | Server validates and returns only a safe same-origin or allowed URL. |
| `propertyId`   | UUID                                | no       | Requested canonical property. Must be directly linked to the org.    |

Invalid `returnTo` values are ignored and returned as `null`. Invalid or
unauthorized `propertyId` values return a `403` or `404` from the route adapter;
they must not silently select a different property.

## Shared Property Profile Commands

VAY-969 adds the shared profile read/write path used by the first-run setup
wizard:

```http
GET  /api/hotel-setup/properties/:propertyId/profile
POST /api/hotel-setup/properties
PUT  /api/hotel-setup/properties/:propertyId/profile
```

`POST /properties` creates a canonical `hotel_catalog.properties` row and a
direct active `identity.organization_resource_links` row for the resolved
`hotel_group` organization:

```text
organization_id = selected hotel_group organization
product = 'hotel_catalog'
resource_type = 'property'
resource_id = hotel_catalog.properties.id
relationship = 'owner'
```

It must not create an organization, billing boundary, membership boundary,
permission boundary, or data boundary. Additional properties are represented as
additional canonical property rows linked to the same hotel-group organization.

`GET` and `PUT` require the selected organization to have an active direct
`hotel_catalog/property` owner or operator link for the requested property.
Write commands also require `hotel_catalog.setup.manage`: `POST /properties`
requires it for the selected hotel group, and `PUT /properties/:propertyId/profile`
requires it in addition to the direct property-link check.

Writes persist shared property facts in the canonical catalog:

- display name
- location
- public website and phone
- short and long description
- media references

Creating a property requires only the routing baseline:

- display name
- city
- two-letter country code

Website, phone, descriptions, media, rooms, rates, policies, and listing content
must not block creation of the first hotel. Product setup may collect shared
public-profile fields when they become relevant and write them back through the
same canonical profile command.

Validation failures return field-addressable `422` responses:

```ts
{
  code: "invalid_shared_property_profile";
  detail: string;
  fields: Record<string, string[]>;
}
```

Shared profile completion is computed from canonical catalog fields plus
target-side legacy-origin prefill. The setup API must not read legacy product
databases at runtime. Conflict precedence is deterministic:

1. Explicit shared setup writes in canonical `hotel_catalog` rows win.
2. Target public profile projections fill blank shared fields.
3. Target Marketplace hotel/listing rows fill remaining blanks for the selected
   hotel-group organization only.

Prefill is read-only until the user saves the shared setup wizard. Saving writes
the edited values back to canonical `hotel_catalog` rows; prefill must not
silently overwrite user-edited canonical values.

## Account System Selection Command

```http
PUT /api/hotel-setup/products
```

Body:

```json
{ "selectedProducts": ["booking", "pms", "marketplace"] }
```

This command stores the selected systems for the resolved `hotel_group`
organization as account-scope `identity.product_entitlements`, using the actual
primary access key each product route authorizes. It requires the owner-only
`hotel_catalog.products.manage` permission and does not take a `propertyId`: choosing
Marketplace, PMS, or Booking means that system is intended for every
hotel/listing in the group.

The command may activate, reactivate, or expire only entitlements marked with
`metadata.source = shared_hotel_setup`. Billing-managed entitlements retain
their status, suspended entitlements cannot be reactivated from onboarding, and
`hotelGroup.selectedProducts` contains only currently active account access.
During migration, `account_access` and `pms-core` aliases count as the same
account-wide access as the canonical keys. Any currently effective suspension
across those aliases wins, and neither selection nor migration may reactivate
an explicitly suspended hotel resource link. Future and bounded suspension
windows retain their original dates.

The former `PUT /api/hotel-setup/properties/:propertyId/products` command is
removed. Product choice has one account-level source of truth; property-level
activation status only tracks whether each hotel has completed that product's
setup.

## Authorization

The route is available only to authenticated users in an active
`hotel_group` organization.

Route policy:

```ts
{
  permission: "hotel_catalog.setup.read";
}
```

Returned properties are further filtered to active direct property links:

```ts
{
  product: "hotel_catalog",
  resourceType: "property",
  resourceId: property.propertyId,
  allowedRelationships: ["owner", "operator"]
}
```

Product activation details may be derived from product tables, entitlements, or
activation tables, but only after the canonical property itself is authorized.

## Response

```ts
type SharedHotelSetupStatus = {
  contractVersion: "shared-hotel-setup-status.v1";
  entry: {
    entryProduct: "booking" | "pms" | "marketplace" | null;
    returnTo: string | null;
  };
  hotelGroup: {
    organizationId: string;
    displayName: string;
    websiteUrl: string | null;
    selectedProducts: Array<"booking" | "pms" | "marketplace">;
  };
  selection: {
    state: "no_property" | "single_property" | "multiple_properties";
    selectedPropertyId: string | null;
  };
  properties: SharedSetupProperty[];
  nextAction: SharedHotelSetupNextAction;
  updatedAt: string;
};

type SharedSetupProperty = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  locationSummary: string | null;
  sharedProfile: {
    status: "incomplete" | "complete" | "disabled" | "private";
    source: "canonical" | "legacy_prefill";
    completionPercent: number;
    missingFields: SharedPropertyProfileMissingField[];
  };
  products: {
    booking: SharedProductActivation<"booking">;
    pms: SharedProductActivation<"pms">;
    marketplace: SharedProductActivation<"marketplace">;
  };
};

type SharedPropertyProfileMissingField =
  | "displayName"
  | "location"
  | "website"
  | "phone"
  | "description"
  | "media";

type SharedProductActivation<Product extends "booking" | "pms" | "marketplace"> = {
  product: Product;
  status: "not_selected" | "selected_incomplete" | "active" | "suspended" | "unavailable";
  missingSteps: string[];
  statusReasons: string[];
  updatedAt: string | null;
};

type SharedHotelSetupNextAction =
  | { action: "create_property"; reasonCodes: string[] }
  | { action: "select_property"; reasonCodes: string[] }
  | {
      action: "complete_shared_profile";
      propertyId: string;
      missingFields: SharedPropertyProfileMissingField[];
      reasonCodes: string[];
    }
  | { action: "select_products"; propertyId: string; reasonCodes: string[] }
  | {
      action: "complete_product_activation";
      propertyId: string;
      product: "booking" | "pms" | "marketplace";
      missingSteps: string[];
      reasonCodes: string[];
    }
  | {
      action: "enter_product";
      propertyId: string;
      product: "booking" | "pms" | "marketplace";
      returnTo: string | null;
      reasonCodes: string[];
    };
```

## State Rules

- `selection.state = "no_property"` means the hotel group has no active direct
  canonical property links.
- `selection.state = "single_property"` means exactly one directly linked
  property exists; clients may auto-select it.
- `selection.state = "multiple_properties"` means the client must let the user
  choose a property unless `selectedPropertyId` is already set.
- `sharedProfile.status` mirrors the canonical catalog profile status from
  `hotel_catalog.properties` or
  `hotel_catalog.property_public_profile_read_model`: `complete`, `incomplete`,
  `disabled`, or `private`.
- An `incomplete` shared profile blocks routing only when `displayName` or
  `location` is missing. Missing website, phone, description, or media is
  reported as profile metadata but is completed inside the relevant product
  setup rather than in first-run hotel creation.
- `hotelGroup.selectedProducts` is the account-level system choice for every
  property/listing in the hotel group.
- `products.<product>.status` combines the account-level system choice with the
  product activation state for the selected canonical property.
- `disabled` and `private` are shared catalog states; they must not be collapsed
  into product `suspended` or `unavailable` states.
- `not_selected` means the hotel group has not chosen that system for the
  account.
- `selected_incomplete` means the product was chosen but product-specific setup
  is missing.
- `active` means the product can be entered normally for that property.
- `suspended` means the product exists but is blocked by product or billing
  state.
- `unavailable` means the product cannot currently be used for that property or
  organization.

Booking Admin may still open when only downstream publication readiness
(`publicBookability`, freshness, or payment readiness) remains. Those states
block publishing or accepting bookings, not access to the configuration UI.

`sharedProfile.status` and `products.<product>.status` must never be collapsed
into one generic `profileComplete` boolean.

## Product Activation Boundaries

Shared routing baseline:

- display name
- city and country code

Additional shared public-profile fields:

- public website/contact phone
- short or long description
- media/cover/gallery readiness

Product-specific activation examples:

- Booking Engine: rooms, rates, policies, payment readiness, public booking
  capability.
- PMS: operational room/inventory setup, channel connections, PMS modules.
- Creator Marketplace: creator-facing pitch, collaboration offers, creator
  requirements, listing setup.

Marketplace must not ask for the shared routing baseline again. It may ask for
public website/contact, descriptions, and media as part of building the public
listing, then persist those values to the canonical shared profile.

## Examples

### No Property

```json
{
  "contractVersion": "shared-hotel-setup-status.v1",
  "entry": { "entryProduct": "booking", "returnTo": "/dashboard" },
  "hotelGroup": {
    "organizationId": "11111111-1111-1111-1111-111111111111",
    "displayName": "Bali Hospitality Group",
    "websiteUrl": "https://bali-hospitality.example/",
    "selectedProducts": ["booking"]
  },
  "selection": { "state": "no_property", "selectedPropertyId": null },
  "properties": [],
  "nextAction": {
    "action": "create_property",
    "reasonCodes": ["no_property"]
  },
  "updatedAt": "2026-06-30T08:00:00.000Z"
}
```

### Shared Profile Complete, Marketplace Incomplete

```json
{
  "contractVersion": "shared-hotel-setup-status.v1",
  "entry": { "entryProduct": "marketplace", "returnTo": "/marketplace" },
  "hotelGroup": {
    "organizationId": "11111111-1111-1111-1111-111111111111",
    "displayName": "Bali Hospitality Group",
    "websiteUrl": "https://bali-hospitality.example/",
    "selectedProducts": ["booking", "marketplace"]
  },
  "selection": {
    "state": "single_property",
    "selectedPropertyId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  },
  "properties": [
    {
      "propertyId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "publicId": "alpenrose-resort",
      "displayName": "Alpenrose Resort",
      "locationSummary": "Bali, Indonesia",
      "sharedProfile": {
        "status": "complete",
        "completionPercent": 100,
        "missingFields": []
      },
      "products": {
        "booking": {
          "product": "booking",
          "status": "active",
          "missingSteps": [],
          "statusReasons": [],
          "updatedAt": "2026-06-30T08:00:00.000Z"
        },
        "pms": {
          "product": "pms",
          "status": "not_selected",
          "missingSteps": [],
          "statusReasons": [],
          "updatedAt": null
        },
        "marketplace": {
          "product": "marketplace",
          "status": "selected_incomplete",
          "missingSteps": ["creatorPitch", "collaborationOffer", "creatorRequirements"],
          "statusReasons": ["marketplace_activation_incomplete"],
          "updatedAt": "2026-06-30T08:00:00.000Z"
        }
      }
    }
  ],
  "nextAction": {
    "action": "complete_product_activation",
    "propertyId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "product": "marketplace",
    "missingSteps": ["creatorPitch", "collaborationOffer", "creatorRequirements"],
    "reasonCodes": ["entry_product_activation_incomplete"]
  },
  "updatedAt": "2026-06-30T08:00:00.000Z"
}
```

## Follow-Up Contracts

- VAY-975 adds canonical `hotel_catalog/property` identity links required by
  this contract.
- VAY-967 implements the read endpoint against this contract.
- VAY-968 originally defined per-property product selection storage; current
  first-run setup uses account-level system selection instead.
- VAY-969 defines shared property profile create/update commands.
- VAY-970 consumes this contract in the shared setup wizard.
- VAY-971 applies this contract to Booking Admin, PMS, and Marketplace guards.
- VAY-972 replaces Marketplace generic profile completion with Marketplace
  activation state.

## Cleanup Position

Legacy product profile/status routes may remain temporarily for old surfaces,
but new shared setup code must not call them for routing. Cleanup should remove
runtime dependencies once `rg` proves no route, client, parity fixture, or
rollback path still needs the compatibility behavior.
