# Marketplace Admin Contract

Marketplace vertical **V7** migrates the marketplace-owned admin surfaces from
the legacy marketplace API to typed TypeScript backend routes consumed by
`apps/vayada-admin`.

Contract version: `marketplace-admin.v1`.

## Routes

| Surface                  | Method   | Path                                                              |
| ------------------------ | -------- | ----------------------------------------------------------------- |
| Admin collaboration list | `GET`    | `/api/marketplace/admin/collaborations`                           |
| Respond as hotel         | `POST`   | `/api/marketplace/admin/collaborations/{collaborationId}/respond` |
| Approve as hotel         | `POST`   | `/api/marketplace/admin/collaborations/{collaborationId}/approve` |
| Create hotel-user offer  | `POST`   | `/api/marketplace/admin/users/{hotelUserId}/offers`               |
| Update hotel-user offer  | `PUT`    | `/api/marketplace/admin/users/{hotelUserId}/offers/{offerId}`     |
| Archive hotel-user offer | `DELETE` | `/api/marketplace/admin/users/{hotelUserId}/offers/{offerId}`     |

## Authorization

Primary authorization is platform organization membership:

```text
permission: platform.user.suspend
resource: platform/platform/vayada
relationship: operator
```

During WorkOS/platform backfill, the routes may fall back to the legacy
`users.is_superadmin` flag after a valid authenticated `RequestContext` is
resolved. This fallback is intentionally narrow to these marketplace admin
compatibility routes and must not be treated as a permanent authorization
primitive.

## Scope Boundaries

This contract only covers marketplace-owned resources:

- collaboration review actions that act as the hotel side;
- collaboration-offer create/update/archive for a hotel user.

Identity user CRUD remains out of scope and stays on the identity admin command
surface. Do not port legacy `admin/users.py` user CRUD as part of V7.

## Response Shape

Collaboration responses reuse the V4 collaboration read/lifecycle shapes and add
admin lifecycle timestamps (`hotelAgreedAt`, `creatorAgreedAt`, `completedAt`,
`cancelledAt`) needed by `vayada-admin`.

Offer writes accept only Marketplace-owned fields: `title`, `offerSummary`,
`deliverables`, `compensationOptions`, and `creatorRequirements`. Hotel name,
classification, location, contacts, descriptions, and media remain in the
shared hotel catalog and are not accepted by these routes.

`offerId` is the target `marketplace.marketplace_offers.id`. Archive is a soft
delete that sets `offerStatus = archived`.

Create, update, and archive keep the public offer projection in the same
database transaction as the canonical write. Create also provisions the hotel
organization's `marketplace_offer` operator link through the identity-owned
access command port. Archive disables the projection and archives that link so
discovery and hotel-side authorization cannot drift. Product entitlement stays
account-scoped and is not duplicated for each offer.

Admin lifecycle actions use the same accepted-collaboration side effects as the
hotel workflow. In particular, accepting an affiliate-enabled collaboration
requests creator-specific affiliate provisioning with the stable collaboration
idempotency key.

## Fixtures

Representative cases live in
[`fixtures/marketplace-admin/cases.json`](fixtures/marketplace-admin/cases.json).
