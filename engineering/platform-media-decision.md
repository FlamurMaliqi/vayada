# Platform Media and Object-Storage Ownership

_VAY-806 decision record. Inputs:
[`marketplace-route-migration-inventory.md`](marketplace-route-migration-inventory.md),
[`booking-pms-route-migration-inventory.md`](booking-pms-route-migration-inventory.md),
[`target-schema-ownership-map.md`](target-schema-ownership-map.md),
[`public-hotel-profile-ownership.md`](public-hotel-profile-ownership.md), and
[`property-catalog-backfill-plan.md`](property-catalog-backfill-plan.md)._

## Purpose

Media upload is a cross-cutting storage concern, not a marketplace, booking, or
PMS route family. Legacy routes upload directly through product APIs, return raw
S3 URLs, and let product records store those URLs without a shared object
contract. This document decides object-storage ownership, upload and serving
contracts, migration rules for existing URLs, and which legacy routes retire or
receive target equivalents.

This is a decision record only. It does not change app code or provision
infrastructure.

## Decision

Vayada will create one platform media service for object storage and media
processing. Product domains will own business meaning and references to media,
but they will not own buckets, public ACLs, raw S3 key construction, or upload
validation.

Storage uses one platform-owned media bucket per environment, fronted by the
platform CDN. The platform media service owns:

- bucket, key namespace, lifecycle, encryption, CDN origin policy, and object
  metadata;
- signed upload and download URL generation;
- MIME sniffing, image validation, size limits, variant generation, malware
  scanning where available, and object promotion from staging to active keys;
- media object registry and audit state used by migration, deletion, and
  retention workflows.

Domain ownership remains explicit:

- Hotel/property catalog owns public property media metadata in
  `hotel_catalog.property_media` and projects approved media into
  `property_public_profile_read_model`.
- Marketplace owns creator profile picture references,
  `marketplace.marketplace_hotel_listings.image_urls`, and private
  collaboration chat attachments.
- PMS owns room media snapshots and PMS messaging attachment records, while
  platform media owns the stored bytes for Vayada-hosted attachments.
- Booking owns booking-web presentation settings that reference media, but not
  the object-storage path.

## Storage Layout

Use a single bucket per environment, for example
`vayada-media-{environment}`, managed outside this app repo by platform
infrastructure. Do not create per-product buckets. Product separation happens
through typed media purposes, resource ownership checks, object metadata, and
prefixes, not through separate storage stacks.

Recommended active prefixes:

```text
public/properties/{propertyId}/{mediaId}/{variant}.{ext}
public/marketplace/listings/{listingId}/{mediaId}/{variant}.{ext}
public/marketplace/creators/{creatorId}/{mediaId}/{variant}.{ext}
private/marketplace/collaborations/{collaborationId}/{mediaId}/{originalName}
private/pms/properties/{propertyId}/messages/{threadId}/{mediaId}/{originalName}
private/pms/properties/{propertyId}/imports/{jobId}/{mediaId}/{variant}.{ext}
staging/{uploadSessionId}/{clientFileIndex}/{originalName}
```

Prefixes are implementation detail. Clients receive opaque `mediaId`, status,
and either a CDN URL for public media or a short-lived download URL for private
media.

The target implementation should add platform-owned media registry tables before
new upload routes are cut over. Minimal required fields:

- `media_objects`: `id`, `source_type` (`uploaded`, `copied_from_legacy`,
  `external_reference`), nullable `storage_key`, nullable `bucket`,
  `visibility`, `purpose`, `owner_organization_id`, optional `property_id`,
  optional domain resource reference, `status`, `content_type`, `size_bytes`,
  `checksum`, dimensions, original filename, `source_url`, source system,
  retention/delete state, and audit timestamps.
- `media_variants`: `media_object_id`, variant name, storage key, content type,
  width, height, size, and public CDN URL when public.
- `media_upload_sessions`: session ID, requested purpose, actor, resource scope,
  expected content type/size, expiry, status, and completion metadata.

For `external_reference` rows, `bucket` and `storage_key` are null until the
object is copied into the platform bucket, and `source_url` is required. Public
read models may serve the preserved external URL while the row remains in that
state, but lifecycle/deletion jobs must treat it as an unresolved migration item
rather than a platform-owned object.

## Upload Contract

Default uploads use signed direct-to-object-storage upload plus a finalize call:

1. Client requests an upload session from `apps/api` with purpose, resource
   scope, filename, content type, size, and optional count.
2. Platform media authorizes the actor against RequestContext and the target
   resource, returns one signed upload target per file, and records a pending
   session.
3. Client uploads directly to `staging/...`.
4. Client finalizes the session. Platform media reads the staged object,
   validates by content sniffing, generates variants, writes registry rows, and
   promotes or copies the object to the active key.
5. The owning domain command attaches the returned `mediaId` or public URL to
   the domain record.

Use proxied upload only where the backend must inspect or transform bytes before
storage, or where a provider upload is part of the product command:

- server-side image import from external URLs;
- temporary legacy compatibility endpoints during cutover;
- PMS messaging attachments that must be forwarded to Channex/OTAs after
  platform validation.

This avoids routing normal browser uploads through product APIs while preserving
backend control for workflows that are not simple object writes.

### Property-media authorization compatibility

The canonical property-media route contract uses
`PROPERTY_MEDIA_AUTHORIZATION`: permission `hotel_catalog.setup.manage`, an
active `hotel_catalog:property` resource link, and relationship `owner` or
`operator`. The shared platform-media client accepts that resource shape.

Until Booking Admin and Marketplace hotel-profile uploads have canonical
property IDs in their session state, `apps/api` keeps a bounded compatibility
input for `booking:booking_hotel` and `marketplace:hotel_profile`. Those inputs
retain their existing `booking.settings.manage` or
`marketplace.profile.manage` permission check and exact active source-resource
link check. The persistent target resolver must then resolve exactly one active
`hotel_catalog.property_source_links` row and replace the caller's resource
with the canonical `hotel_catalog:property` target before a session is stored.
It rejects missing or ambiguous mappings and never trusts a caller-provided
target property ID. The compatibility path does not create a second property
media owner or dual-write product media state.

`apps/booking-admin/lib/utils/uploadImage.ts` is the remaining Booking producer
of the legacy resource shape. It must switch to the canonical property resource
as soon as Booking session state exposes that ID. Marketplace callers must do
the same before the legacy hotel-profile input is removed. Removal requires
tests proving both clients use canonical resource links; it does not depend on
or introduce a publisher or PMS runtime adapter.

## Validation and Limits

Platform media applies a purpose-specific policy before signing and again during
finalize. Signed upload constraints are advisory; finalize is authoritative.

| Purpose                              | Visibility                                         | Allowed types                         | Limit                                                                  |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| Property hero/gallery/logo           | Public after approval                              | JPEG, PNG, WebP                       | 10 MB per file, 25 files per property gallery                          |
| Marketplace listing gallery          | Public when listing is public                      | JPEG, PNG, WebP                       | 10 MB per file, 12 files per listing                                   |
| Creator profile image                | Public when profile is public                      | JPEG, PNG, WebP                       | 5 MB, one active profile image                                         |
| Marketplace collaboration chat image | Private                                            | JPEG, PNG, WebP, GIF                  | 20 MB                                                                  |
| PMS room media                       | Public only when projected by Distribution/catalog | JPEG, PNG, WebP                       | 10 MB per file, 20 files per room type                                 |
| PMS messaging attachment             | Private                                            | JPEG, PNG, WebP, GIF, HEIC, HEIF, PDF | Provider/channel limit, default 25 MB; Booking.com 8 MB, Expedia 10 MB |
| Import source image                  | Private staging until attached                     | JPEG, PNG, WebP from fetched source   | 10 MB fetched object, 20 source URLs per import job                    |

All image policies must reject empty files, invalid image headers, MIME/content
mismatches, decompression-bomb dimensions, and unsupported extensions. Public
images should generate at least original-safe, large, thumbnail, and blur/preview
variants. Strip EXIF/GPS metadata from public variants unless a later product
decision explicitly preserves selected fields.

## Access and Serving

The bucket stays private. Do not use product APIs or client code to set public
object ACLs.

Public media is served through the platform CDN with long cache TTLs and
immutable versioned URLs. Public CDN URLs may be stored in domain read models
for compatibility, but the object registry remains the source for key, variant,
visibility, and lifecycle. Replacing an image creates a new media object or
variant URL; do not overwrite stable URLs in place.

Private media is never exposed through public CDN paths. Private downloads use
short-lived signed URLs or a thin platform media download endpoint that enforces
RequestContext. PMS/Channex attachment `source_url` values from providers remain
private integration metadata unless copied into Vayada storage and explicitly
authorized for download.

Public approval is separate from upload success. A completed upload may remain
private until the owning domain marks it public-safe.

Hotel-media finalization leaves the object and safe variants private. A later
Hotel Catalog or PMS assignment command performs the owning-domain approval,
promotes the selected variants, and atomically updates the revisioned
assignment set. Upload purpose records why the object entered the library; it
does not restrict whether the same property-owned object can later be assigned
as logo, cover, gallery, or room media.

### Serving Environment Contract

VAY-821 implements the app-side serving contract without changing production
environment values. Activation happens at media cutover by provisioning all
required values together in deployment secrets/task definitions:

- `PLATFORM_MEDIA_BUCKET` — private platform media bucket for the environment.
- `PLATFORM_MEDIA_CDN_BASE_URL` — public HTTPS CDN origin, with no path, query,
  or fragment.
- `PLATFORM_MEDIA_CDN_ORIGIN_HOST` — private bucket origin host used by the CDN.

Optional serving controls:

- `PLATFORM_MEDIA_PUBLIC_PATH_PREFIX` defaults to `media`.
- `PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL` defaults to
  `public, max-age=31536000, immutable`.
- `PLATFORM_MEDIA_PRIVATE_DOWNLOAD_TTL_SECONDS` defaults to `300`.
- `PLATFORM_MEDIA_PRIVATE_DOWNLOAD_MAX_TTL_SECONDS` defaults to `900` and may
  not exceed `3600`.

The public URL shape is:

```text
{PLATFORM_MEDIA_CDN_BASE_URL}/{prefix}/{mediaId}/{variant}/{version}.{ext}
```

`mediaId`, `variant`, and `version` are opaque registry values. Public URLs do
not expose bucket names, raw storage keys, or private prefixes. Public variants
must be active, public, and domain-approved before a CDN URL is issued.

Private media download signing takes the platform bucket, a `private/...`
storage key, `GET`, the configured short TTL, and `Cache-Control: private,
no-store`. Public objects are not eligible for this policy, and private objects
must never receive a public CDN URL.

Cache invalidation is not part of normal replacement. Public media replacement
must publish a new immutable URL by creating a new media object or variant
version. The retired URL may stay cacheable through its TTL or be lifecycle
deleted after retention/rollback windows; do not overwrite the object behind an
existing public URL.

## Property Catalog and Discovery Consumption

Property catalog consumes platform media through `mediaId` plus CDN URL, not
through raw upload route responses. `hotel_catalog.property_media` remains the
field-level owner for property hero, gallery, and logo metadata. It records the
public presentation fields already present in target DDL: media type, URL,
alt text, sort order, source system, public approval, and rights metadata. A
future DDL slice should add a nullable `platform_media_object_id` link once the
platform registry exists.

`property_public_profile_read_model.media` includes only `public_approved`
property media. Distribution and Booking Web consume that read model for public
profile images.

Marketplace discovery keeps the existing split from
`marketplace-discovery-contract.md`:

- `coverImageUrl` comes from the property catalog public profile media.
- `imageUrls` comes from `marketplace.marketplace_hotel_listings.image_urls`
  and represents listing-specific gallery images only.

Listing galleries may be public marketplace media, but they are not promoted to
canonical property gallery media unless the hotel/property catalog owner
approves that promotion.

## Existing URL Migration

The one-time cutover migration must preserve every existing stored URL and
classify each row before rewriting consumers.

Migration rules:

1. Inventory media-bearing fields from Booking, Marketplace, and PMS source
   snapshots: Booking `hero_image` and `images`; Marketplace hotel/listing
   images, creator `profile_picture`, chat image messages; PMS room type
   `images`, import-produced images, and `message_attachments`.
2. Parse existing Vayada-owned S3 URLs into bucket/key where possible. Copy or
   tag them into the new platform bucket without changing the old object until
   parity passes.
3. For external URLs, keep `source_url`, attempt a controlled server-side copy
   only when the URL is reachable and license/rights metadata permits it, and
   mark uncopied URLs as `external_reference` so read models can continue to
   serve them until manual cleanup.
4. Create `media_objects` rows for every copied or externally referenced object
   with source system, source table, source row ID, checksum where available,
   and visibility.
5. Populate domain references:
   - property hero/gallery/logo rows in `hotel_catalog.property_media`;
   - marketplace listing `image_urls` with platform CDN URLs when copied, or
     preserved external URLs when not;
   - creator profile picture URL from the active public variant;
   - PMS room `media_snapshot` with public-safe room image variants;
   - PMS `message_attachments.s3_key`/`source_url` for private attachments.
6. Run parity checks before cutover: source URL count, copied object count,
   unresolved external URL count, public/private classification, and no private
   key leakage in public read models.
7. Keep old URLs readable through the rollback window. Delete or lifecycle old
   objects only after the cutover is accepted and orphan checks pass.

Migration should not infer public approval from existence alone. Public approval
comes from existing public product usage plus the property catalog conflict
rules: owner/admin approved media, then Booking public media, then Marketplace
approved listing media, then PMS property/room media only when explicitly
public-approved.

## Legacy Route Disposition

These route shapes retire instead of being ported 1:1.

| Legacy route                                                | Disposition                                                  | Target equivalent                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marketplace `POST /upload/image`                            | Retire generic product upload.                               | `POST /api/media/upload-sessions` with explicit purpose, then finalize.                                                                              |
| Marketplace `POST /upload/images`                           | Retire generic product upload.                               | Batch upload session with explicit purpose and resource scope.                                                                                       |
| Marketplace `POST /upload/image/hotel-profile`              | Replace.                                                     | Platform media purpose `property.hero_image`; catalog/profile command attaches approved media to `hotel_catalog.property_media`.                     |
| Marketplace `POST /upload/image/listing`                    | Replace.                                                     | Platform media purpose `marketplace.listing.gallery`; marketplace listing command attaches returned media.                                           |
| Marketplace `POST /upload/images/listing`                   | Replace.                                                     | Batch `marketplace.listing.gallery` upload session.                                                                                                  |
| Marketplace `POST /upload/image/creator-profile`            | Replace.                                                     | Platform media purpose `marketplace.creator.profile_image`; creator profile command stores the active public profile image.                          |
| Marketplace `POST /upload/image/chat`                       | Replace.                                                     | Private platform media purpose `marketplace.collaboration_chat.attachment`; marketplace collaboration message command attaches media by ID.          |
| Marketplace `POST /hotels/me/upload-picture`                | Retire deprecated helper.                                    | Same catalog property media flow as `property.hero_image`.                                                                                           |
| Marketplace `POST /hotels/me/listings/{id}/upload-images`   | Retire deprecated helper.                                    | Same `marketplace.listing.gallery` batch flow, followed by listing update.                                                                           |
| Booking `POST /admin/upload/images`                         | Retire Booking-to-PMS proxy.                                 | Booking Admin uses platform media upload sessions; the property catalog media command attaches approved media to `hotel_catalog.property_media`.     |
| PMS `POST /upload/images`                                   | Replace after canonical legacy PMS cutover; keep as compatibility until then. | Platform media purpose `pms.room_type.media`; target PMS room-type commands store media references, while the frozen canonical frontend still requires the Python route. |
| PMS `POST /admin/import/images`                             | Retire with PMS listing import.                              | No replacement.                                                                                                                                      |
| PMS `POST /admin/messaging/threads/{thread_id}/attachments` | Keep as a PMS messaging command, not a generic upload route. | PMS validates thread access, platform media validates/stores private attachment, then PMS forwards to Channex/OTA and stores provider attachment ID. |

## Tradeoffs

One bucket per environment keeps lifecycle, CDN, encryption, and migration
operations centralized. The tradeoff is that the platform media registry and
authorization policy must be correct; prefixes alone are not a security
boundary. Per-domain buckets would make some IAM policies simpler, but would
duplicate CDN/variant/lifecycle work and preserve the product-silo behavior the
rewrite is removing.

Signed direct upload avoids product API bandwidth and timeout pressure. The
tradeoff is a two-step client contract and a stricter finalize path. Proxied
uploads remain available only where backend byte handling is part of the
business workflow.

Storing public CDN URLs in existing domain tables preserves current read-model
contracts while the platform registry is introduced. The tradeoff is temporary
duplication; the registry remains authoritative for object lifecycle and
domain tables remain authoritative for business presentation.

External-reference rows preserve hard-to-copy media without blocking cutover.
The tradeoff is that the platform cannot enforce deletion, variant generation,
or uptime for those URLs until they are copied. Keeping them explicit in
`media_objects.source_type` makes that risk queryable and keeps cleanup work
out of product tables.

## Assignment Constraint Cutover

The initial canonical-assignment migration adds
`chk_property_media_sort_order` and
`fk_property_media_platform_object_property` as `NOT VALID`. New and updated
rows are still checked immediately, while existing legacy rows can be cleaned
without holding the deployment migration open.

The property-media writer cutover must inventory and repair negative sort
orders and property/object ownership mismatches. After that parity check passes,
a dedicated follow-up migration must run:

```sql
ALTER TABLE hotel_catalog.property_media
  VALIDATE CONSTRAINT chk_property_media_sort_order;
ALTER TABLE hotel_catalog.property_media
  VALIDATE CONSTRAINT fk_property_media_platform_object_property;
```

That follow-up migration must verify both constraints have
`pg_constraint.convalidated = true`. The initial migration's regression test
deliberately expects `false`; changing that expectation before legacy cleanup
would hide an incomplete cutover.

## Implementation Tickets to Create on Acceptance

1. Define platform media registry DDL and migration contracts.
   - Add platform media tables, purpose enum/checks, lifecycle status, and
     parity requirements.
2. Implement platform media upload-session and finalize routes in `apps/api`.
   - Include RequestContext authorization, purpose policies, signed URL
     generation, final validation, variant generation, and audit events.
3. Implement platform CDN/public-private serving integration.
   - Add environment contract for bucket/CDN origin, public URL shape, private
     signed download policy, and cache invalidation/versioning rules.
4. Add one-time media URL migration and parity fixtures.
   - Cover Booking hero/images, Marketplace listing/profile/chat URLs, PMS room
     images/imports, and PMS message attachments.
5. Wire property catalog media consumption to platform media.
   - Add `platform_media_object_id` where appropriate and ensure
     `property_public_profile_read_model.media` exposes only approved public
     variants.
6. Replace marketplace upload routes with platform media clients.
   - Retire `/upload/*`, `/hotels/me/upload-picture`, and
     `/hotels/me/listings/{id}/upload-images` after marketplace profile/listing
     commands attach media by ID.
7. Replace marketplace collaboration chat uploads.
   - Move `/upload/image/chat` to a marketplace collaboration message
     attachment command using `marketplace.collaboration_chat.attachment`
     private media.
8. Replace Booking/PMS image upload and import flows.
   - Remove Booking proxy upload, move PMS room images to platform media, and
     move import downloads to PMS import commands that create target media
     import jobs.
9. Replace PMS messaging attachment handling.
   - Keep the PMS thread command surface, but store private attachments through
     platform media before forwarding to Channex and recording provider IDs.
10. Add orphan cleanup, retention, and deletion jobs.

- Handle abandoned staging uploads, replaced public images, private
  attachment retention, and rollback-window cleanup.
