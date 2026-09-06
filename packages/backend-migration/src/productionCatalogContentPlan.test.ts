import { describe, expect, it } from "vitest";
import { planProductionCatalogContent } from "./productionCatalogContentPlan.js";
import { planProductionCatalogCore } from "./productionCatalogCorePlan.js";
import { planCatalogOwnership } from "./productionCatalogOwnership.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
      description: "Public description",
      country: "AT",
      timezone: "Europe/Vienna",
      supported_languages: ["en"],
      default_language: "en",
      previous_slugs: [],
      amenities: ["Free Wi-Fi"],
      contact_email: "private@example.test",
      custom_domain: "Stay.Example.Test",
      check_in_time: "15:00",
      check_out_time: "11:00",
      cancellation_policy_text: "Flexible",
      terms_text: "Card or cash",
      star_rating: 4,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    },
  },
];

describe("planProductionCatalogContent", () => {
  it("keeps legacy contacts private while planning public-safe content", () => {
    const ownership = planCatalogOwnership(rows);
    const plan = planProductionCatalogContent(
      rows,
      ownership,
      planProductionCatalogCore(rows, ownership),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.contacts[0]).toMatchObject({ channelType: "email", isPublic: false });
    expect(plan.profiles[0]).toMatchObject({
      longDescription: "Public description",
      sourceConfidence: "high",
    });
    expect(plan.amenities[0]).toMatchObject({ amenityKey: "free_wi_fi", sourceSystem: "booking" });
    expect(plan.policies[0]).toMatchObject({
      checkInTime: "15:00",
      cancellationSummary: "Flexible",
    });
  });

  it("preserves effective legacy windows instead of replacing them with single-time defaults", () => {
    const changed = structuredClone(rows);
    Object.assign(changed[0]!.data, {
      check_in_from: "12:00",
      check_in_until: "23:00",
      check_out_from: "07:00",
      check_out_until: "10:00",
    });
    const ownership = planCatalogOwnership(changed);
    const plan = planProductionCatalogContent(
      changed,
      ownership,
      planProductionCatalogCore(changed, ownership),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.policies[0]).toMatchObject({
      checkInTime: "12:00",
      checkInUntil: "23:00",
      checkOutFrom: "07:00",
      checkOutTime: "10:00",
    });
  });

  it.each([
    { check_in_from: "18:00", check_in_until: "12:00" },
    { check_in_time: "", check_in_until: "23:00" },
    { check_out_from: "12:00", check_out_until: "10:00" },
  ])("blocks invalid or incomplete legacy windows", (window) => {
    const changed = structuredClone(rows);
    Object.assign(changed[0]!.data, window);
    const ownership = planCatalogOwnership(changed);
    const plan = planProductionCatalogContent(
      changed,
      ownership,
      planProductionCatalogCore(changed, ownership),
    );
    expect(plan.blockers.some(({ code }) => code === "INVALID_CATALOG_POLICY_TIME")).toBe(true);
  });

  it("reports invalid policy times without leaking values", () => {
    const changed = structuredClone(rows);
    changed[0]!.data.check_in_time = "3pm";
    const ownership = planCatalogOwnership(changed);
    const plan = planProductionCatalogContent(
      changed,
      ownership,
      planProductionCatalogCore(changed, ownership),
    );
    expect(plan.blockers.map((row) => row.code)).toEqual(["INVALID_CATALOG_POLICY_TIME"]);
  });
});
