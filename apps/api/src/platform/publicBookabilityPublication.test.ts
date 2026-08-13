import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTargetPublicBookabilityPublicationCommandPort,
  PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE,
  PROJECT_PUBLIC_BOOKABILITY_PROFILE,
  slugify,
  type TargetPublicBookabilityPublicationOptions,
} from "./publicBookabilityPublication.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const publicLocationPropertyId = "77777777-7777-4777-8777-777777777970";

describe("target public bookability publication", () => {
  it("publishes with the canonical slug and only consumes the Distribution PMS projection", async () => {
    const queries: string[] = [];
    const catalogProjectionPropertyIds: string[] = [];
    const client = {
      async query(text: string) {
        queries.push(text);
        if (text.includes('property.display_name AS "displayName"')) {
          return {
            rows: [
              {
                propertyId: "0fb98a96-9dbd-4917-8e61-40ec59348a99",
                publicId: "prop_0fb98a969dbd49178e6140ec59348a99",
                displayName: "Hôtel Alpenrose",
                defaultLocale: "de",
                canonicalSlug: "hotel-alpenrose",
              },
            ],
          };
        }
        if (text.includes("INSERT INTO distribution.public_hotel_bookability_profiles")) {
          return {
            rows: [
              {
                propertyId: "0fb98a96-9dbd-4917-8e61-40ec59348a99",
                canonicalSlug: "hotel-alpenrose",
                canonicalUrl: "https://hotel-alpenrose.booking.localhost:1355/de",
                bookingBaseUrl: "https://hotel-alpenrose.booking.localhost:1355",
                profileStatus: "public",
                freshnessStatus: "unavailable",
                missingReadiness: ["availability_source"],
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const end = vi.fn(async () => undefined);
    const pool = {
      connect: vi.fn(async () => client),
      end,
    } as unknown as NonNullable<TargetPublicBookabilityPublicationOptions["pool"]>;
    const publisher = createTargetPublicBookabilityPublicationCommandPort({
      connectionString: "postgresql://unused",
      bookingHostBase: "booking.localhost:1355",
      pool,
      catalogProfileProjector: {
        async project({ propertyId }) {
          catalogProjectionPropertyIds.push(propertyId);
        },
      },
    });

    await expect(
      publisher.publish({ propertyId: "0fb98a96-9dbd-4917-8e61-40ec59348a99" }),
    ).resolves.toMatchObject({
      canonicalSlug: "hotel-alpenrose",
      canonicalUrl: "https://hotel-alpenrose.booking.localhost:1355/de",
      profileStatus: "public",
      freshnessStatus: "unavailable",
    });

    expect(queries.at(0)).toBe("BEGIN");
    expect(queries.at(-1)).toBe("COMMIT");
    expect(catalogProjectionPropertyIds).toEqual(["0fb98a96-9dbd-4917-8e61-40ec59348a99"]);
    expect(queries.every((query) => !query.includes("INSERT INTO hotel_catalog"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "FROM distribution.public_room_offer_snapshots offer",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).not.toMatch(/\b(?:FROM|JOIN)\s+pms\./);
    await publisher.close?.();
    expect(end).not.toHaveBeenCalled();
  });

  it("keeps readiness and public-safe producer boundaries explicit in the projection SQL", () => {
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("offer.sellable_publicly = TRUE");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "offer.availability_status IN ('available', 'limited')",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("offer.available_rooms > 0");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("timezone_name.name = location.timezone");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("now() AT TIME ZONE CASE");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).not.toContain("profile.timezone");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("AS has_coverage");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("AS has_sellable_offers");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "settings.default_currency AS booking_default_currency",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "finance.refund_policy AS finance_refund_policy",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "'freeCancellationDays', input.finance_refund_policy -> 'freeCancellationDays'",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "'freeUntilDays', input.finance_refund_policy -> 'freeUntilDays'",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "'refundWindowDays', input.finance_refund_policy -> 'refundWindowDays'",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).not.toContain("'USD'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "payment_provider_onboarding_status = 'completed'",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("payment_provider_charges_enabled = TRUE");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "NOT IN ('BHD', 'JOD', 'KWD', 'OMR', 'TND')",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "'card' = ANY(COALESCE(input.accepted_methods, ARRAY[]::text[]))",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("'bank_transfer'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("'paypal'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("AS public_payment_methods");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("AS billing_config_ready");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "source_rule_id = 'onboarding-booking:' || profile.property_id::text",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "commission.commission_type = 'percentage'",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("commission.percentage_rate = 5");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("'billing_plan'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "offer.currency = NULLIF(upper(trim(settings.default_currency)), '')",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "finance.deposit_policy AS finance_deposit_policy",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "UPDATE distribution.public_room_offer_snapshots offer",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("SET payment_options = CASE");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("AS pay_at_property_ready");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("finance.payment_provider_accounts");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("pg_timezone_names");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("ELSE 'Etc/UTC'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("'sellable_availability'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("'payment_method'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("AS booking_profile_ready");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "'description' = ANY(input.completeness_reasons)",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("NULLIF(BTRIM(input.hero_subtext), '')");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "NULLIF(BTRIM(media.item ->> 'type'), '')",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "NULLIF(BTRIM(media.item ->> 'mediaType'), '')",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "ELSE 'https://' || input.verified_hostname || '/' || input.locale",
    );

    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain("candidate.public_approved = TRUE");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("DISTINCT ON");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain("candidate.media_type");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain("'pms.room_type.media'");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "candidate.source_system = 'platform'",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "JOIN platform.media_objects media_object",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "JOIN platform.media_variants media_variant",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "media_object.lifecycle_status = 'active'",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "media_variant.variant_name = 'original_safe'",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "'platformMediaObjectId', media.platform_media_object_id::text",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain("amenity.public_safe = TRUE");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain("contact.is_public = TRUE");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("booking.booking_settings");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("hero_image_url");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("hero_subtext");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("'timezone', input.timezone");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "WHEN COALESCE(input.locality_public, FALSE) THEN input.country_code",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "WHEN COALESCE(input.locality_public, FALSE) THEN input.city",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("'streetAddress'");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("'postalCode'");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("'rawMarketplaceLocation'");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "WHEN COALESCE(input.geo_public, FALSE)",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "input.map_display_mode IN ('approximate', 'exact')",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "WHEN COALESCE(input.catalog_locality_public, FALSE)",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "WHEN COALESCE(input.catalog_geo_public, FALSE)",
    );
  });

  it("creates DNS-safe slugs", () => {
    expect(slugify(" Hôtel zur schönen Aussicht! ")).toBe("hotel-zur-schonen-aussicht");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("canonical public location projection", () => {
  const client = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await cleanupPublicLocationFixture(client);
    await client.query(
      `INSERT INTO hotel_catalog.properties (
         id,
         public_id,
         display_name,
         property_type,
         default_locale,
         supported_locales,
         profile_status
       )
       VALUES (
         $1::uuid,
         'prop_public_location_privacy_970',
         'Public Location Privacy Hotel',
         'hotel',
         'en',
         ARRAY['en']::text[],
         'complete'
       )`,
      [publicLocationPropertyId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_slugs (
         property_id,
         slug,
         purpose,
         status
       )
       VALUES ($1::uuid, 'public-location-privacy-hotel-970', 'canonical', 'active')`,
      [publicLocationPropertyId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_locations (
         property_id,
         country_code,
         region,
         city,
         street_address,
         postal_code,
         raw_marketplace_location,
         latitude,
         longitude,
         timezone,
         address_public,
         geo_public,
         map_display_mode,
         source_confidence
       )
       VALUES (
         $1::uuid,
         'DE',
         'Berlin',
         'Berlin',
         'Private Strasse 1',
         '10115',
         'Private Strasse 1, Berlin',
         52.520008,
         13.404954,
         'Europe/Berlin',
         FALSE,
         FALSE,
         'hidden',
         'verified'
       )`,
      [publicLocationPropertyId],
    );
  });

  afterAll(async () => {
    await cleanupPublicLocationFixture(client);
    await client.end();
  });

  it("keeps canonical address, geo, and timezone private until explicitly published", async () => {
    await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [publicLocationPropertyId]);

    await expect(readProjectedLocation(client)).resolves.toEqual({});
    await projectPublicBookabilityLocation(client);
    await expect(readBookabilityLocation(client)).resolves.toEqual({});

    await client.query(
      `UPDATE hotel_catalog.property_locations
       SET address_public = TRUE
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );
    await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [publicLocationPropertyId]);

    await expect(readProjectedLocation(client)).resolves.toEqual({
      countryCode: "DE",
      region: "Berlin",
      city: "Berlin",
    });
    await projectPublicBookabilityLocation(client);
    await expect(readBookabilityLocation(client)).resolves.toEqual({
      country: "DE",
      region: "Berlin",
      city: "Berlin",
    });

    await client.query(
      `UPDATE hotel_catalog.property_locations
       SET geo_public = TRUE,
           map_display_mode = 'exact'
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );
    await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [publicLocationPropertyId]);

    await expect(readProjectedLocation(client)).resolves.toEqual({
      countryCode: "DE",
      region: "Berlin",
      city: "Berlin",
      geo: {
        latitude: 52.520008,
        longitude: 13.404954,
      },
      mapDisplayMode: "exact",
    });
    await projectPublicBookabilityLocation(client);
    await expect(readBookabilityLocation(client)).resolves.toEqual({
      country: "DE",
      region: "Berlin",
      city: "Berlin",
      latitude: 52.520008,
      longitude: 13.404954,
    });

    await client.query(
      `UPDATE hotel_catalog.property_locations
       SET map_display_mode = 'approximate'
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );
    await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [publicLocationPropertyId]);

    await expect(readProjectedLocation(client)).resolves.toMatchObject({
      geo: { latitude: 52.52, longitude: 13.4 },
      mapDisplayMode: "approximate",
    });
    await projectPublicBookabilityLocation(client);
    await expect(readBookabilityLocation(client)).resolves.toMatchObject({
      latitude: 52.52,
      longitude: 13.4,
    });

    await client.query(
      `UPDATE hotel_catalog.property_locations
       SET address_public = FALSE
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );
    await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [publicLocationPropertyId]);

    await expect(readProjectedLocation(client)).resolves.toEqual({
      geo: { latitude: 52.52, longitude: 13.4 },
      mapDisplayMode: "approximate",
    });
    await projectPublicBookabilityLocation(client);
    await expect(readBookabilityLocation(client)).resolves.toEqual({
      latitude: 52.52,
      longitude: 13.4,
    });
  });

  it("persists photos without leaking a canonical logo into the Booking hero fallback", async () => {
    await client.query(
      `UPDATE hotel_catalog.property_public_profile_read_model
       SET media = $2::jsonb
       WHERE property_id = $1::uuid`,
      [
        publicLocationPropertyId,
        JSON.stringify([
          {
            type: "",
            mediaType: " logo ",
            url: "https://cdn.vayada.test/property/logo.webp",
            altText: "Property logo",
          },
          {
            type: "hero_image",
            url: "https://cdn.vayada.test/property/hero.webp",
            altText: "Mountain view",
          },
        ]),
      ],
    );

    await projectPublicBookabilityLocation(client);

    const result = await client.query<{ media: Array<Record<string, unknown>> }>(
      `SELECT media
       FROM distribution.public_hotel_bookability_profiles
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );
    expect(result.rows[0]?.media).toEqual([
      {
        url: "https://cdn.vayada.test/property/hero.webp",
        alt: "Mountain view",
      },
    ]);
  });

  it("publishes an operations-only profile when hero subtext replaces the retired description", async () => {
    await client.query(
      `INSERT INTO booking.booking_settings (property_id, hero_subtext)
       VALUES ($1::uuid, 'Book direct for a memorable stay.')
       ON CONFLICT (property_id) DO UPDATE
       SET hero_subtext = EXCLUDED.hero_subtext`,
      [publicLocationPropertyId],
    );
    await client.query(
      `UPDATE hotel_catalog.property_public_profile_read_model
       SET profile_status = 'incomplete',
           completeness_reasons = ARRAY['description']::text[],
           descriptions = '{}'::jsonb
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );

    await projectPublicBookabilityLocation(client);

    const result = await client.query<{
      profileStatus: string;
      publicIdentity: Record<string, unknown>;
      missing: string[];
    }>(
      `SELECT
         profile_status AS "profileStatus",
         public_identity AS "publicIdentity",
         ARRAY(
           SELECT jsonb_array_elements_text(public_setup_completeness -> 'missing')
         ) AS missing
       FROM distribution.public_hotel_bookability_profiles
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );
    expect(result.rows[0]).toMatchObject({
      profileStatus: "public",
      publicIdentity: { summary: "Book direct for a memorable stay." },
    });
    expect(result.rows[0]?.missing).not.toContain("profile");

    await client.query(
      `UPDATE hotel_catalog.property_public_profile_read_model
       SET completeness_reasons = ARRAY['description', 'media']::text[]
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );
    await projectPublicBookabilityLocation(client);
    const incomplete = await client.query<{ profileStatus: string; missing: string[] }>(
      `SELECT
         profile_status AS "profileStatus",
         ARRAY(
           SELECT jsonb_array_elements_text(public_setup_completeness -> 'missing')
         ) AS missing
       FROM distribution.public_hotel_bookability_profiles
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );
    expect(incomplete.rows[0]?.profileStatus).toBe("incomplete");
    expect(incomplete.rows[0]?.missing).toContain("profile");
  });

  it("keeps payment-ready settings non-bookable until a billing plan is selected", async () => {
    await client.query(
      `INSERT INTO booking.booking_settings (property_id, default_currency)
       VALUES ($1::uuid, 'EUR')
       ON CONFLICT (property_id) DO UPDATE
       SET default_currency = EXCLUDED.default_currency`,
      [publicLocationPropertyId],
    );
    await client.query(
      `INSERT INTO finance.payment_settings (
         property_id, payments_enabled, accepted_methods, default_currency,
         supported_currencies, deposit_policy, requires_manual_review
       )
       VALUES ($1::uuid, TRUE, ARRAY['pay_at_property', 'cash']::text[], 'EUR',
         ARRAY['EUR']::text[], '{}'::jsonb, FALSE)
       ON CONFLICT (property_id) DO UPDATE
       SET payments_enabled = EXCLUDED.payments_enabled,
           accepted_methods = EXCLUDED.accepted_methods,
           default_currency = EXCLUDED.default_currency,
           supported_currencies = EXCLUDED.supported_currencies`,
      [publicLocationPropertyId],
    );

    await projectPublicBookabilityLocation(client);

    const result = await client.query<{ missing: string[] }>(
      `SELECT ARRAY(
         SELECT jsonb_array_elements_text(public_setup_completeness -> 'missing')
       ) AS missing
       FROM distribution.public_hotel_bookability_profiles
       WHERE property_id = $1::uuid`,
      [publicLocationPropertyId],
    );
    expect(result.rows[0]?.missing).toContain("billing_plan");
  });
});

async function readProjectedLocation(client: pg.Client): Promise<Record<string, unknown>> {
  const result = await client.query<{ location: Record<string, unknown> }>(
    `SELECT location
     FROM hotel_catalog.property_public_profile_read_model
     WHERE property_id = $1::uuid`,
    [publicLocationPropertyId],
  );
  return result.rows[0]?.location ?? {};
}

async function projectPublicBookabilityLocation(client: pg.Client): Promise<void> {
  await client.query(PROJECT_PUBLIC_BOOKABILITY_PROFILE, [
    publicLocationPropertyId,
    "https://public-location-privacy-hotel-970.booking.example/en",
    "https://public-location-privacy-hotel-970.booking.example",
  ]);
}

async function readBookabilityLocation(client: pg.Client): Promise<Record<string, unknown>> {
  const result = await client.query<{ location: Record<string, unknown> }>(
    `SELECT location
     FROM distribution.public_hotel_bookability_profiles
     WHERE property_id = $1::uuid`,
    [publicLocationPropertyId],
  );
  return result.rows[0]?.location ?? {};
}

async function cleanupPublicLocationFixture(client: pg.Client): Promise<void> {
  await client.query(`DELETE FROM hotel_catalog.properties WHERE id = $1::uuid`, [
    publicLocationPropertyId,
  ]);
}

function assertSafeTestDatabase(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!databaseName.toLowerCase().includes("test")) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
