import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionCatalogPlan } from "./productionCatalogPlan.js";
import type { ProductionCatalogTargetState } from "./productionCatalogTargetReader.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPDATED = "2026-08-02T00:00:00Z";
const rows: IdentitySourceRow[] = [
  {
    sourceDatabase: "auth",
    sourceTable: "users",
    rowOrdinal: 1,
    data: { id: USER, type: "hotel", status: "verified" },
  },
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

  it("keeps a raw verified property private when target ownership is archived", () => {
    const target = emptyTarget();
    target.ownerLinks[0]!.status = "archived";

    const plan = buildProductionCatalogPlan(rows, target);

    expect(plan.blockers).toEqual([]);
    expect(plan.writes.properties[0]).toMatchObject({ profileStatus: "private" });
  });

  it("materializes a PMS-only source as a deterministic private catalog property", () => {
    const target = emptyTarget();
    const pmsHotel = "22222222-2222-4222-8222-222222222222";
    const pmsUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    target.ownerLinks.push({
      organizationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      product: "pms",
      resourceType: "pms_hotel",
      resourceId: pmsHotel,
      relationship: "operator",
      status: "active",
    });
    const sourceRows = [
      ...rows,
      {
        sourceDatabase: "pms" as const,
        sourceTable: "hotels",
        rowOrdinal: 1,
        data: {
          id: pmsHotel,
          user_id: pmsUser,
          name: "PMS-only hotel",
          slug: "pms-only-hotel",
          country: "AT",
          city: "Vienna",
          timezone: "Europe/Vienna",
          created_at: "2026-08-01T00:00:00Z",
          updated_at: UPDATED,
        },
      },
    ];

    const first = buildProductionCatalogPlan(sourceRows, target);
    const repeated = buildProductionCatalogPlan(sourceRows, target);
    const quarantined = first.quarantinedSources[0]!;

    expect(first.blockers).toEqual([]);
    expect(first.counts).toMatchObject({ properties: 2, sourceLinks: 2, quarantinedSourceRows: 1 });
    expect(first.writes.properties).toContainEqual(
      expect.objectContaining({ id: quarantined.propertyId, profileStatus: "private" }),
    );
    expect(first.sourceLinks).toContainEqual(
      expect.objectContaining({
        sourceSystem: "pms",
        sourceId: pmsHotel,
        propertyId: quarantined.propertyId,
        migrationDisposition: "private_quarantine",
        migrationDispositionReason: "missing_canonical_property",
      }),
    );
    expect(repeated.checksum).toBe(first.checksum);

    target.ownerLinks.find((link) => link.resourceId === pmsHotel)!.status = "archived";
    target.sourceLinks = first.sourceLinks.map((link) => ({
      ...link,
      migrationRunId: "vay1351-0123456789abcdef01234567",
      migrationPhase: "prerequisites",
    }));
    target.properties = first.writes.properties;
    target.slugs = first.writes.slugs;
    target.locations = first.writes.locations;
    target.profiles = first.writes.profiles;
    target.amenities = first.writes.amenities;
    target.contacts = first.writes.contacts;
    target.policies = first.writes.policies;
    const afterPrivateAuthorityRevocation = buildProductionCatalogPlan(sourceRows, target);
    expect(afterPrivateAuthorityRevocation.blockers).toEqual([]);
    expect(afterPrivateAuthorityRevocation.checksum).toBe(first.checksum);
    expect(afterPrivateAuthorityRevocation.quarantinedSources).toEqual(first.quarantinedSources);
    expect(afterPrivateAuthorityRevocation.counts.writes).toBe(0);
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
    ownerLinks: [
      {
        organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: PROPERTY,
        relationship: "owner",
        status: "active",
      },
    ],
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
