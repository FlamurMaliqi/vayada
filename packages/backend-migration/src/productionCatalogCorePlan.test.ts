import { describe, expect, it } from "vitest";

import { planProductionCatalogCore } from "./productionCatalogCorePlan.js";
import { planCatalogOwnership } from "./productionCatalogOwnership.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const rows = [
  {
    sourceDatabase: "auth" as const,
    sourceTable: "users",
    rowOrdinal: 1,
    data: { id: USER, type: "hotel", status: "verified" },
  },
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
      star_rating: 4,
      country: "Austria",
      timezone: "UTC",
      supported_languages: ["en"],
      default_language: "en",
      previous_slugs: ["old-hotel"],
      custom_domain: "Stay.Hotel.Example",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    },
  },
  {
    sourceDatabase: "pms" as const,
    sourceTable: "hotels",
    rowOrdinal: 1,
    data: {
      id: PROPERTY,
      user_id: USER,
      name: "PMS Hotel",
      slug: "hotel",
      property_type: "hotel",
      country: "AT",
      city: "Vienna",
      timezone: "Europe/Vienna",
      latitude: 48.2,
      longitude: 16.3,
      created_at: "2026-08-01T00:00:00Z",
    },
  },
  {
    sourceDatabase: "booking" as const,
    sourceTable: "booking_hotel_translations",
    rowOrdinal: 1,
    data: { hotel_id: PROPERTY, locale: "de" },
  },
];

describe("planProductionCatalogCore", () => {
  it("promotes only structured canonical facts", () => {
    const plan = planProductionCatalogCore(rows, planCatalogOwnership(rows));

    expect(plan.blockers).toEqual([]);
    expect(plan.properties[0]).toMatchObject({
      profileStatus: "complete",
      supportedLocales: ["de", "en"],
    });
    expect(plan.locations[0]).toMatchObject({
      countryCode: "AT",
      city: "Vienna",
      timezone: "Europe/Vienna",
    });
    expect(plan.slugs.map((row) => [row.slug, row.status])).toEqual([
      ["hotel", "active"],
      ["old-hotel", "redirected"],
    ]);
  });

  it("never promotes free-form country or unverified location defaults", () => {
    const withoutPms = rows.filter((row) => row.sourceDatabase !== "pms");
    const plan = planProductionCatalogCore(withoutPms, planCatalogOwnership(withoutPms));

    expect(plan.locations[0]).toMatchObject({
      countryCode: null,
      city: null,
      sourceConfidence: "low",
    });
    expect(plan.locations[0]?.migrationNotes).toContain("Austria");
    expect(plan.properties[0]).toMatchObject({
      profileStatus: "incomplete",
      completenessReasons: ["location_unverified", "timezone_missing"],
    });
  });

  it("keeps a live property private when its legacy owner is absent", () => {
    const withoutOwner = rows.filter((row) => row.sourceDatabase !== "auth");
    const plan = planProductionCatalogCore(withoutOwner, planCatalogOwnership(withoutOwner));

    expect(plan.properties[0]).toMatchObject({
      profileStatus: "private",
      completenessReasons: expect.arrayContaining(["legacy_owner_quarantined"]),
    });
  });

  it("keeps a live property private while its legacy owner remains pending", () => {
    const pendingOwner = rows.map((row) =>
      row.sourceDatabase === "auth" ? { ...row, data: { ...row.data, status: "pending" } } : row,
    );
    const plan = planProductionCatalogCore(pendingOwner, planCatalogOwnership(pendingOwner));

    expect(plan.properties[0]).toMatchObject({
      profileStatus: "private",
      completenessReasons: expect.arrayContaining(["legacy_owner_not_verified"]),
    });
  });
});
