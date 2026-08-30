import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionCatalogPlan } from "./productionCatalogPlan.js";
import type { ProductionCatalogTargetState } from "./productionCatalogTargetReader.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPDATED = "2026-08-02T00:00:00Z";
const rows: IdentitySourceRow[] = [
  {
    sourceDatabase: "booking",
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
      created_at: "2026-08-01T00:00:00Z",
      updated_at: UPDATED,
    },
  },
];

describe("production catalog plan", () => {
  it("builds a deterministic write report from the snapshot and current target", () => {
    const first = buildProductionCatalogPlan(rows, emptyTarget());
    const second = buildProductionCatalogPlan(rows, emptyTarget());

    expect(first.blockers).toEqual([]);
    expect(first.counts).toMatchObject({ properties: 1, sourceLinks: 1, writes: 4 });
    expect(first.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual(first);
  });

  it("reports preserved newer target state separately from writes", () => {
    const target = emptyTarget();
    const desired = buildProductionCatalogPlan(rows, target).writes.properties[0]!;
    target.properties.push({
      ...desired,
      displayName: "Target",
      updatedAt: "2026-08-03T00:00:00Z",
    });

    const plan = buildProductionCatalogPlan(rows, target);

    expect(plan.blockers).toEqual([]);
    expect(plan.preservedTarget).toEqual([
      expect.objectContaining({ entity: "properties", reason: "target_newer" }),
    ]);
    expect(plan.writes.properties).toEqual([]);
  });

  it("blocks an empty production catalog", () => {
    expect(buildProductionCatalogPlan([], emptyTarget()).blockers.map((row) => row.code)).toContain(
      "EMPTY_PRODUCTION_CATALOG",
    );
  });
});

function emptyTarget(): ProductionCatalogTargetState {
  return {
    properties: [],
    sourceLinks: [],
    slugs: [],
    domains: [],
    locations: [],
    profiles: [],
    amenities: [],
    contacts: [],
    policies: [],
    media: [],
    mediaObjects: [],
    ownerRevisions: [],
  };
}
