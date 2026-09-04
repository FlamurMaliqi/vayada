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
| Read hotel review        | `GET`    | `/api/marketplace/admin/users/{hotelUserId}/review`               |
| Read creator review      | `GET`    | `/api/marketplace/admin/users/{userId}/review/creator`            |
| Moderate creator profile | `POST`   | `/api/marketplace/admin/creators/{creatorProfileId}/moderation`   |
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

Creator moderation is a new target-only command and does **not** use that
fallback. It requires all of:

```text
permission: platform.user.suspend
entitlement: platform/platform-admin on platform/platform/vayada
resource: platform/platform/vayada
relationship: operator
```

## Scope Boundaries

This contract only covers marketplace-owned resources:

- collaboration review actions that act as the hotel side;
- the hotel review projection used to inspect the Marketplace profile and its offers;
- the creator review projection used to inspect one exact active creator-workspace profile;
- collaboration-offer create/update/archive for a hotel user.

Identity user CRUD remains out of scope and stays on the identity admin command
surface. Do not port legacy `admin/users.py` user CRUD as part of V7.

## Response Shape

Collaboration responses reuse the V4 collaboration read/lifecycle shapes and add
admin lifecycle timestamps (`hotelAgreedAt`, `creatorAgreedAt`, `completedAt`,
`cancelledAt`) needed by `vayada-admin`.

Offer writes accept only Marketplace-owned fields: `title`, `offerSummary`,
`deliverables`, `compensationOptions`, `creatorRequirements`, and the optional
versioned `matchingCriteria` contract documented in
`engineering/marketplace-hotel-self-service-contract.md`. Hotel name,
classification, location, contacts, descriptions, and media remain in the
shared hotel catalog and are not accepted by these routes.

The hotel review read returns Marketplace profile status, pitch, and offers,
plus the shared catalog name and location needed to identify the hotel. Identity
account details remain on the identity admin route; the Vayada Admin client
composes both owner-specific responses instead of making identity own product
profiles.

The creator review follows the same ownership boundary: it returns Marketplace
profile fields, platform connections, and the persisted profile-image media
object ID only when the target user resolves to exactly one profile in an
active creator workspace. Archived profiles remain readable so Admin can show
their terminal lifecycle state. The response also includes a server-computed
`moderation` capability with `allowed` and `allowedTransitions`. The capability
uses the exact creator-moderation policy above without the legacy superadmin
fallback, and its transitions account for the current lifecycle state and
profile completeness. Admin clients must fail closed when the capability is
missing or denied and must not recreate lifecycle authorization rules locally.

## Creator Profile Moderation

Creator profile moderation has its own contract version:
`marketplace-creator-moderation.v1`.

The request requires exactly one `Idempotency-Key` header and this body:

```ts
type MarketplaceCreatorModerationRequest = {
  expectedStatus: "pending" | "active" | "rejected" | "suspended" | "archived";
  nextStatus: "active" | "rejected" | "suspended" | "archived";
  reason: string;
};
```

`reason` is trimmed, must contain 1–1000 characters, must not contain control
characters or malformed Unicode surrogate pairs, and is stored as confidential
audit data. Allowed state changes are:

| Current     | Allowed next states              |
| ----------- | -------------------------------- |
| `pending`   | `active`, `rejected`, `archived` |
| `active`    | `suspended`, `archived`          |
| `rejected`  | `active`, `archived`             |
| `suspended` | `active`, `archived`             |
| `archived`  | none                             |

Activation requires the canonical creator completeness function to return
true. Rejected or suspended profiles may therefore be activated after their
profile data has been corrected; there is no hidden reset-to-pending action.
Archived profiles are terminal in v1.

The command returns `outcome: "transitioned"` with the previous state, next
state, actor, timestamp, and reason. If the profile already has the requested
next state, it returns `outcome: "unchanged"` without another profile mutation
or transition audit; this check intentionally precedes expected-state conflict
handling so a safe retry remains a no-op. Reusing an idempotency key with an
identical request replays the original response. Reusing it with different
input returns `409 idempotency_key_conflict`.

Other typed failures are `404 creator_profile_not_found`,
`409 profile_status_conflict`, `409 invalid_profile_transition`,
`409 profile_incomplete`, and `409 command_in_progress`. Invalid identifiers,
headers, or bodies return `422` validation errors and do not call the command
repository.

Every `transitioned` result is committed atomically with an append-only
`platform.product_audit_events` row containing the actor, timestamp, previous
state, next state, and confidential reason. `unchanged` results retain their
idempotency record but do not claim that a new transition occurred.

`offerId` is the target `marketplace.marketplace_offers.id`. Archive is a soft
delete that sets `offerStatus = archived`.

Create, update, and archive keep the public offer projection in the same
database transaction as the canonical write. Create also provisions the hotel
organization's `marketplace_offer` operator link through the identity-owned
access command port. Archive disables the projection and archives that link so
discovery and hotel-side authorization cannot drift. Product entitlement stays
account-scoped and is not duplicated for each offer.

Verification publishes an offer when the Marketplace profile and offer are
verified, at least one approved public offer image exists, and the shared
catalog has a name and location. It does not depend on unrelated canonical
Booking profile description or media completeness.

Admin lifecycle actions use the same accepted-collaboration side effects as the
hotel workflow. In particular, accepting an affiliate-enabled collaboration
requests creator-specific affiliate provisioning with the stable collaboration
idempotency key.

## Fixtures

Representative cases live in
[`fixtures/marketplace-admin/cases.json`](fixtures/marketplace-admin/cases.json).
