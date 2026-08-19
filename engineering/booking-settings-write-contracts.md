# Booking settings write contracts

This document records the typed write contracts used by the Booking Flow
settings surfaces:

- [`BookingAddonSettings`](booking-addon-settings-contract.md)
- [`BookingGuestFormSettings`](booking-guest-form-settings-contract.md)
- [`BookingBenefitsSettings`](booking-benefits-settings-contract.md)
- [`BookingLocalizationSettings`](booking-localization-settings-contract.md)
- [`BookingRoomFilterSettings`](booking-room-filter-settings-contract.md)

The target TypeScript routes, PostgreSQL repository, and Booking Admin clients
implement these contracts. The production server now composes the target
repository directly; there is no runtime source selector for these reads or
writes.

## Contract Shape

All five settings writes use full-surface replacement semantics:

| Field         | Value                                                  |
| ------------- | ------------------------------------------------------ |
| Method        | `PUT`                                                  |
| Path pattern  | `/api/booking/hotels/:hotelId/settings/<surface>`      |
| Route adapter | `registerBookingSettingsRoutes`                        |
| Success       | `200` with the normalized settings response            |
| Body          | Complete settings object for that surface, no partials |
| Query         | No public query parameters                             |

`hotelId` is the Booking product hotel id. It is the resource scope for the
settings row and every authorization check. Writes are idempotent: sending the
same body twice produces the same stored settings and response.

The write response shape for each surface matches its typed read response. The
frontend should update local state from the response instead of assuming the
submitted body is already normalized.

All write bodies are strict: unknown fields are rejected, required fields may
not be omitted, and `null` is invalid unless a future surface explicitly
documents a nullable field.

## Target Repository Runtime

`apps/api` always reads and writes `booking.booking_settings` through
`TARGET_DATABASE_URL`; `BOOKING_SETTINGS_SOURCE` is retired. The legacy
`booking_hotels` reader/writer is deleted, while `BOOKING_DATABASE_URL` remains
temporarily accepted but unused until the stacked configuration cleanup.
Guest-form settings writes do not call the PMS admin API. The next
TypeScript/public Booking paths consume the target projection; separately
deployed legacy Python PMS behavior remains a rollback/retirement concern
outside this cleanup.

## Authorization

Every route is protected and must use `enforceRoutePolicy` at the route
boundary.

Required checks:

| Check                 | Contract value                              |
| --------------------- | ------------------------------------------- |
| Permission            | `booking.settings.manage`                   |
| Entitlement           | active `booking:booking-engine`             |
| Entitlement resource  | `booking_hotel` with `resourceId = hotelId` |
| Linked resource       | `booking_hotel` with `resourceId = hotelId` |
| Allowed relationships | `owner`, `operator`                         |

Authentication failures return `401`. Permission, entitlement, inactive
entitlement, or linked-resource failures return `403`.

## Common Error Contract

```ts
type BookingSettingsWriteErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "write_model";

type BookingSettingsWriteErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_payload"
  | "not_found"
  | "write_model_unavailable";

type BookingSettingsWriteError = {
  statusCode: 401 | 403 | 404 | 422 | 500;
  code: BookingSettingsWriteErrorCode;
  category: BookingSettingsWriteErrorCategory;
  message: string;
  details?: unknown;
};
```

Expected mapping:

| Condition                         | Status | Code                      | Category         | Message                                         |
| --------------------------------- | ------ | ------------------------- | ---------------- | ----------------------------------------------- |
| Missing bearer/session            | `401`  | `unauthenticated`         | `authentication` | `A valid access token is required.`             |
| Invalid bearer/session            | `401`  | `unauthenticated`         | `authentication` | `A valid access token is required.`             |
| Missing permission                | `403`  | `missing_permission`      | `authorization`  | `Missing required booking settings permission.` |
| Missing entitlement               | `403`  | `missing_entitlement`     | `authorization`  | `Missing active booking engine entitlement.`    |
| Inactive entitlement              | `403`  | `inactive_entitlement`    | `authorization`  | `Booking engine entitlement is not active.`     |
| Missing linked-resource access    | `403`  | `missing_resource_access` | `authorization`  | `Missing booking hotel access.`                 |
| Hotel/settings row disappeared    | `404`  | `not_found`               | `write_model`    | `Booking settings target not found.`            |
| Invalid body shape or field value | `422`  | `invalid_payload`         | `validation`     | `Booking settings payload is invalid.`          |
| Repository/write-model error      | `500`  | `write_model_unavailable` | `write_model`    | `Booking settings could not be saved.`          |

Surface-specific clients may map these shared errors to more specific error
class names, but the wire format and status/category/code vocabulary should
stay common across the five write routes.

## Add-on Display Settings

| Field                  | Value                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| Path                   | `/api/booking/hotels/:hotelId/settings/addons`                             |
| Frontend client target | `updateBookingAddonSettings(input) -> BookingAddonSettings`                |
| Legacy write path      | `PATCH /admin/settings/addons` via `settingsService.updateAddonSettings()` |

```ts
type UpdateBookingAddonSettingsRequest = {
  params: { hotelId: string };
  query: Record<string, never>;
  body: {
    showAddonsStep: boolean;
    groupAddonsByCategory: boolean;
  };
};

type BookingAddonSettings = {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
};
```

Validation and behavior:

- Both booleans are required. Partial updates are not accepted by the typed
  route.
- `showAddonsStep: false` with `groupAddonsByCategory: true` is valid; guest
  checkout may ignore grouping while the add-ons step is hidden, but the setting
  remains persisted.
- The response returns the stored boolean values after normalization.
- This contract covers display settings only. Add-on CRUD remains on the
  existing add-on endpoints until a separate add-on management contract exists.

## Guest Form Settings

| Field                  | Value                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Path                   | `/api/booking/hotels/:hotelId/settings/guest-form`                                   |
| Frontend client target | `updateBookingGuestFormSettings(input) -> BookingGuestFormSettings`                  |
| Legacy write path      | `PATCH /admin/settings/property` plus best-effort `PATCH /admin/guest-form-settings` |

```ts
type UpdateBookingGuestFormSettingsRequest = {
  params: { hotelId: string };
  query: Record<string, never>;
  body: {
    specialRequestsEnabled: boolean;
    arrivalTimeEnabled: boolean;
    guestCountEnabled: boolean;
    phoneRequired: boolean;
    adultAgeThreshold: number;
    childrenEnabled: boolean;
  };
};

type BookingGuestFormSettings = {
  specialRequestsEnabled: boolean;
  arrivalTimeEnabled: boolean;
  guestCountEnabled: boolean;
  phoneRequired: boolean;
  adultAgeThreshold: number;
  childrenEnabled: boolean;
};
```

Validation and behavior:

- Typed clients send all six fields. During the migration window, legacy
  five-field guest-form saves may omit `phoneRequired`; the write path preserves
  the stored value. Other partial updates are not accepted by the typed route.
- `adultAgeThreshold` must be an integer from `1` through `120`. Children age
  labels are derived as `0` through `adultAgeThreshold - 1`; there are no
  separate child age range fields.
- `phoneRequired` controls whether Booking Web requires a non-empty guest phone
  number during checkout.
- `childrenEnabled` controls whether Booking Web exposes a children selector.
- The Booking write is authoritative for this contract.
- Until the PMS guest-facing flow reads these flags from a Booking-owned or
  distribution-owned model, the typed route owns the existing compatibility
  sync to PMS. PMS sync failure is non-fatal and must not fail the request after
  the Booking write succeeds; it should be logged or emitted through the
  backend's operational telemetry. The PMS compatibility PATCH still includes
  only `special_requests_enabled`, `arrival_time_enabled`, and
  `guest_count_enabled`.
- The response returns the Booking settings state, not PMS sync state.

## Benefits Settings

| Field                  | Value                                                             |
| ---------------------- | ----------------------------------------------------------------- |
| Path                   | `/api/booking/hotels/:hotelId/settings/benefits`                  |
| Frontend client target | `updateBookingBenefitsSettings(input) -> BookingBenefitsSettings` |
| Legacy write path      | `PUT /admin/benefits` via `settingsService.updateBenefits()`      |

```ts
type UpdateBookingBenefitsSettingsRequest = {
  params: { hotelId: string };
  query: Record<string, never>;
  body: {
    benefits: string[];
  };
};

type BookingBenefitsSettings = {
  benefits: string[];
};
```

Validation and behavior:

- `benefits` is required and replaces the full hotel-level Book Direct Benefits
  list.
- Each item must be a string. The route trims leading/trailing whitespace.
- Empty strings after trimming are invalid.
- Duplicate benefit labels after trimming are invalid; the frontend should keep
  its current duplicate prevention.
- The route preserves order and custom owner-typed strings.
- The route does not translate, categorize, assign ids to, or sync benefits to
  PMS.

## Localization Settings

| Field                  | Value                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| Path                   | `/api/booking/hotels/:hotelId/settings/localization`                            |
| Frontend client target | `updateBookingLocalizationSettings(input) -> BookingLocalizationSettings`       |
| Legacy write path      | `PATCH /admin/settings/property` via `settingsService.updatePropertySettings()` |

```ts
type UpdateBookingLocalizationSettingsRequest = {
  params: { hotelId: string };
  query: Record<string, never>;
  body: {
    defaultCurrency: string;
    defaultLanguage: string;
    supportedCurrencies: string[];
    supportedLanguages: string[];
  };
};

type BookingLocalizationSettings = {
  defaultCurrency: string;
  defaultLanguage: string;
  supportedCurrencies: string[];
  supportedLanguages: string[];
};
```

Validation and behavior:

- All four fields are required. Partial updates are not accepted by the typed
  route.
- Currency codes are trimmed, uppercased, and must be three ASCII letters.
- Language codes are trimmed and must be non-empty BCP-47-style strings made of
  letters, digits, and hyphen separators.
- `supportedCurrencies` and `supportedLanguages` are additional selectable
  options. If either array contains the default value after normalization, the
  route drops that duplicate default from the array instead of storing it twice.
- Duplicate supported codes after normalization are invalid.
- The response returns normalized currency/language strings.
- Header currency-switcher writes and setup-wizard localization writes remain
  on their existing legacy paths until separate contracts migrate those
  workflows.

## Room Filter Settings

| Field                  | Value                                                                       |
| ---------------------- | --------------------------------------------------------------------------- |
| Path                   | `/api/booking/hotels/:hotelId/settings/room-filters`                        |
| Frontend client target | `updateBookingRoomFilterSettings(input) -> BookingRoomFilterSettings`       |
| Legacy write path      | `PATCH /admin/settings/design` via `settingsService.updateDesignSettings()` |

```ts
type UpdateBookingRoomFilterSettingsRequest = {
  params: { hotelId: string };
  query: Record<string, never>;
  body: {
    bookingFilters: string[];
    customFilters: Record<string, string>;
    filterRooms: Record<string, string[]>;
  };
};

type BookingRoomFilterSettings = {
  bookingFilters: string[];
  customFilters: Record<string, string>;
  filterRooms: Record<string, string[]>;
};
```

Validation and behavior:

- All three fields are required and replace the full room-filter settings
  surface.
- Filter keys are trimmed strings and must not be empty. The route preserves
  key spelling after trimming.
- `bookingFilters` preserves order and may contain built-in filter keys or
  custom filter keys.
- `customFilters` maps custom filter keys to owner-typed display labels.
  Labels are trimmed and must not be empty.
- `filterRooms` maps filter keys to PMS room ids. Room ids are trimmed strings
  and must not be empty.
- Keys in `customFilters` and `filterRooms` that are not present in
  `bookingFilters` are invalid. This prevents hidden stale assignments from
  being written by the typed route.
- The route does not synchronously validate PMS room ids against PMS inventory;
  stale room ids can still be returned by the read contract and resolved by the
  UI fallback.
- Disabling filters is represented by:

```json
{
  "bookingFilters": [],
  "customFilters": {},
  "filterRooms": {}
}
```

Hero image, heading, subtext, colors, and font pairing use the target-backed
`PATCH /api/booking/hotels/:hotelId/settings/design` route. The separate
Booking design revision contract continues to own publication-ready design
revisions.

## Adjacent Target Surfaces

These neighboring Booking Admin writes are target-backed but remain separate
from the five full-replacement contracts above:

| Surface                          | Target path/ownership                                                        |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Add-on catalog CRUD              | Typed Booking add-on item routes and Booking Admin client                    |
| Promo-code CRUD                  | Typed Booking promo-code routes and Booking Admin client                     |
| Last-minute configuration        | `GET`/`PUT /api/booking/hotels/:hotelId/settings/last-minute`                |
| Header default-currency switcher | Target property-settings patch route                                         |
| Shared setup wizard              | Shared marketplace setup flow, outside this Booking settings route family    |
| Hero/branding design settings    | Target Booking settings design route; canonical revisions use Booking design |

Retiring old Python endpoints still requires an audit of consumers outside this
TypeScript repository; it is not a reason to keep a runtime adapter in
`apps/api`.

## Implementation Notes

- `BookingSettingsWriteRepository` sits next to the read repository, and route
  handlers delegate persistence instead of containing SQL.
- Route tests cover success, validation failure, missing/invalid auth,
  missing permission, missing entitlement, inactive entitlement, missing linked
  resource, not found, and write-model failure.
- Booking Admin clients live under `apps/booking-admin/services/api/` and share
  the typed settings error mapping. The remaining `settingsService` property
  and design helpers also call target routes.
- The PostgreSQL legacy settings reader and source selector are removed. The
  subsequent `BOOKING_DATABASE_URL` cleanup is a separate stacked slice.
