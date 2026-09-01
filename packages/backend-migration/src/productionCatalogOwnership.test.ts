import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { planCatalogOwnership } from "./productionCatalogOwnership.js";

const ID = {
  booking: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

function row(
  sourceDatabase: IdentitySourceRow["sourceDatabase"],
  sourceTable: string,
  data: Record<string, unknown>,
): IdentitySourceRow {
  return { sourceDatabase, sourceTable, rowOrdinal: 1, data };
}

const booking = (overrides: Record<string, unknown> = {}) =>
  row("booking", "booking_hotels", {
    id: ID.booking,
    user_id: ID.user,
    name: "Canonical Hotel",
    slug: "canonical-hotel",
    platform_status: "live",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    ...overrides,
  });
const auth = (overrides: Record<string, unknown> = {}) =>
  row("auth", "users", {
    id: ID.user,
    type: "hotel",
    status: "verified",
    ...overrides,
  });

describe("planCatalogOwnership", () => {
  it("uses exact IDs and owner IDs without name guessing", () => {
    const plan = planCatalogOwnership([
      auth(),
      booking(),
      row("pms", "hotels", {
        id: ID.other,
        user_id: ID.user,
        name: "A different display name",
        slug: "also-different",
        created_at: "2026-08-01T00:00:00Z",
      }),
      row("marketplace", "hotel_profiles", {
        id: "33333333-3333-4333-8333-333333333333",
        user_id: ID.user,
        name: "Unrelated profile name",
        status: "verified",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-03T00:00:00Z",
      }),
    ]);

    expect(plan.blockers).toEqual([]);
    expect(plan.properties).toHaveLength(1);
    expect(plan.sourceLinks.map((link) => link.propertyId)).toEqual([
      ID.booking,
      ID.booking,
      ID.booking,
    ]);
  });

  it("materializes an ambiguous owner mapping as a deterministic private property", () => {
    const plan = planCatalogOwnership([
      auth(),
      booking(),
      booking({ id: ID.other, slug: "other-hotel" }),
      row("marketplace", "hotel_profiles", {
        id: "33333333-3333-4333-8333-333333333333",
        user_id: ID.user,
        name: "Profile",
        status: "verified",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      }),
    ]);

    expect(plan.blockers).toEqual([]);
    expect(plan.properties).toHaveLength(3);
    expect(plan.quarantinedSources).toEqual([
      expect.objectContaining({
        sourceSystem: "marketplace",
        sourceId: "33333333-3333-4333-8333-333333333333",
        reason: "ambiguous_canonical_property",
      }),
    ]);
    const quarantined = plan.quarantinedSources[0]!;
    expect(plan.sourceLinks).toContainEqual(
      expect.objectContaining({
        propertyId: quarantined.propertyId,
        migrationDisposition: "private_quarantine",
      }),
    );
  });

  it("blocks stale target source-link reassignment and duplicate slugs", () => {
    const plan = planCatalogOwnership(
      [booking(), booking({ id: ID.other, user_id: ID.other })],
      [
        {
          propertyId: ID.other,
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceId: ID.booking,
        },
      ],
    );

    expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
      "CATALOG_SOURCE_LINK_CONFLICT",
      "DUPLICATE_CANONICAL_SLUG",
    ]);
  });

  it("reports malformed canonical rows and quarantines ownerless non-canonical rows", () => {
    const plan = planCatalogOwnership([
      booking({ user_id: null }),
      row("pms", "hotels", {
        id: ID.other,
        user_id: ID.other,
        name: "Orphan PMS Hotel",
        slug: "orphan",
        created_at: "2026-08-01T00:00:00Z",
      }),
    ]);

    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(["INVALID_CATALOG_SOURCE_ROW"]);
    expect(plan.quarantinedSources).toEqual([
      expect.objectContaining({
        sourceSystem: "pms",
        sourceId: ID.other,
        reason: "legacy_owner_quarantined",
      }),
    ]);
  });

  it("prefers a same-owner exact PMS ID over ambiguous owner-level matches", () => {
    const plan = planCatalogOwnership([
      auth({ status: "pending" }),
      booking(),
      booking({ id: ID.other, slug: "other-hotel" }),
      row("pms", "hotels", {
        id: ID.other,
        user_id: ID.user,
        name: "Exact PMS Hotel",
        slug: "other-hotel",
        created_at: "2026-08-01T00:00:00Z",
      }),
    ]);

    expect(plan.blockers).toEqual([]);
    expect(plan.sourceLinks.find((link) => link.sourceSystem === "pms")?.propertyId).toBe(ID.other);
  });

  it("retains an unmatched non-verified owner's row as private quarantine", () => {
    const plan = planCatalogOwnership([
      auth({ status: "pending" }),
      row("marketplace", "hotel_profiles", {
        id: ID.other,
        user_id: ID.user,
        name: "Pending profile",
        status: "pending",
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      }),
    ]);

    expect(plan.blockers).toEqual([]);
    expect(plan.quarantinedSources).toEqual([
      expect.objectContaining({
        sourceId: ID.other,
        reason: "missing_canonical_property",
      }),
    ]);
    expect(plan.properties[0]).toMatchObject({
      propertyId: plan.quarantinedSources[0]!.propertyId,
      booking: null,
      migrationDisposition: "private_quarantine",
    });
  });

  it("keeps one exact PMS match and quarantines a second owner-level duplicate", () => {
    const duplicate = "33333333-3333-4333-8333-333333333333";
    const plan = planCatalogOwnership([
      auth(),
      booking(),
      row("pms", "hotels", {
        id: ID.booking,
        user_id: ID.user,
        name: "Exact PMS Hotel",
        slug: "exact",
        created_at: "2026-08-01T00:00:00Z",
      }),
      row("pms", "hotels", {
        id: duplicate,
        user_id: ID.user,
        name: "Second PMS Hotel",
        slug: "second",
        created_at: "2026-08-01T00:00:00Z",
      }),
    ]);

    expect(plan.blockers).toEqual([]);
    expect(
      plan.properties.find((property) => property.propertyId === ID.booking)?.pms,
    ).toHaveLength(1);
    expect(plan.quarantinedSources).toEqual([
      expect.objectContaining({ sourceId: duplicate, reason: "duplicate_pms_property" }),
    ]);
  });

  it("reproduces private property IDs and dispositions across reruns", () => {
    const source = row("pms", "hotels", {
      id: ID.other,
      user_id: ID.other,
      name: "Orphan PMS Hotel",
      slug: "orphan",
      created_at: "2026-08-01T00:00:00Z",
    });
    const first = planCatalogOwnership([source]);
    const repeated = planCatalogOwnership([source], first.sourceLinks);

    expect(repeated).toEqual(first);
  });

  it("blocks an existing source link with the wrong relationship", () => {
    const plan = planCatalogOwnership(
      [booking()],
      [
        {
          propertyId: ID.booking,
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceId: ID.booking,
          relationship: "profile_input",
        },
      ],
    );
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
      "CATALOG_SOURCE_RELATIONSHIP_CONFLICT",
    ]);
  });

  it("blocks an inactive existing source link", () => {
    const plan = planCatalogOwnership(
      [booking()],
      [
        {
          propertyId: ID.booking,
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceId: ID.booking,
          relationship: "canonical_input",
          status: "superseded",
        },
      ],
    );
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual(["CATALOG_SOURCE_LINK_INACTIVE"]);
  });

  it("blocks a target source link whose reviewed disposition changes", () => {
    const plan = planCatalogOwnership(
      [booking()],
      [
        {
          propertyId: ID.booking,
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceId: ID.booking,
          relationship: "canonical_input",
          migrationDisposition: "private_quarantine",
        },
      ],
    );
    expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
      "CATALOG_SOURCE_DISPOSITION_CONFLICT",
    ]);
  });
});
