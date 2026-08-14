# Backend Migration

`@vayada/backend-migration` owns target-schema migrations, local fixture
rebuilds, source-to-target transforms, and parity checks for the TypeScript
backend rewrite.

## Target Manual-Booking Readiness

Run the read-only VAY-1259 gate with a reviewed rehearsal manifest:

```bash
TARGET_DATABASE_URL=<staging target database> \
  npm --workspace @vayada/backend-migration run target:manual-booking:readiness -- \
  --evidence-manifest <manifest.json> --reviewed-sha256 <approved digest> --pretty
```

It reconciles bookings, stays/nights, add-ons, Finance, attribution, causal and
privacy evidence. The fixture matrix covers every payment method in paid/unpaid
states, every add-on model, rates, Email, heterogeneous dates, cancellation, no-show, refund,
stay correction, and price correction. The manifest records the
source snapshot, successful restore rehearsal, cutover review, exact property
cohort, booking IDs and expected target facts. The local bytes must
match the separately supplied reviewed SHA-256, and the CLI runs in a read-only
transaction. Any blocker exits non-zero.

## Full-Fixture Smoke

Use the full-fixture smoke command after updating `main` and before marking
post-merge migration fixture coverage as accepted:

```bash
TARGET_DATABASE_URL=<local scratch target database> \
  npm --workspace @vayada/backend-migration run target:fixtures:smoke
```

The command runs every fixture case registered in `src/cases/registry.ts`. For
each case it drops and recreates the target schemas, applies all reviewed target
migrations, loads that fixture, runs its transform when one is registered, and
then runs parity checks against `expected-target.json`.

`target:fixtures:smoke` intentionally does not accept `--fixtures`; it is the
full accepted fixture matrix. Use `target:rebuild` and `target:parity` directly
when you need to debug a single fixture case.

The unit tests compare fixture manifests, registry entries, and the smoke case
list. Adding a fixture manifest without registering it, or changing the smoke
path so it omits a registered case, fails `npm test`.

## Platform Media Parity

`platform-media` is a target-only fixture that pins the registry contract before
source-backed media transforms are implemented. Media migration parity must
track:

- source URL inventory count;
- copied Vayada-managed object count;
- external-reference object count;
- unresolved external URL count;
- public/private object classification count;
- required public image variants: `original_safe`, `large`, `thumbnail`, and
  `blur_preview`;
- forbidden private values in public media objects, variant CDN URLs, or future
  public read models.

Product fixtures that later migrate Booking, Marketplace, or PMS media URLs
should reuse `platformMediaChecks` instead of creating ad hoc media assertions.

## WorkOS Backfill

Bootstrap platform admins from the legacy auth DB before running the WorkOS
backfill. The command imports only legacy `is_superadmin` / `type = 'admin'`
users into the fixed platform organization and leaves hotel/creator/affiliate
resource ETL to the product-specific migration pipeline.

```bash
TARGET_DATABASE_URL=<target database url> \
  LEGACY_AUTH_DATABASE_URL=<legacy auth database url> \
  npm --workspace @vayada/backend-migration run target:platform-identity:bootstrap:dist -- \
    --dry-run
```

Apply mode requires the printed guard:

```bash
TARGET_DATABASE_URL=<target database url> \
  LEGACY_AUTH_DATABASE_URL=<legacy auth database url> \
  npm --workspace @vayada/backend-migration run target:platform-identity:bootstrap:dist -- \
    --apply \
    --confirm platform-identity-bootstrap:v1
```

Audit the migrated target identity/resource links before a backfill:

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:workos:audit
```

The audit exits non-zero when target identity tables are missing or when active
users, organizations, memberships, or required owner resource links are not
ready for AuthKit.

Production API images prune dev dependencies, so one-off ECS tasks should use
the compiled commands:

```bash
npm --workspace @vayada/backend-migration run target:migrate:dist -- --env production
npm --workspace @vayada/backend-migration run target:platform-identity:bootstrap:dist -- --dry-run
npm --workspace @vayada/backend-migration run target:workos:audit:dist
npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- --organization-kind platform --dry-run
npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- --email user@example.com --dry-run
```

Use `--email` for one-user migration smoke tests:

```bash
TARGET_DATABASE_URL=<target database url> \
  WORKOS_BACKFILL_LEGACY_AUTH_DATABASE_URL=<legacy auth database url> \
  WORKOS_API_KEY=<workos api key> \
  npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
    --email user@example.com \
    --dry-run
```

Apply mode requires the printed cohort key as a confirmation guard:

```bash
TARGET_DATABASE_URL=<target database url> \
  WORKOS_BACKFILL_LEGACY_AUTH_DATABASE_URL=<legacy auth database url> \
  WORKOS_API_KEY=<workos api key> \
  npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
    --email user@example.com \
    --apply \
    --confirm email:user@example.com
```

Use `--cohort-manifest <path>` for reviewed batch cohorts.
Omit `WORKOS_BACKFILL_LEGACY_AUTH_DATABASE_URL` to migrate identities without
importing legacy bcrypt password hashes.

## Next Stack Smoke Backfill

VAY-874 and VAY-877 use one targeted command for the production next-route smoke
data. It is intentionally narrow:

- activates the Booking Engine entitlement for smoke booking hotel
  `43303cea-963c-445a-9522-a05145fe0918`;
- adds the marketplace hotel profile owner link and scoped entitlement for the
  selected hotel-group org;
- creates or updates an affiliate-partner org, membership, affiliate resource
  link, and `affiliate-payouts` entitlement for the smoke affiliate user;
- optionally activates Booking Admin Feature Hub module rows in the PMS DB when
  `PMS_DATABASE_URL` is supplied.

Run all reviewed target migrations first so the current role grants and schema
state are present:

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:migrate:dist -- --env production
```

Dry-run the smoke backfill:

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:next-smoke:backfill:dist -- \
    --dry-run
```

If the command cannot infer the marketplace profile, pass the Vayada resource ID
explicitly:

```bash
--marketplace-hotel-profile-resource-id <marketplace hotel profile resource id>
```

Apply mode requires the printed guard:

```bash
TARGET_DATABASE_URL=<target database url> \
  PMS_DATABASE_URL=<pms database url> \
  npm --workspace @vayada/backend-migration run target:next-smoke:backfill:dist -- \
    --apply \
    --affiliate-organization-id <verified affiliate organization id> \
    --confirm next-smoke-backfill:vay-874-vay-877
```

`PMS_DATABASE_URL` is required in apply mode because the VAY-874 smoke criteria
include the Feature Hub module activation. The command activates the
`affiliates` module for the smoke PMS hotel ID, defaulting to the same UUID as
the booking hotel. Use `--pms-hotel-id <uuid>` if the PMS hotel ID differs, and
repeat `--module-id <id>` to activate a different reviewed module set. Dry runs
may omit `PMS_DATABASE_URL`; apply will fail before committing target identity
changes if PMS or WorkOS readiness blockers remain.

Apply mode does not accept `--affiliate-workos-org-id` or
`--affiliate-workos-membership-id`; those flags are dry-run/audit aids only. The
affiliate org and smoke-user membership must already exist locally and have
verified WorkOS IDs before the smoke backfill applies resource links and
entitlements. If the affiliate org does not exist yet, create the local
affiliate org/membership in a separate reviewed prepare step, complete provider
state with the existing WorkOS command, then rerun the smoke backfill dry-run and
apply with the verified `--affiliate-organization-id`:

```bash
TARGET_DATABASE_URL=<target database url> \
  WORKOS_API_KEY=<workos api key> \
  npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
    --email flamur.maliqi2811@gmail.com \
    --apply \
    --confirm email:flamur.maliqi2811@gmail.com
```

The smoke command output documents:

- hotel-group WorkOS org ID;
- booking hotel entitlement status;
- marketplace hotel profile resource ID;
- affiliate-partner WorkOS org ID and WorkOS membership ID;
- affiliate Vayada resource ID and entitlement status.

Validate the emitted IDs with:

```sql
SELECT organization.id::text AS organization_id,
       organization.workos_org_id,
       booking_entitlement.status AS booking_engine_status,
       marketplace_link.resource_id AS marketplace_hotel_profile_resource_id,
       marketplace_entitlement.status AS marketplace_hotel_profile_status
FROM identity.organizations organization
LEFT JOIN identity.product_entitlements booking_entitlement
  ON booking_entitlement.organization_id = organization.id
 AND booking_entitlement.product = 'booking'
 AND booking_entitlement.entitlement_key = 'booking-engine'
 AND booking_entitlement.resource_id = '<booking hotel id>'
LEFT JOIN identity.organization_resource_links marketplace_link
  ON marketplace_link.organization_id = organization.id
 AND marketplace_link.product = 'marketplace'
 AND marketplace_link.resource_type = 'hotel_profile'
 AND marketplace_link.resource_id = '<marketplace hotel profile resource id>'
 AND marketplace_link.status = 'active'
LEFT JOIN identity.product_entitlements marketplace_entitlement
  ON marketplace_entitlement.organization_id = organization.id
 AND marketplace_entitlement.product = 'marketplace'
 AND marketplace_entitlement.entitlement_key = 'marketplace-hotel-profile'
 AND marketplace_entitlement.resource_id = '<marketplace hotel profile resource id>'
WHERE organization.id = '<hotel organization id>'::uuid;

SELECT affiliate_org.id::text AS affiliate_organization_id,
       affiliate_org.workos_org_id,
       membership.workos_membership_id,
       affiliate_link.resource_id AS affiliate_resource_id,
       affiliate_entitlement.status AS affiliate_payouts_status
FROM identity.organizations affiliate_org
JOIN identity.organization_memberships membership
  ON membership.organization_id = affiliate_org.id
 AND membership.user_id = '<affiliate user id>'::uuid
LEFT JOIN identity.organization_resource_links affiliate_link
  ON affiliate_link.organization_id = affiliate_org.id
 AND affiliate_link.product = 'affiliate'
 AND affiliate_link.resource_type = 'affiliate'
 AND affiliate_link.resource_id = '<affiliate resource id>'
 AND affiliate_link.status = 'active'
LEFT JOIN identity.product_entitlements affiliate_entitlement
  ON affiliate_entitlement.organization_id = affiliate_org.id
 AND affiliate_entitlement.product = 'affiliate'
 AND affiliate_entitlement.entitlement_key = 'affiliate-payouts'
 AND affiliate_entitlement.resource_id = '<affiliate resource id>'
WHERE affiliate_org.id = '<affiliate organization id>'::uuid;
```

Run the global audit after the targeted backfill:

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:workos:audit:dist
```
