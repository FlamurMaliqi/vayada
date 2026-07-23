import { describe, expect, it, vi } from "vitest";

import {
  createTargetPublicBookabilityPublicationCommandPort,
  PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE,
  PROJECT_PUBLIC_BOOKABILITY_PROFILE,
  slugify,
  type TargetPublicBookabilityPublicationOptions,
} from "./publicBookabilityPublication.js";

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
      "finance.default_currency AS finance_default_currency",
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
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("FALSE AS online_payment_ready");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "ARRAY['pay_at_property', 'cash']::text[]",
    );
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("AS pay_at_property_ready");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).not.toContain("finance.payment_provider_accounts");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("pg_timezone_names");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("ELSE 'Etc/UTC'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("'sellable_availability'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain("'payment_method'");
    expect(PROJECT_PUBLIC_BOOKABILITY_PROFILE).toContain(
      "ELSE 'https://' || input.verified_hostname || '/' || input.locale",
    );

    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain("candidate.public_approved = TRUE");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "DISTINCT ON (candidate.property_id, candidate.url)",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain(
      "CASE candidate.source_system WHEN 'platform' THEN 0 ELSE 1 END",
    );
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain("amenity.public_safe = TRUE");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).toContain("contact.is_public = TRUE");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("booking.booking_settings");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("hero_image_url");
    expect(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE).not.toContain("hero_subtext");
  });

  it("creates DNS-safe slugs", () => {
    expect(slugify(" Hôtel zur schönen Aussicht! ")).toBe("hotel-zur-schonen-aussicht");
  });
});
