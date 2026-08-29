# BookingReservationList contract

This contract is the first vertical from
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md).
It defines the booking-admin reservations list boundary before the TypeScript
route and frontend client are tightened.

The current route adapter lives in
[`apps/api/src/routes/bookingReservations.ts`](../apps/api/src/routes/bookingReservations.ts)
and exports the `BookingReservationList` request, response, error, and contract
types. The domain read model and repository port live in
[`packages/domain-booking`](../packages/domain-booking/src/index.ts).

## Endpoint

| Field                  | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| Method                 | `GET`                                                     |
| Path                   | `/api/booking/hotels/:hotelId/reservations`               |
| Route adapter          | `registerBookingReservationRoutes`                        |
| Frontend client target | `getBookingReservations(input) -> BookingReservationList` |

`hotelId` is a Booking product alias. It must resolve to exactly one canonical
`hotel_catalog.properties.id`; unmapped or ambiguous aliases fail closed. The
canonical property id scopes authorization and every returned reservation.

## Authorization

The route is protected and must use `enforcePropertyRoutePolicy` at the route boundary.

Required checks:

| Check                 | Contract value                                      |
| --------------------- | --------------------------------------------------- |
| Permission            | `booking.reservation.read`                          |
| Entitlement           | active `booking:booking-engine`                     |
| Entitlement resource  | `booking_hotel` with the canonical property id      |
| Linked resource       | `booking_hotel` with the canonical property id      |
| Property scope        | effective active membership scope includes property |
| Allowed relationships | `owner`, `operator`                                 |

Authentication failures return `401`. Permission, entitlement, inactive
entitlement, or linked-resource failures return `403`. An authorized hotel with
no matching reservations returns a successful empty list, not `404`.

## Request

```ts
type BookingReservationListRequest = {
  params: {
    hotelId: string;
  };
  query: {
    status?: string;
    search?: string;
    limit?: string;
    offset?: string;
  };
};
```

Query behavior:

| Query param | Behavior                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`    | Optional status filter. Trim whitespace. Omit from read-model filters when empty. Status values are product-domain strings. Unknown values are passed to the read model instead of rejected by the adapter.             |
| `search`    | Optional free-text filter. Trim whitespace. Omit from read-model filters when empty. The read model owns which reservation and guest fields are matched.                                                                |
| `limit`     | Optional decimal integer string. Default `50`. Clamp below `1` to `1` and above `500` to `500`. Current compatibility parsing uses JavaScript integer parsing, so malformed values that do not parse fall back to `50`. |
| `offset`    | Optional decimal integer string. Default `0`. Clamp below `0` to `0`. Malformed values that do not parse fall back to `0`.                                                                                              |

Sorting is not a public query parameter for this slice. The read model returns
the product default order. If the frontend needs explicit sort controls later,
that must be a contract change before implementation.

## Response

```ts
type BookingReservationList = {
  bookings: BookingReservation[];
  total: number;
  limit: number;
  offset: number;
};
```

`bookings` contains only reservations scoped to the canonical property id. `total` is the total
number of matching rows available to the list, not just the number returned in
the current page. `limit` and `offset` echo the effective pagination values
after defaults and clamping.

Empty state:

```json
{
  "bookings": [],
  "total": 0,
  "limit": 50,
  "offset": 0
}
```

The response has no stale-data marker in this slice. Frontend loading and stale
state handling belongs in the typed booking-admin API client and screen.

## Runtime Read Model

VAY-705 wires this route into the real `apps/api` runtime through
`BookingReservationsReadRepository`, not through SQL inside the Fastify handler.
The runtime implementation is `createTargetBookingReservationsReadRepository`.

Configuration:

| Field          | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Env var        | `TARGET_DATABASE_URL`                                   |
| Current source | Target Booking, PMS operations, and Finance read models |
| Runtime owner  | `apps/api` composition in `src/server.ts`               |
| Route owner    | Booking/checkout product contract                       |

The route continues to depend on the product-level
`BookingReservationsReadRepository` interface. Its production composition no
longer supports a legacy PMS database source.

## Reservation fields

Each reservation is a product read model, not a PMS table row. IDs are stable
product ids represented as strings.

| Field group          | Contract                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reservation identity | `id`, `bookingReference` are stable strings.                                                                                                                                                                                                               |
| Room type            | `roomTypeId`, `roomName`, `roomMaxOccupancy`, `totalRoomCapacity`.                                                                                                                                                                                         |
| Guest                | `guestFirstName`, `guestLastName`, `guestEmail`, `guestPhone`, optional country, gender, date of birth, passport, and special requests. Missing optional string-like guest values are exposed as `""` where the current booking-admin UI expects a string. |
| Stay                 | `checkIn`, `checkOut`, `nights`, `adults`, `children`, `numberOfGuests`, `estimatedArrivalTime`.                                                                                                                                                           |
| Rooms                | `numberOfRooms`, optional primary `roomId` and `roomNumber`, plus ordered `assignedRooms`.                                                                                                                                                                 |
| Payment              | `paymentMethod`, `paymentStatus`, deposit fields, balance, and payout/fee fields.                                                                                                                                                                          |
| Addons               | `addonIds`, `addonNames`, `addonTotal`, `addonQuantities`, `addonDates`. Missing addon arrays and maps are empty arrays or objects.                                                                                                                        |
| Promotions           | `promoCode`, `promoDiscount`, `lastMinuteDiscountPercent`, `lastMinuteDiscountAmount`.                                                                                                                                                                     |
| Operational status   | `status`, `guestWithdrawn`, `checkInPendingFlags`, `checkedInAt`, `checkedOutAt`, `hostResponseDeadline`.                                                                                                                                                  |
| Audit timestamps     | `createdAt`, `updatedAt`.                                                                                                                                                                                                                                  |

## Scalar formats

Dates:

- `checkIn`, `checkOut`, and `guestDateOfBirth` use `YYYY-MM-DD`.
- Timestamp fields use ISO 8601 UTC strings when present.
- Optional timestamps are `null` when absent or invalid in the read model.
- The shared reservation read-model mapper maps invalid required audit
  timestamps to `""`; follow-up route tightening should only change this with
  tests and a frontend compatibility note.

Money and currency:

- Money amounts are JSON numbers in major currency units, not integer cents.
- `currency` is the reservation currency from the Booking read model and should
  be an ISO 4217 uppercase code such as `EUR` or `USD`.
- The route adapter converts numeric strings to numbers and falls back to `0`
  for invalid non-null money values to preserve the current booking-admin list
  shape.
- Nullable fee and payout amounts remain `null` when absent.
- No additional rounding is performed in the route adapter; upstream pricing
  and read-model code owns rounding.

Status:

- `status` is a product-domain string, for example `confirmed`.
- The adapter does not reject unknown status values because legacy data may
  contain statuses not yet enumerated in the TypeScript backend.
- The frontend must render unknown statuses as data, not as a request failure.

## Error categories

The target typed client should map HTTP failures into these categories:

| Category         | Status | Codes                                                                                          |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `authentication` | `401`  | `unauthenticated`, `invalid_token`                                                             |
| `authorization`  | `403`  | `missing_permission`, `missing_entitlement`, `inactive_entitlement`, `missing_resource_access` |
| `validation`     | `400`  | `invalid_query`                                                                                |
| `read_model`     | `500`  | `read_model_unavailable`                                                                       |

The current adapter already enforces authentication and authorization through
shared backend auth/authorization helpers. VAY-702 owns any route-level error
body tightening or validation behavior beyond the current compatibility shape.

## Compatibility notes

- The response key remains `bookings` to match the booking-admin legacy list
  surface, even though the domain term is reservation.
- The route is read-only and must not create holds, update assignments, collect
  payment, or change booking status.
- The adapter may continue normalizing missing optional fields to `""`, `null`,
  `[]`, `{}`, or `0` where the current booking-admin UI expects those defaults.
- Python remains the source of truth for non-migrated booking surfaces until the
  TypeScript route, typed frontend client, screen migration, and smoke coverage
  are accepted.
