# External owner delegation authorization contract v1

_VAY-1321 contract record. Extends the VAY-1085 staff access contract and its
membership property-scope foundation._

## Scope and identity model

An agency portfolio remains one `hotel_group` organization. Agency
administrators, external property owners, and staff are users with memberships
in that organization; they are not global user account types. A user may hold a
different role in another organization without changing their identity.

WorkOS continues to own authentication, sessions, coarse organization
membership, and invitation delivery. Vayada owns the membership role,
delegation relationship, permissions, property assignments, and audit. No
second organization, portfolio, property-ownership, or invitation system is
introduced.

Internal membership roles have these meanings:

| Role                 | Meaning                                                          | Property mode         |
| -------------------- | ---------------------------------------------------------------- | --------------------- |
| `hotel_owner`        | Agency administrator for the whole hotel group                   | `all`                 |
| `external_owner`     | External owner of one or more properties in the agency portfolio | `assigned` only       |
| VAY-1085 staff roles | Agency- or external-owner-delegated employees                    | `assigned` by default |

The product label "Admin" maps to the existing `hotel_owner` role. The product
label "Owner" maps to `external_owner`; it must never use the historical
`owner` or `operator` aliases because those aliases retain compatibility
`all`-property access. WorkOS role slugs remain coarse claims and never decide
this hierarchy.

Provider invitations map internal `external_owner` to the configured non-admin
`hotel_member` WorkOS role, `hotel_manager` to `hotel_admin`, and other staff
roles to `hotel_member`. They never send `external_owner` or `hotel_owner` as
the provider role for those memberships. Provider-call tests assert this
mapping; reconciliation preserves the internal role independently of the
mirrored coarse slug.

WorkOS reconciliation may reduce access when provider membership becomes
inactive, but it must not overwrite an existing Vayada-managed `role_key`,
property mode, permission overrides, access origin, assignments, or delegation.
Provider `admin` and member claims update only provider status, IDs, and coarse
role slugs. A provider membership event without a matching Vayada invitation or
access grant is quarantined rather than bootstrapped as `hotel_owner`.

## Property and permission ceilings

`external_owner` always resolves through VAY-1085's `assigned` property mode.
Even when assigned every current property, the membership does not gain future
properties automatically. Multiple external owners may be assigned the same
canonical property, and one external owner may be assigned several properties.
No per-user organization resource links are created.

The database constrains `external_owner` to `assigned`, and runtime resolution
independently rejects an `external_owner` row with any other mode. A delegated
staff membership is also `assigned` only. A persisted role/mode or
origin/mode mismatch is malformed authorization data and grants nothing.

An agency administrator may invite an external owner or staff member and assign
any active canonical property in the organization. An external owner may invite
staff only when their resolved permissions include
`identity.staff.delegate`. That permission is distinct from
`identity.staff.manage`, which remains agency-admin-only.

An external owner delegation must satisfy both ceilings:

- every staff assignment is in the delegator's current effective property set;
- every staff permission is in the delegator's current delegable permission
  set and in the selected VAY-1085 staff-role ceiling.

The delegable set never contains `identity.staff.manage`,
`identity.staff.delegate`, `finance.billing.manage`, agency payment-provider or
channel-connection management, or another organization-level administration
permission. An external owner cannot create or modify `hotel_owner` or
`external_owner` memberships. Staff cannot delegate access.

Permission overrides remain membership-local. They can restrict an external
owner or delegated staff member but cannot exceed these ceilings. No implicit
role or permission hierarchy is inferred at runtime.

The `external_owner` default grants are:

| Control               | Default permission keys                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| PMS Dashboard         | `pms.dashboard.read`, `pms.dashboard.operations.read`, `pms.dashboard.finance.read` |
| PMS Calendar          | `pms.calendar.read`, `pms.calendar.manage`                                          |
| PMS Reservations      | `pms.reservation.read`, `pms.reservation.update`, `pms.reservation.cancel`          |
| PMS Inbox             | `pms.inbox.read`, `pms.inbox.reply`                                                 |
| PMS Rooms & Rates     | `pms.room_status.read`, `pms.rooms_rates.read`, `pms.rooms_rates.manage`            |
| PMS Channel Manager   | `pms.channel_manager.read`                                                          |
| PMS Financials        | `pms.finance.read`                                                                  |
| PMS Settings          | `pms.settings.read`                                                                 |
| Guest contact fields  | `pms.guest_contact.read`                                                            |
| Booking Dashboard     | `booking.analytics.read`                                                            |
| Booking Design Studio | `booking.design.read`, `booking.design.manage`                                      |
| Booking Flow          | `booking.flow.read`, `booking.flow.manage`                                          |
| Booking Settings      | `booking.settings.read`                                                             |

`identity.staff.delegate` is an optional agency grant and is off by default.
Agency-wide settings and billing permissions are never role defaults. If an
existing coarse settings permission would also mutate an agency-owned payment,
channel, integration, or plan setting, it must be split or paired with an
explicit agency-only policy before it can be granted to `external_owner`.

## Delegation persistence

Each membership stores a membership-local access origin: `agency` or
`external_owner`. This is delegation provenance, not a user account type.
Agency administrators and external owners have `agency` origin. Staff created
by an agency administrator have `agency` origin; staff created through an
external owner have `external_owner` origin.

The compatibility migration backfills every existing membership to `agency`
and may use that default only while existing writers are being upgraded. Every
membership writer must then persist an explicit origin, the steady-state schema
must be `NOT NULL` with no default, and delegation-aware runtime cannot activate
before that successor migration. Missing or unknown origin always fails closed.

An identity-owned `membership_delegations` relation records the live parent of
`external_owner`-origin staff. Agency-origin staff memberships have no
delegation row.

Each row identifies:

- the hotel-group organization;
- one subject staff membership;
- one delegator `external_owner` membership;
- the creating membership and audit timestamps.

The subject has at most one delegator. Subject, delegator, and creator must
belong to the same organization when the edge is written. The creator ID is
durable audit provenance and may outlive that membership. The subject cannot
equal the delegator. Delegators cannot themselves be delegated subjects, so the
model is exactly agency admin -> external owner -> staff; deeper chains and
cycles are invalid.

Same-organization foreign keys belong in the database. Role, status, property,
and permission checks run transactionally in the identity command because they
depend on current rows. Deleting a subject may cascade its edge. Deleting a
delegator must be restricted until dependent staff are explicitly reassigned or
suspended; removing the edge must never silently convert delegated staff into
agency-managed staff.

An `external_owner`-origin membership without exactly one valid delegation edge
fails closed. Deleting an edge alone is forbidden. Agency adoption is an
explicit atomic command that revalidates the staff scope and permissions,
changes the origin to `agency`, and only then removes the edge. Reparenting keeps
the origin `external_owner` and replaces the validated edge atomically.

VAY-1085's invitation persistence is reused. It must distinguish staff from
external-owner intent and store the inviter membership, not only the inviter
user. No VAY-1321-specific invitation table or provider flow is added.

## Effective access resolution

An external owner's effective properties are the VAY-1085 canonical
organization/property intersection for their assigned membership.

For agency-origin staff without a delegation row, VAY-1085 resolution is
unchanged. For external-owner-origin staff, every request requires one valid
edge whose active delegator still has `identity.staff.delegate`, and
additionally computes:

```text
effective properties
  = staff VAY-1085 effective properties
  intersect active delegator effective properties

effective permissions
  = staff resolved permissions
  intersect active delegator delegable permissions
  intersect staff-role ceiling
```

The request fails closed if the access origin is unknown, the required
delegation is absent, or the delegation is missing required data,
cross-organization, self-referential, chained, ambiguous, or attached to an
inactive or non-`external_owner` delegator. An inactive subject membership also
fails as it does today. Unknown roles, modes, permissions, and malformed
overrides grant nothing.

Changing an owner's assignments, permissions, delegation permission, or status
takes effect on the dependent staff member's next context resolution. No new
login is required. Suspending an external owner therefore suspends all access
derived through that owner until an agency administrator explicitly reparents
or replaces it.

The server decision order remains:

1. WorkOS identity, selected organization, internal user, and active membership.
2. Valid delegation and current delegator ceilings, when present.
3. Explicit deny, explicit grant, role default, and role ceiling.
4. Canonical membership property scope and matching target-native resource.
5. Active product entitlement and resource state.

Direct URLs and APIs run the full policy. Product access returns the same
generic `403` for unassigned, other-owner, and cross-tenant properties.

Every list, search, export, dashboard, and aggregate query applies the effective
property set in repository SQL before joins, aggregation, or pagination.
Filtering an organization-wide result in memory is forbidden. Endpoints that
cannot express that scope are agency-admin-only until they can; owner access
never implies organization-wide financial or operational visibility.

## Invitation and mutation rules

Agency-admin invitations to `external_owner` must persist `assigned` mode and
at least one valid property assignment. Acceptance revalidates the current
agency organization and assignment set before activating the membership. Both
external owners and agency-created staff persist `agency` origin.

External-owner staff invitations store the delegator membership. Acceptance
revalidates the delegator's current status, `identity.staff.delegate`
permission, effective properties, delegable permissions, and requested staff
role in the same transaction that activates the membership and delegation.
It persists `external_owner` origin. Expired snapshots never authorize access.

An external owner may resend or replace only a pending invitation created by
that same delegator for the same intent. They may edit only an existing staff
membership whose live delegation points to them. A pending invitation or
membership owned by the agency or another external owner remains unchanged;
the response does not disclose which collision occurred and no WorkOS call is
made. Invitation uniqueness and row locking serialize concurrent claims for the
same organization/email. Only an agency administrator may explicitly
supersede, adopt, or reparent another inviter's intent or membership.

Assignment or permission edits run the same subset checks. An agency
administrator may reparent delegated staff, but the replacement transaction
must validate the new parent before removing the old edge. Deactivation and
removal preserve audit and affect only the selected organization membership.

## Team visibility

Agency administrators may list and manage all memberships in the organization.
An external owner may list and manage only staff whose live delegation points
to them. Agency-managed staff, other owners, and other owners' staff remain
hidden even when property assignments overlap.

Tenant, owner, or assignment mismatches return `404` from team lookups. Product
resource checks continue to use generic `403`. List queries apply these scopes
in SQL before pagination rather than filtering an unscoped result in memory.

## Audit

Invitation, acceptance, assignment, permission, delegation, reparenting,
deactivation, and removal events record organization ID, affected property IDs,
redacted permission changes, outcome/reason, request ID, correlation ID, and
timestamp. Actor and subject membership ID fields are nullable because an
invitation exists before its subject membership; invitation and acceptance
events require the invitation ID, and acceptance records the activated subject
membership ID. Other membership-targeting events require their applicable
actor and subject membership IDs. Provider tokens, acceptance URLs, and
unrelated owner/staff details are never stored in audit metadata.

## Required implementation tests

Every implementation slice covers its applicable rows from this matrix:

- agency admin may create assigned external-owner access to an organization
  property but not a foreign property;
- external owner may access assigned properties and is denied unassigned,
  newly added, inactive-link, and cross-tenant properties;
- two owners sharing one property do not expose either owner's other properties,
  staff, permissions, or financial aggregation;
- owner-delegated staff are limited to both the staff and owner property and
  permission sets;
- removing owner scope, permission, delegation permission, or active status
  removes derived staff access on the next request;
- owner attempts to delegate admin/owner roles, forbidden permissions, `all`
  mode, or out-of-scope properties are rejected atomically;
- persisted `external_owner/all`, delegated-staff/all, unknown-origin, and
  external-owner-origin-without-edge rows fail closed at runtime;
- staff delegation, cross-organization edges, self edges, chains, cycles,
  missing parents, unknown roles, and malformed data fail closed;
- WorkOS admin/member reconciliation preserves Vayada role, property mode,
  overrides, origin, assignments, and delegation;
- concurrent owner/owner and admin/owner invitation collisions never replace or
  reveal another inviter's pending intent or existing membership;
- same-tenant-hidden and cross-tenant denial bodies are indistinguishable, and
  unauthorized team lookups return the same `404`;
- retries do not duplicate invitations, memberships, assignments, delegation
  edges, provider calls, or audit events.

## Rollout and exclusions

Implementation stacks after the VAY-1085 schema, explicit writers,
default-assigned repair, and effective-property-access guard. Schema precedes
writers; writers and WorkOS reconciliation must preserve Vayada roles, scopes,
overrides, origins, and delegations before delegation-aware runtime ships.
Runtime precedes invitation activation and production-route adoption.

This contract does not add DDL, commands, WorkOS calls, production route
adoption, settings UI, an owner permission editor, property-level setting
locks, cross-portfolio aggregation, or VAY-1322 navigation. Those remain narrow
follow-up slices. Visibility of agency-managed staff in an external owner's
team view also requires a separate product decision and field-level privacy
contract. The next safe slice is the membership access-origin and delegation
schema with constraints, rebuild tests, and cross-tenant tests.
