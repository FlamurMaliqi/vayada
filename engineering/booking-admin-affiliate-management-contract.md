# Booking Admin affiliate management contract

_VAY-1278 contract record. Contract versions: `marketplace-affiliate-admin.v1`
and `finance-affiliate-commission.v1`._

## Ownership

- Marketplace/affiliate owns the property affiliate application, referral
  identity projection, and lifecycle status.
- Finance owns the property's default affiliate commission and an optional
  property/affiliate override in `finance.commission_rules`.
- Booking Admin composes typed Marketplace and Finance clients. Neither owner
  reads or writes legacy PMS affiliate records, and payout reads/actions remain
  outside this contract (VAY-1281).

The Marketplace record stores only administration fields needed to identify an
application. Payout destinations, provider accounts, bank details, and payout
history are never returned by these routes.

## Authorization

Marketplace routes call `enforceRoutePolicy` with:

```ts
{
  permission: "marketplace.affiliate.manage",
  entitlement: { product: "booking", key: "booking-engine" },
  resource: {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: propertyId,
    allowedRelationships: ["owner", "operator"],
  },
}
```

Finance commission reads and writes require `pms.finance.manage`, an active
`booking:direct-booking-finance` or `pms:property-management` entitlement, and
an owner or finance-manager link to the canonical property. Per-affiliate
commission routes additionally verify the affiliate belongs to that property
through a typed Marketplace scope port.

The denial matrix is `401 unauthenticated`; `403 missing_permission`,
`missing_entitlement`, `inactive_entitlement`, or `missing_resource_access`;
and `404 affiliate_not_found` for a valid property scope with no matching
affiliate. Cross-property lookup uses the same `404` response.

## Marketplace routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/marketplace/properties/:propertyId/affiliates` | Paginated/filterable list. |
| `GET` | `/api/marketplace/properties/:propertyId/affiliates/:affiliateId` | Property-scoped detail. |
| `POST` | `/api/marketplace/properties/:propertyId/affiliates/:affiliateId/lifecycle` | Idempotent lifecycle command. |

List query fields are `status`, `affiliateType`, `search`, `limit`, and
`offset`. `limit` defaults to 50 and is clamped to 1-200. Results sort by
`appliedAt DESC, affiliateId ASC`.

```ts
type BookingAdminAffiliate = {
  affiliateId: string;
  propertyId: string;
  referralCode: string;
  displayName: string | null;
  contactEmail: string | null;
  socialMedia: string | null;
  affiliateType: "guest" | "creator";
  lifecycleStatus: "pending" | "approved" | "rejected" | "suspended";
  applicationSource: "public_registration" | "collaboration" | "migration";
  appliedAt: string;
  updatedAt: string;
};

type AffiliateLifecycleCommand = {
  commandId: string;
  idempotencyKey: string;
  action: "approve" | "reject" | "suspend" | "restore";
};
```

Allowed transitions are pending to approved/rejected, approved to suspended,
and suspended to approved via restore. Retrying the same command returns its
stored result. Reusing a key with a different payload returns
`409 idempotency_conflict`; other disallowed transitions return
`409 invalid_status_transition`. Each accepted/no-op command appends lifecycle
history and a correlated Marketplace product-audit event.

## Finance routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/PATCH` | `/api/finance/properties/:propertyId/affiliate-commission` | Read/update property default. |
| `GET/PATCH` | `/api/finance/properties/:propertyId/affiliates/:affiliateId/commission` | Read/update or clear override. |

PATCH requests contain `commandId`, `idempotencyKey`, and
`percentageRate`. The default requires a decimal string from `0` through
`100`; the override also accepts `null` to inherit the default. Responses
return `defaultPercentageRate`, `overridePercentageRate`, and
`effectivePercentageRate` as decimal strings. Commission changes use
`finance.commission_rules`, append `finance.commission_rate_changes`, record a
Finance product-audit event, and replay the original result for identical
idempotency retries.

## Intentional legacy divergence

Approving an affiliate does not create a local-password user, reset token, or
legacy affiliate-dashboard account. Identity access must use the WorkOS-backed
identity command boundary. Payout setup and mark-paid actions remain Finance
surfaces owned by VAY-818/VAY-1281.
