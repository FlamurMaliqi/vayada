import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPlatformMediaRepository } from "./platform/platformMediaRepository.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import {
  BookingContactPublicationConflictError,
  createPgTargetBookingSettingsRepository,
} from "./routes/bookingSettings.js";
import type { SharedPropertyProfileInput } from "./routes/sharedHotelSetupStatus.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "77777777-7777-4777-8777-777777777965";
const mediaObjectId = "77777777-7777-4777-8777-777777777966";
const invalidMediaObjectId = "77777777-7777-4777-8777-777777777967";
const actorUserId = "77777777-7777-4777-8777-777777777968";
const membershipId = "77777777-7777-4777-8777-777777777976";
const secondActorUserId = "77777777-7777-4777-8777-777777777977";
const secondMembershipId = "77777777-7777-4777-8777-777777777978";
const uploadSessionId = "77777777-7777-4777-8777-777777777969";
const roomTypeWithRoomId = "77777777-7777-4777-8777-777777777970";
const roomTypeWithRateId = "77777777-7777-4777-8777-777777777971";
const roomTypeWithInventoryId = "77777777-7777-4777-8777-777777777972";
const physicalRoomId = "77777777-7777-4777-8777-777777777973";
const fragmentedRatePlanId = "77777777-7777-4777-8777-777777777974";
const coherentRatePlanId = "77777777-7777-4777-8777-777777777975";

const profile: SharedPropertyProfileInput = {
  displayName: "Profile Revision Test Hotel",
  propertyType: "hotel",
  location: {
    streetAddress: "Teststrasse 1",
    postalCode: "10115",
    city: "Berlin",
    countryCode: "DE",
    timezone: "Europe/Berlin",
    latitude: null,
    longitude: null,
    localityPublic: false,
    geoPublic: false,
    mapDisplayMode: "hidden",
  },
  contacts: [
    {
      channelType: "email",
      value: "reception@example.test",
      purpose: "guest",
      isPublic: false,
    },
    {
      channelType: "phone",
      value: "+49 30 1234567",
      purpose: "operations",
      isPublic: false,
    },
  ],
};

describe.skipIf(!TEST_DATABASE_URL)("canonical property profile repository", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const repository = createPgSharedHotelSetupStatusRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const platformMediaRepository = createPgPlatformMediaRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    publicCdnBaseUrl: "https://cdn.example.test",
  });
  const bookingSettingsRepository = createPgTargetBookingSettingsRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await cleanup();
    await client.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES
         ($1::uuid, 'profile-revision-actor@example.test', 'Profile Revision Actor', 'active'),
         ($2::uuid, 'profile-revision-second@example.test', 'Second Profile Actor', 'active')`,
      [actorUserId, secondActorUserId],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Profile Revision Test Group', 'profile-revision-test', 'active')`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships (
         id, organization_id, user_id, status, role_key
       ) VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'active', 'hotel_owner'),
         ($4::uuid, $2::uuid, $5::uuid, 'active', 'hotel_owner')`,
      [membershipId, organizationId, actorUserId, secondMembershipId, secondActorUserId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.organization_setup_track_intents (
         organization_id,
         selected_tracks
       )
       VALUES ($1::uuid, ARRAY['creator_marketplace']::text[])`,
      [organizationId],
    );
  });

  it("provisions one canonical property for concurrent stable-reference commands", async () => {
    const provisioningReference = "platform-admin-provisioning-integration";
    const create = (idempotencyKey: string) =>
      repository.createPropertyProfile({
        organizationId,
        idempotencyKey,
        correlationId: idempotencyKey,
        profile: { ...profile, displayName: "Provisioned Lifecycle Hotel" },
        targetAccountUserId: actorUserId,
        provisioningReference,
        audit: {
          actorUserId,
          requestId: idempotencyKey,
          receivedAt: "2026-08-13T12:00:00.000Z",
          reason: "Owner onboarding request",
        },
      });

    const [first, retry] = await Promise.all([
      create("platform-provision-concurrent-a"),
      create("platform-provision-concurrent-b"),
    ]);
    expect(retry.propertyId).toBe(first.propertyId);
    await expect(create("platform-provision-concurrent-c")).resolves.toMatchObject({
      propertyId: first.propertyId,
    });
    await expect(
      repository.createPropertyProfile({
        organizationId,
        idempotencyKey: "platform-provision-concurrent-a",
        correlationId: "platform-provision-changed-reason",
        profile: { ...profile, displayName: "Provisioned Lifecycle Hotel" },
        targetAccountUserId: actorUserId,
        provisioningReference,
        audit: {
          actorUserId,
          requestId: "platform-provision-changed-reason",
          receivedAt: "2026-08-13T12:00:00.000Z",
          reason: "A different command reason",
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    await expect(
      repository.createPropertyProfile({
        organizationId,
        idempotencyKey: "platform-provision-different-profile",
        correlationId: "platform-provision-different-profile",
        profile: { ...profile, displayName: "Different provisioning intent" },
        targetAccountUserId: actorUserId,
        provisioningReference,
      }),
    ).rejects.toMatchObject({ code: "provisioning_reference_conflict" });
    await expect(
      repository.createPropertyProfile({
        organizationId,
        idempotencyKey: "platform-provision-different-account",
        correlationId: "platform-provision-different-account",
        profile: { ...profile, displayName: "Provisioned Lifecycle Hotel" },
        targetAccountUserId: secondActorUserId,
        provisioningReference,
      }),
    ).rejects.toMatchObject({ code: "provisioning_reference_conflict" });

    await expect(
      client.query(
        `SELECT
           (SELECT count(*)::int FROM hotel_catalog.property_source_links
            WHERE source_system = 'platform'
              AND source_table = 'platform_admin_provisioning'
              AND source_id = $1) AS source_links,
           (SELECT count(*)::int FROM identity.organization_resource_links
            WHERE organization_id = $2::uuid AND product = 'hotel_catalog'
              AND resource_type = 'property' AND resource_id = $3) AS organization_links,
           (SELECT count(*)::int FROM platform.product_audit_events
            WHERE product = 'hotel_catalog' AND action = 'hotel_setup.property.create'
              AND organization_id = $2::uuid AND target_resource_id = $3) AS creation_audits`,
        [provisioningReference, organizationId, first.propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [{ source_links: 1, organization_links: 1, creation_audits: 1 }],
    });
  });

  afterAll(async () => {
    await Promise.all([
      repository.close?.(),
      platformMediaRepository.close?.(),
      bookingSettingsRepository.close?.(),
    ]);
    await cleanup();
    await client.end();
  });

  it("round-trips shared and public profiles with one numeric revision", async () => {
    const created = await repository.createPropertyProfile({
      organizationId,
      idempotencyKey: "profile-revision-integration-create",
      correlationId: "profile-revision-integration-create",
      profile,
    });
    expect(created).toMatchObject({
      profileRevision: 1,
      profile: {
        contacts: expect.arrayContaining(profile.contacts),
        location: {
          localityPublic: false,
          geoPublic: false,
          mapDisplayMode: "hidden",
        },
      },
    });
    await expect(
      repository.createPropertyProfile({
        organizationId,
        idempotencyKey: "profile-revision-integration-create",
        correlationId: "profile-revision-integration-conflict",
        profile: { ...profile, displayName: "Changed after uncertain save" },
      }),
    ).rejects.toMatchObject({
      code: "idempotency_key_conflict",
      propertyId: created.propertyId,
    });

    const updatedProfile: SharedPropertyProfileInput = {
      ...profile,
      displayName: "Profile Revision Test Hotel Updated",
      contacts: profile.contacts.map((contact) =>
        contact.channelType === "email"
          ? { ...contact, purpose: "creator", isPublic: true }
          : contact,
      ),
    };
    const updated = await repository.updatePropertyProfile({
      organizationId,
      propertyId: created.propertyId,
      expectedProfileRevision: 1,
      profile: updatedProfile,
    });
    expect(updated).toMatchObject({
      profileRevision: 2,
      profile: {
        displayName: "Profile Revision Test Hotel Updated",
        contacts: expect.arrayContaining(updatedProfile.contacts),
      },
    });

    await expect(
      repository.updatePropertyProfile({
        organizationId,
        propertyId: created.propertyId,
        expectedProfileRevision: 1,
        profile,
      }),
    ).resolves.toBeNull();

    await expect(
      repository.getPublicPropertyProfile({
        organizationId,
        propertyId: created.propertyId,
      }),
    ).resolves.toEqual({
      propertyId: created.propertyId,
      profileRevision: 2,
      publicProfile: {
        locale: "en",
        shortDescription: null,
        longDescription: null,
        media: [],
      },
    });

    await client.query(
      `INSERT INTO platform.media_objects (
         id,
         bucket,
         storage_key,
         storage_kind,
         visibility,
         purpose,
         owner_organization_id,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         lifecycle_status,
         content_type,
         size_bytes,
         source_system,
         public_approved
       )
       VALUES (
         $1::uuid,
         'vayada-test-media',
         'properties/profile-revision-test/hero.webp',
         'vayada_managed',
         'public',
         'property.hero_image',
         $2::uuid,
         $3::uuid,
         'marketplace',
         'hotel_profile',
         $3,
         'active',
         'image/webp',
         1024,
         'platform',
         TRUE
       )`,
      [mediaObjectId, organizationId, created.propertyId],
    );
    await client.query(
      `INSERT INTO platform.media_variants (
         media_object_id,
         variant_name,
         visibility,
         storage_key,
         content_type,
         size_bytes,
         public_cdn_url
       )
       VALUES (
         $1::uuid,
         'original_safe',
         'public',
         'properties/profile-revision-test/hero.webp',
         'image/webp',
         1024,
         'https://cdn.example.test/properties/profile-revision-test/hero.webp'
       )`,
      [mediaObjectId],
    );

    const publicUpdate = await repository.updatePublicPropertyProfile({
      organizationId,
      propertyId: created.propertyId,
      expectedProfileRevision: 2,
      patch: {
        shortDescription: "A canonical public description.",
        media: [{ mediaObjectId, altText: "Hotel entrance", sortOrder: 0 }],
      },
    });
    expect(publicUpdate).toMatchObject({
      status: "updated",
      profile: {
        profileRevision: 3,
        publicProfile: {
          locale: "en",
          shortDescription: "A canonical public description.",
          longDescription: null,
          media: [
            {
              mediaObjectId,
              mediaType: "hero_image",
              url: "https://cdn.example.test/properties/profile-revision-test/hero.webp",
              altText: "Hotel entrance",
              sortOrder: 0,
            },
          ],
        },
      },
    });
    await expect(readProfileCompleteness(created.propertyId)).resolves.toEqual({
      profileStatus: "complete",
      completenessReasons: [],
    });

    const descriptionOnly = await repository.updatePublicPropertyProfile({
      organizationId,
      propertyId: created.propertyId,
      expectedProfileRevision: 3,
      patch: { longDescription: "A longer canonical public description." },
    });
    expect(descriptionOnly).toMatchObject({
      status: "updated",
      profile: {
        profileRevision: 4,
        publicProfile: {
          shortDescription: "A canonical public description.",
          longDescription: "A longer canonical public description.",
          media: [{ mediaObjectId }],
        },
      },
    });

    const clearedMedia = await repository.updatePublicPropertyProfile({
      organizationId,
      propertyId: created.propertyId,
      expectedProfileRevision: 4,
      patch: { media: [] },
    });
    expect(clearedMedia).toMatchObject({
      status: "updated",
      profile: {
        profileRevision: 5,
        publicProfile: {
          shortDescription: "A canonical public description.",
          longDescription: "A longer canonical public description.",
          media: [],
        },
      },
    });
    await expect(readProfileCompleteness(created.propertyId)).resolves.toEqual({
      profileStatus: "incomplete",
      completenessReasons: ["media"],
    });

    await expect(
      repository.updatePublicPropertyProfile({
        organizationId,
        propertyId: created.propertyId,
        expectedProfileRevision: 4,
        patch: { shortDescription: "Stale public edit" },
      }),
    ).resolves.toEqual({ status: "conflict", currentRevision: 5 });

    await expect(
      repository.updatePublicPropertyProfile({
        organizationId,
        propertyId: created.propertyId,
        expectedProfileRevision: 5,
        patch: {
          media: [{ mediaObjectId: invalidMediaObjectId, altText: null, sortOrder: 0 }],
        },
      }),
    ).resolves.toEqual({
      status: "invalid_media",
      mediaObjectIds: [invalidMediaObjectId],
    });

    const uploadSession = await platformMediaRepository.createUploadSession({
      sessionId: uploadSessionId,
      uploadSessionKey: "profile-revision-platform-upload",
      stagingPrefix: "staging/profile-revision-platform-upload",
      context: {
        actor: { internalUserId: actorUserId },
        selectedOrganization: { organizationId },
      } as never,
      request: {
        purpose: "property.gallery_image",
        visibility: "public",
        resource: {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: created.propertyId,
        },
        files: [
          {
            clientFileId: "profile-revision-gallery",
            filename: "gallery.jpg",
            contentType: "image/jpeg",
            sizeBytes: 2048,
          },
        ],
      },
      policy: {
        purpose: "property.gallery_image",
        autoApprovePublicOnFinalize: true,
      } as never,
      target: {
        resourceProduct: "hotel_catalog",
        resourceType: "property",
        resourceId: created.propertyId,
        propertyId: created.propertyId,
      },
      uploadTargets: [
        {
          uploadTargetId: "profile-revision-gallery-target",
          clientFileId: "profile-revision-gallery",
          method: "PUT",
          uploadUrl: "https://s3.example.test/signed",
          headers: { "content-type": "image/jpeg" },
          stagingKey: "staging/profile-revision-platform-upload/gallery.jpg",
          expiresAt: "2026-07-26T20:15:00.000Z",
        },
      ],
      now: "2026-07-26T20:00:00.000Z",
      expiresAt: "2026-07-26T20:15:00.000Z",
      auditEvent: {
        action: "platform_media.upload_session.created",
        auditKey: "profile-revision-platform-upload-created",
        actorUserId,
        organizationId,
        targetType: "media_upload_session",
        targetId: uploadSessionId,
        requestId: "profile-revision-platform-upload-created",
        metadata: { purpose: "property.gallery_image" },
      },
    });
    const uploadedMediaObjectId = uploadSession.files[0]!.mediaId;
    await platformMediaRepository.completeUploadSession({
      session: uploadSession,
      files: [
        {
          sessionFile: uploadSession.files[0]!,
          uploadTarget: uploadSession.uploadTargets[0]!,
          inspection: {
            contentType: "image/webp",
            sizeBytes: 1800,
            checksumSha256: "a".repeat(64),
            widthPx: 1200,
            heightPx: 800,
          },
        },
      ],
      variantSets: [
        [
          {
            variantName: "original_safe",
            visibility: "public",
            storageKey: "properties/profile-revision-test/gallery.webp",
            contentType: "image/webp",
            widthPx: 1200,
            heightPx: 800,
            sizeBytes: 1800,
            checksumSha256: "b".repeat(64),
            publicCdnUrl: "https://cdn.example.test/properties/profile-revision-test/gallery.webp",
          },
        ],
      ],
      bucketName: "vayada-test-media",
      now: "2026-07-26T20:01:00.000Z",
      auditEvent: {
        action: "platform_media.upload_session.finalized",
        auditKey: "profile-revision-platform-upload-finalized",
        actorUserId,
        organizationId,
        targetType: "media_object",
        targetId: uploadedMediaObjectId,
        requestId: "profile-revision-platform-upload-finalized",
        metadata: { purpose: "property.gallery_image" },
      },
    });

    await expect(
      repository.getPublicPropertyProfile({
        organizationId,
        propertyId: created.propertyId,
      }),
    ).resolves.toMatchObject({
      profileRevision: 6,
      publicProfile: {
        media: [
          {
            mediaObjectId: uploadedMediaObjectId,
            mediaType: "gallery_image",
            url: "https://cdn.example.test/properties/profile-revision-test/gallery.webp",
          },
        ],
      },
    });
    await expect(readProfileCompleteness(created.propertyId)).resolves.toEqual({
      profileStatus: "complete",
      completenessReasons: [],
    });
    await expect(
      repository.updatePublicPropertyProfile({
        organizationId,
        propertyId: created.propertyId,
        expectedProfileRevision: 5,
        patch: { shortDescription: "Stale after media upload" },
      }),
    ).resolves.toEqual({ status: "conflict", currentRevision: 6 });

    await client.query(
      `INSERT INTO booking.booking_settings (property_id)
       VALUES ($1::uuid)
       ON CONFLICT (property_id) DO NOTHING`,
      [created.propertyId],
    );
    await expect(
      bookingSettingsRepository.updatePropertySettingsByHotelId?.(
        created.propertyId,
        { phoneNumber: "+49 30 1234567" },
        organizationId,
      ),
    ).rejects.toBeInstanceOf(BookingContactPublicationConflictError);
    await expect(
      client.query<{
        isPublic: boolean;
        sourceSystem: string;
      }>(
        `SELECT is_public AS "isPublic", source_system AS "sourceSystem"
         FROM hotel_catalog.property_contact_channels
         WHERE property_id = $1::uuid
           AND channel_type = 'phone'
           AND value = '+49 30 1234567'`,
        [created.propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [{ isPublic: false, sourceSystem: "platform" }],
    });

    const bookingUpdate = await bookingSettingsRepository.updatePropertySettingsByHotelId?.(
      created.propertyId,
      {
        propertyName: "Booking must not overwrite this",
        address: "Booking lane 99",
        city: "Vienna",
        country: "AT",
        phoneNumber: "+49 30 7654321",
        whatsappNumber: "+49 30 7654322",
        defaultCurrency: "EUR",
      },
      organizationId,
    );
    expect(bookingUpdate).toMatchObject({
      propertyName: "Profile Revision Test Hotel Updated",
      address: "Teststrasse 1, Berlin, 10115, DE",
      city: "Berlin",
      country: "DE",
      phoneNumber: "+49 30 7654321",
      whatsappNumber: "+49 30 7654322",
      defaultCurrency: "EUR",
    });
    await expect(
      client.query<{
        displayName: string;
        city: string;
        countryCode: string;
      }>(
        `SELECT property.display_name AS "displayName",
                location.city,
                location.country_code AS "countryCode"
         FROM hotel_catalog.properties property
         JOIN hotel_catalog.property_locations location
           ON location.property_id = property.id
         WHERE property.id = $1::uuid`,
        [created.propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          displayName: "Profile Revision Test Hotel Updated",
          city: "Berlin",
          countryCode: "DE",
        },
      ],
    });

    await client.query(
      `INSERT INTO hotel_catalog.property_contact_channels (
         property_id,
         channel_type,
         value,
         is_public,
         source_system
       )
       VALUES ($1::uuid, 'phone', '+49 99 9999999', TRUE, 'platform')`,
      [created.propertyId],
    );
    const settingsWithMultiplePublicPhones =
      await bookingSettingsRepository.findPropertySettingsByHotelId?.(created.propertyId);
    expect(settingsWithMultiplePublicPhones?.phoneNumber).toBe("+49 30 7654321");
    await bookingSettingsRepository.updatePropertySettingsByHotelId?.(
      created.propertyId,
      {
        checkInTime: "16:00",
        phoneNumber: settingsWithMultiplePublicPhones?.phoneNumber,
      },
      organizationId,
    );
    await expect(
      client.query<{ value: string; sourceSystem: string }>(
        `SELECT value, source_system AS "sourceSystem"
         FROM hotel_catalog.property_contact_channels
         WHERE property_id = $1::uuid
           AND channel_type = 'phone'
           AND is_public = TRUE`,
        [created.propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [{ value: "+49 30 7654321", sourceSystem: "booking" }],
    });
  });

  it("keeps public guest contacts canonical across setup and Booking settings", async () => {
    const created = await repository.createPropertyProfile({
      organizationId,
      idempotencyKey: "external-guest-contacts-create",
      correlationId: "external-guest-contacts-create",
      profile: { ...profile, displayName: "External Guest Contacts Hotel" },
    });
    await client.query(
      `INSERT INTO hotel_catalog.property_contact_channels (
         property_id,
         channel_type,
         value,
         purpose,
         is_public,
         source_system
       )
       VALUES
         ($1::uuid, 'phone', '+49 30 7000001', 'general', TRUE, 'booking'),
         ($1::uuid, 'whatsapp', '+49 30 7000002', 'general', TRUE, 'booking'),
         ($1::uuid, 'email', 'guest@example.test', 'general', TRUE, 'marketplace')`,
      [created.propertyId],
    );

    const loaded = await repository.getPropertyProfile({
      organizationId,
      propertyId: created.propertyId,
    });
    if (!loaded) throw new Error("Expected the shared profile to load");
    expect(loaded.profile.contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelType: "phone", value: "+49 30 7000001" }),
        expect.objectContaining({ channelType: "whatsapp", value: "+49 30 7000002" }),
        expect.objectContaining({ channelType: "email", value: "guest@example.test" }),
      ]),
    );

    const updated = await repository.updatePropertyProfile({
      organizationId,
      propertyId: created.propertyId,
      expectedProfileRevision: loaded.profileRevision,
      profile: {
        ...loaded.profile,
        contacts: [
          ...loaded.profile.contacts.filter((contact) => !contact.isPublic),
          {
            channelType: "phone",
            value: "+49 30 7000001",
            purpose: "general",
            isPublic: true,
          },
          {
            channelType: "email",
            value: "new-guest@example.test",
            purpose: "general",
            isPublic: true,
          },
        ],
      },
    });
    expect(updated).not.toBeNull();

    await expect(
      client.query<{
        channelType: string;
        value: string;
        sourceSystem: string;
      }>(
        `SELECT
           channel_type AS "channelType",
           value,
           source_system AS "sourceSystem"
         FROM hotel_catalog.property_contact_channels
         WHERE property_id = $1::uuid
           AND is_public = TRUE
           AND channel_type IN ('phone', 'whatsapp', 'email')
         ORDER BY channel_type, value`,
        [created.propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          channelType: "email",
          value: "new-guest@example.test",
          sourceSystem: "platform",
        },
        {
          channelType: "phone",
          value: "+49 30 7000001",
          sourceSystem: "platform",
        },
      ],
    });

    await bookingSettingsRepository.updatePropertySettingsByHotelId?.(
      created.propertyId,
      {
        reservationEmail: "booking-guest@example.test",
        phoneNumber: "+49 30 7000001",
        whatsappNumber: "+49 30 8000002",
      },
      organizationId,
    );
    await expect(
      client.query<{
        channelType: string;
        value: string;
        sourceSystem: string;
      }>(
        `SELECT
           channel_type AS "channelType",
           value,
           source_system AS "sourceSystem"
         FROM hotel_catalog.property_contact_channels
         WHERE property_id = $1::uuid
           AND is_public = TRUE
           AND channel_type IN ('phone', 'whatsapp', 'email')
         ORDER BY channel_type, value`,
        [created.propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          channelType: "email",
          value: "booking-guest@example.test",
          sourceSystem: "booking",
        },
        {
          channelType: "phone",
          value: "+49 30 7000001",
          sourceSystem: "booking",
        },
        {
          channelType: "whatsapp",
          value: "+49 30 8000002",
          sourceSystem: "booking",
        },
      ],
    });
  });

  it("does not combine room, rate, and inventory artifacts from different room types", async () => {
    const created = await repository.createPropertyProfile({
      organizationId,
      idempotencyKey: "fragmented-room-readiness-create",
      correlationId: "fragmented-room-readiness-create",
      profile: { ...profile, displayName: "Fragmented Room Readiness Hotel" },
    });

    await client.query(
      `INSERT INTO pms.room_types (id, property_id, name, currency, active)
       VALUES
         ($2::uuid, $1::uuid, 'Room only', 'EUR', TRUE),
         ($3::uuid, $1::uuid, 'Rate only', 'EUR', TRUE),
         ($4::uuid, $1::uuid, 'Inventory only', 'EUR', TRUE)`,
      [created.propertyId, roomTypeWithRoomId, roomTypeWithRateId, roomTypeWithInventoryId],
    );
    await client.query(
      `INSERT INTO pms.rooms (id, property_id, room_type_id, room_number, status)
       VALUES ($2::uuid, $1::uuid, $3::uuid, 'ROOM-ONLY-1', 'available')`,
      [created.propertyId, physicalRoomId, roomTypeWithRoomId],
    );
    await client.query(
      `INSERT INTO pms.rate_plans (
         id,
         property_id,
         room_type_id,
         code,
         name,
         base_rate_amount,
         currency,
         active
       )
       VALUES ($2::uuid, $1::uuid, $3::uuid, 'FRAGMENTED', 'Fragmented', 100, 'EUR', TRUE)`,
      [created.propertyId, fragmentedRatePlanId, roomTypeWithRateId],
    );
    await client.query(
      `INSERT INTO pms.inventory_days (
         property_id,
         room_type_id,
         stay_date,
         total_count,
         available_count,
         status
       )
       VALUES ($1::uuid, $2::uuid, CURRENT_DATE + 1, 1, 1, 'open')`,
      [created.propertyId, roomTypeWithInventoryId],
    );

    const fragmented = (
      await repository.getHotelSetupStatus({
        organizationId,
        propertyIds: [created.propertyId],
      })
    ).properties[0]!.taskFacts.rooms_rates_availability;
    expect(fragmented).toMatchObject({
      ownerProgress: "in_progress",
      readiness: "actionable",
      reasonCodes: ["missing_active_rate_plan", "missing_future_inventory"],
    });

    await client.query(
      `INSERT INTO pms.rate_plans (
         id,
         property_id,
         room_type_id,
         code,
         name,
         base_rate_amount,
         currency,
         active
       )
       VALUES ($2::uuid, $1::uuid, $3::uuid, 'COHERENT', 'Coherent', 100, 'EUR', TRUE)`,
      [created.propertyId, coherentRatePlanId, roomTypeWithRoomId],
    );
    await client.query(
      `INSERT INTO pms.inventory_days (
         property_id,
         room_type_id,
         stay_date,
         total_count,
         available_count,
         status
       )
       VALUES ($1::uuid, $2::uuid, CURRENT_DATE + 1, 1, 1, 'open')`,
      [created.propertyId, roomTypeWithRoomId],
    );

    const coherent = (
      await repository.getHotelSetupStatus({
        organizationId,
        propertyIds: [created.propertyId],
      })
    ).properties[0]!.taskFacts.rooms_rates_availability;
    expect(coherent).toMatchObject({
      ownerProgress: "owner_complete",
      readiness: "complete",
      reasonCodes: [],
    });
  });

  async function cleanup(): Promise<void> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `DELETE FROM hotel_catalog.property_source_links
         WHERE source_system = 'platform'
           AND source_table = 'platform_admin_provisioning'
           AND source_id = 'platform-admin-provisioning-integration'`,
      );
      await client.query("DELETE FROM platform.idempotency_keys WHERE organization_id = $1::uuid", [
        organizationId,
      ]);
      await client.query(
        "DELETE FROM platform.product_audit_events WHERE organization_id = $1::uuid",
        [organizationId],
      );
      const properties = await client.query<{ propertyId: string }>(
        `SELECT resource_id AS "propertyId"
         FROM identity.organization_resource_links
         WHERE organization_id = $1::uuid
           AND product = 'hotel_catalog'
           AND resource_type = 'property'`,
        [organizationId],
      );
      for (const { propertyId } of properties.rows) {
        await client.query(
          "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
          [propertyId],
        );
      }
      for (const { propertyId } of properties.rows) {
        await client.query(
          "DELETE FROM hotel_catalog.property_source_links WHERE property_id = $1::uuid",
          [propertyId],
        );
        await client.query("DELETE FROM pms.inventory_days WHERE property_id = $1::uuid", [
          propertyId,
        ]);
        await client.query("DELETE FROM pms.rate_plans WHERE property_id = $1::uuid", [propertyId]);
        await client.query("DELETE FROM pms.rooms WHERE property_id = $1::uuid", [propertyId]);
        await client.query("DELETE FROM pms.room_types WHERE property_id = $1::uuid", [propertyId]);
        await client.query(
          "DELETE FROM hotel_catalog.property_media WHERE property_id = $1::uuid",
          [propertyId],
        );
      }
      await client.query(
        "DELETE FROM platform.media_variants WHERE storage_key LIKE 'properties/profile-revision-test/%'",
      );
      await client.query(
        "DELETE FROM platform.media_upload_sessions WHERE owner_organization_id = $1::uuid",
        [organizationId],
      );
      await client.query(
        "DELETE FROM platform.media_objects WHERE owner_organization_id = $1::uuid",
        [organizationId],
      );
      await client.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        [organizationId],
      );
      for (const { propertyId } of properties.rows) {
        await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [
          propertyId,
        ]);
      }
      await client.query(
        "DELETE FROM hotel_catalog.organization_setup_track_intents WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await client.query(
        "DELETE FROM identity.organization_memberships WHERE id = ANY($1::uuid[])",
        [[membershipId, secondMembershipId]],
      );
      await client.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [
        organizationId,
      ]);
      await client.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [
        [actorUserId, secondActorUserId],
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  async function readProfileCompleteness(propertyId: string): Promise<{
    profileStatus: string;
    completenessReasons: string[];
  }> {
    const result = await client.query<{
      profileStatus: string;
      completenessReasons: string[];
    }>(
      `SELECT profile_status AS "profileStatus",
              completeness_reasons AS "completenessReasons"
       FROM hotel_catalog.properties
       WHERE id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0]!;
  }
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
