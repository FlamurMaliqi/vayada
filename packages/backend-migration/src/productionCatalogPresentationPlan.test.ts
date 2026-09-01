import { describe, expect, it } from "vitest";
import { sha256 } from "./productionBookingValues.js";
import { planProductionCatalogContent } from "./productionCatalogContentPlan.js";
import { planProductionCatalogCore } from "./productionCatalogCorePlan.js";
import { planCatalogOwnership } from "./productionCatalogOwnership.js";
import { planProductionCatalogPresentation } from "./productionCatalogPresentationPlan.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rows = [
  {
    sourceDatabase: "booking" as const,
    sourceTable: "booking_hotels",
    rowOrdinal: 1,
    data: {
      id: PROPERTY,
      user_id: USER,
      name: "Hotel",
      slug: "hotel",
      platform_status: "live",
      country: "AT",
      timezone: "Europe/Vienna",
      supported_languages: ["en"],
      default_language: "en",
      previous_slugs: [],
      amenities: [],
      images: [],
      hero_image: "https://legacy.invalid/hero.jpg",
      custom_domain: "stay.example.test",
      check_in_time: "15:00",
      check_out_time: "11:00",
      star_rating: 4,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    },
  },
];

function plans() {
  const ownership = planCatalogOwnership(rows);
  const core = planProductionCatalogCore(rows, ownership);
  return { ownership, content: planProductionCatalogContent(rows, ownership, core) };
}
describe("planProductionCatalogPresentation", () => {
  it("preserves verified target domains and assigns only ready Platform Media", () => {
    const { ownership, content } = plans();
    const plan = planProductionCatalogPresentation(rows, ownership, content, {
      domains: [
        {
          id: MEDIA,
          propertyId: PROPERTY,
          hostname: "stay.example.test",
          verificationStatus: "verified",
          canonicalWhenVerified: true,
          verifiedAt: "2026-08-03T00:00:00Z",
          updatedAt: "2026-08-03T00:00:00Z",
        },
      ],
      mediaObjects: [
        {
          id: MEDIA,
          propertyId: PROPERTY,
          purpose: "property.hero_image",
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceRowId: `${PROPERTY}:hero_image`,
          visibility: "public",
          lifecycleStatus: "active",
          publicApproved: true,
        },
      ],
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.domains[0]).toMatchObject({
      verificationStatus: "verified",
      canonicalWhenVerified: true,
    });
    expect(plan.media[0]).toMatchObject({ platformMediaObjectId: MEDIA, publicApproved: true });
    expect(JSON.stringify(plan.media)).not.toContain("legacy.invalid");
  });

  it("blocks raw media references until VAY-1055 supplies an object", () => {
    const { ownership, content } = plans();
    const plan = planProductionCatalogPresentation(rows, ownership, content);
    expect(plan.blockers.map((row) => row.code)).toContain("UNRESOLVED_MEDIA_REFERENCE");
  });

  it("omits a same-run quarantined media field without copying or blocking it", () => {
    const { ownership, content } = plans();
    const plan = planProductionCatalogPresentation(rows, ownership, content, {
      mediaObjects: [
        {
          id: MEDIA,
          propertyId: PROPERTY,
          purpose: "property.hero_image",
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceRowId: `${PROPERTY}:hero_image`,
          visibility: "public",
          lifecycleStatus: "active",
          publicApproved: true,
        },
      ],
      mediaQuarantines: [
        {
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceRowId: `${PROPERTY}:hero_image`,
          purpose: "property.hero_image",
          sourceField: "hero_image",
          sourceValueSha256: sha256({ value: rows[0]!.data.hero_image }),
          reasonCode: "INVALID_HTTPS_URL",
        },
      ],
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.media).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain("legacy.invalid");
  });

  it("accepts a redacted quarantine for a malformed Booking image array", () => {
    const malformed = structuredClone(rows);
    const data = malformed[0]!.data as Record<string, unknown>;
    data.hero_image = null;
    data.images = { stale: "https://legacy.invalid/gallery.jpg" };
    const ownership = planCatalogOwnership(malformed);
    const core = planProductionCatalogCore(malformed, ownership);
    const content = planProductionCatalogContent(malformed, ownership, core);
    const plan = planProductionCatalogPresentation(malformed, ownership, content, {
      mediaQuarantines: [
        {
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceRowId: `${PROPERTY}:images`,
          purpose: "property.gallery_image",
          sourceField: "images",
          sourceValueSha256: sha256({ value: data.images }),
          reasonCode: "INVALID_STRING_ARRAY",
        },
      ],
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.media).toEqual([]);
  });

  it("omits a quarantined Booking image array containing a non-string element", () => {
    const malformed = structuredClone(rows);
    const data = malformed[0]!.data as Record<string, unknown>;
    data.hero_image = null;
    data.images = ["https://legacy.invalid/gallery.jpg", 42];
    const ownership = planCatalogOwnership(malformed);
    const core = planProductionCatalogCore(malformed, ownership);
    const content = planProductionCatalogContent(malformed, ownership, core);
    const plan = planProductionCatalogPresentation(malformed, ownership, content, {
      mediaQuarantines: [
        {
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceRowId: `${PROPERTY}:images`,
          purpose: "property.gallery_image",
          sourceField: "images",
          sourceValueSha256: sha256({ value: data.images }),
          reasonCode: "INVALID_STRING_ARRAY",
        },
      ],
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.media).toEqual([]);
  });

  it("does not let stale quarantine evidence suppress a changed media value", () => {
    const { ownership, content } = plans();
    const plan = planProductionCatalogPresentation(rows, ownership, content, {
      mediaQuarantines: [
        {
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceRowId: `${PROPERTY}:hero_image`,
          purpose: "property.hero_image",
          sourceField: "hero_image",
          sourceValueSha256: sha256({ value: "https://legacy.invalid/old-hero.jpg" }),
          reasonCode: "INVALID_HTTPS_URL",
        },
      ],
    });

    expect(plan.blockers.map((row) => row.code)).toContain("UNRESOLVED_MEDIA_REFERENCE");
  });

  it("reports malformed presentation fields instead of crashing", () => {
    const malformed = structuredClone(rows);
    const data = malformed[0]!.data as Record<string, unknown>;
    data.images = "not-an-array";
    data.custom_domain = 42;
    const ownership = planCatalogOwnership(malformed);
    const core = planProductionCatalogCore(malformed, ownership);
    const content = planProductionCatalogContent(malformed, ownership, core);
    const plan = planProductionCatalogPresentation(malformed, ownership, content);
    expect(plan.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining(["INVALID_CUSTOM_DOMAIN", "INVALID_MEDIA_REFERENCE"]),
    );
  });
});
