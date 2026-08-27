# Next-admin canonical platform access repair

Use this runbook when a named Vayada administrator authenticates but next-admin
cannot resolve the canonical platform organization. It follows
`engineering/workos-identity-architecture.md`: WorkOS owns provider identity;
Vayada owns the matching internal user, organization, role, and entitlement.
Deploy the VAY-1335 WorkOS reconciliation prerequisite before using this runbook.

## Guardrails

- Grant only an explicitly approved email.
- Use target organization `00000000-0000-0000-0000-000000000001`.
- Never promote a test organization or replace existing hotel membership.
- Use a deployed VAY-1334 `next-api` image and its production task environment.
- Apply only after the email-bound guard and any stale-link replacement IDs are
  confirmed.

## Preflight

```bash
npm --workspace @vayada/backend-migration run target:platform-identity:bootstrap:dist -- \
  --admin-email <admin-email> --dry-run
npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
  --email <admin-email> --organization-id 00000000-0000-0000-0000-000000000001 --dry-run
```

Require one active requested target user. Deleted same-email users are ignored;
multiple active users stop the operation. Record existing memberships, the
canonical target/WorkOS org IDs, the current
`NEXT_PUBLIC_PLATFORM_WORKOS_ORG_ID`, and any reported stale/canonical WorkOS
user IDs. A stale link is replaceable only when it is missing in WorkOS and
WorkOS returns exactly one user whose `external_id` is the active target user.
A provider mapping on another local user is transferable only from a deleted,
same-email user to the active target user.

Confirm this exact action before apply:

> Grant `<admin-email>` canonical `Vayada Platform` membership with target role
> `platform_admin` and WorkOS role `admin`, preserving hotel memberships. If
> reported, retire local WorkOS link `<stale-id>` in favor of `<canonical-id>`.

## Apply and audit

```bash
npm --workspace @vayada/backend-migration run target:platform-identity:bootstrap:dist -- \
  --admin-email <admin-email> --apply \
  --confirm platform-identity-bootstrap:v1:admin-email:<normalized-admin-email>
npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
  --email <admin-email> --organization-id 00000000-0000-0000-0000-000000000001 --dry-run
npm --workspace @vayada/backend-migration run target:workos:backfill:dist -- \
  --email <admin-email> --organization-id 00000000-0000-0000-0000-000000000001 --apply \
  --confirm email:<canonical-email>:organization:00000000-0000-0000-0000-000000000001
npm --workspace @vayada/backend-migration run target:workos:audit:dist
```

The bootstrap upserts the canonical target org, membership, resource link, and
entitlement without legacy DB access. Backfill links the WorkOS org/membership.
When replacing a missing provider user, it clears only that stale local provider
ID, preserves the row and retired ID in reconciliation metadata, and audits it.

## Configure, deploy, verify

Read the canonical target org's `workos_org_id`, then update and deploy without
printing it:

```bash
gh variable set NEXT_PUBLIC_PLATFORM_WORKOS_ORG_ID \
  --repo vayada-marketplace/vayada --body "$VAYADA_PLATFORM_WORKOS_ORG_ID"
gh workflow run deploy-next-vayada-admin.yml \
  --repo vayada-marketplace/vayada --ref main
```

Verify the deploys, one canonical org link, one active `platform_admin` target
membership, one active WorkOS `admin` membership, unchanged hotel access, and a
successful `https://next-admin.vayada.com` login. Do not deploy ECS manually.

Rollback configuration by restoring the previous repository variable and
redeploying. Do not delete identity rows; revoke access only through a separately
reviewed identity access-revoke operation.
