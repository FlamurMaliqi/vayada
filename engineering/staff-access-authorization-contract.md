# Staff access authorization contract v1

## Scope and ownership

WorkOS owns authentication, sessions, provider organization membership, and
invitation delivery/acceptance. Vayada owns internal users, hotel-group
membership, permissions, property access, entitlements, and audit. VAY-1085 adds
no second identity or ownership system. Routes keep `RequestContext` and
`enforceRoutePolicy`.

## Membership property scope

- `all`: every active canonical property linked to the organization; existing
  hotel-owner memberships use this.
- `assigned`: only active canonical properties in assignment rows; empty grants
  none. New VAY-1085 staff invitations use this.

The schema adds `property_access_mode` to `identity.organization_memberships`
and identity-owned `membership_property_assignments` keyed by membership and
canonical `hotel_catalog.properties.id`; roles and empty rows never imply `all`.

The resolver intersects active `hotel_catalog/property` organization links with
membership scope. Target routes expose only target-native
`booking/booking_hotel` and `pms/pms_property` links whose `resource_id` is the
allowed canonical ID (migration `0029_account_product_property_links.sql`).
Source-native `pms_hotel`, unmapped/ambiguous IDs, and inactive links fail closed.

Assignments outside the selected organization or other resource families are
invalid. Removal takes effect at the next context resolution without new login.

## Permission controls

Permission levels use explicit keys. Stronger UI levels write required lower
keys; runtime policy infers no hidden hierarchy.

| Control               | Levels and permission keys                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| PMS Dashboard         | arrivals/departures: `pms.dashboard.read`; standard: + `pms.dashboard.operations.read`; financial cards: + `pms.dashboard.finance.read` |
| PMS Calendar          | read: `pms.calendar.read`; full: + `pms.calendar.manage`                                                                                |
| PMS Reservations      | view: `pms.reservation.read`; modify/check-in/out: + `pms.reservation.update`; cancel: + `pms.reservation.cancel`                       |
| PMS Inbox             | read: `pms.inbox.read`; reply: + `pms.inbox.reply`                                                                                      |
| PMS Rooms & Rates     | room status: `pms.room_status.read`; read: + `pms.rooms_rates.read`; full: + `pms.rooms_rates.manage`                                   |
| PMS Channel Manager   | read: `pms.channel_manager.read`                                                                                                        |
| PMS Financials        | view: `pms.finance.read`                                                                                                                |
| PMS Settings          | view: `pms.settings.read`; full: + `pms.settings.manage`                                                                                |
| Team management       | manage: `identity.staff.manage`                                                                                                         |
| Billing/Plan          | manage: `finance.billing.manage`                                                                                                        |
| Guest contact fields  | view: `pms.guest_contact.read`                                                                                                          |
| Booking Dashboard     | view: `booking.analytics.read`                                                                                                          |
| Booking Design Studio | view: `booking.design.read`; edit: + `booking.design.manage`                                                                            |
| Booking Flow          | view: `booking.flow.read`; edit: + `booking.flow.manage`                                                                                |
| Booking Settings      | view: `booking.settings.read`; edit: + `booking.settings.manage`                                                                        |

Hidden stores no key. The editor stores role differences in existing membership
`permission_overrides`: `{ "grant": ["…"], "deny": ["…"] }`.

Unknown/repeated keys, grant/deny overlap, and stronger levels missing required
lower keys are rejected on write and revalidated per request. A malformed
override empties permissions, emits a security audit, and returns generic `403`
`invalid_permission_override`; it never falls back. Valid overrides apply deny
before grant.

## Default roles

| Internal role   | Default access                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hotel_owner`   | Maximum level for every control. Property scope is `all`.                                                                                                                       |
| `hotel_manager` | Maximum level except Team and Billing/Plan are hidden; Channel Manager is read-only.                                                                                            |
| `front_desk`    | Standard Dashboard without financials, full Calendar, Reservations through modify/check-in/out, Inbox reply, Rooms & Rates read, and guest contacts. Everything else is hidden. |
| `housekeeping`  | Arrivals/departures Dashboard, read-only Calendar, and room status. Everything else, including guest contacts, is hidden.                                                       |
| `hotel_custom`  | Starts with no permissions.                                                                                                                                                     |

Role defaults are Vayada grants. WorkOS roles remain coarse session claims:
`hotel_owner`, `hotel_admin` for managers, and `hotel_member` for other staff.

The editor cannot delegate `identity.staff.manage` or `finance.billing.manage`;
`housekeeping` cannot receive `pms.guest_contact.read`. Explicit denies beat
grants, then role defaults. Compatibility keys such as `pms.operations.manage`
do not imply new staff permissions.

Invite and edit commands accept only `hotel_manager`, `front_desk`,
`housekeeping`, or `hotel_custom` as a staff role. They reject `hotel_owner`;
owner creation or transfer is a separate identity lifecycle flow.

## Server decision order

Every protected request fails closed in this order:

1. WorkOS identity, selected organization, internal user, and active membership.
2. VAY-1085 delegation and Housekeeping ceilings.
3. Explicit deny, explicit grant, then role default.
4. For property routes, an active organization link, a valid explicit
   membership mode (`all` or `assigned`), matching scope, and a target-native
   resource link for that same canonical property.
5. Active product entitlement and resource state.

The property switcher/navigation consume the server manifest, but hiding UI is
not enforcement. Direct URLs and APIs run full policy. Cross-tenant targets stay
hidden: staff lookups return `404`; product access returns generic resource `403`.

Guest email/phone require `pms.guest_contact.read`, route policy, and
`propertyCanAccessGuestContact` for the requested property and booking. Other
property/booking evidence never authorizes PII. Check before contact-bearing
detail, search, export, or autocomplete.

## Invitations, removal, and audit

The identity boundary persists `staff_invitations`, then calls the WorkOS
Invitation API with seven-day expiry. It stores organization/email, display
name, inviter, role, overrides, property scope, provider ID/expiry, state,
configuration revision, idempotency key, and accepted user/membership IDs—never
provider tokens or acceptance URLs.

State is `pending -> accepted | expired | revoked`; one pending intent exists
per organization/email. Idempotent resends make one provider call; replacements
revoke the old intent. Acceptance locks the current, pending, unexpired provider
ID and, in one transaction, replaces role, validated overrides, property mode,
and assignments from that revision before activating exactly one membership.
Prior membership access never survives. Past-due rows atomically expire; late,
revoked, or superseded events are recorded without granting access.

Deactivation suspends the internal membership. Tenant-scoped removal inactivates
only that membership and revokes only its WorkOS organization membership; the
shared user and other organization access survive. `identity.user.delete` is
reserved for explicit whole-principal removal. History, audit principals, and
provider reconciliation survive either path.

Audit includes actor ID/name snapshot, target type/ID, organization/property,
action/outcome, redacted changes, request/correlation IDs. Invite identifies the
invitation; deactivate/remove identify membership/user; other IDs stay null.
`lastActiveAt` comes from reconciled WorkOS activity, not product audit.

## Dependencies and exclusions

- VAY-1321 may add who can delegate access, but this contract adds no account
  hierarchy or `account_type`. Explicit property scope and permission grants do
  not depend on hierarchy.
- VAY-1322 owns the shared settings shell and Feature Hub. VAY-1085 will add the
  Team & Access destination only after that integration point is ready.
- This contract changes no legacy Python behavior and does not authorize
  frontend-only enforcement.

Later slices reuse `engineering/fixtures/staff-access-authorization/cases.json`
and add their normal route-policy denial matrices.
