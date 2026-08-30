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

describe("planCatalogOwnership", () => {
  it("uses exact IDs and owner IDs without name guessing", () => {
    const plan = planCatalogOwnership([
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

  it("fails closed when one owner resolves to multiple Booking properties", () => {
    const plan = planCatalogOwnership([
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

    expect(plan.blockers.map((blocker) => blocker.code)).toContain(
      "AMBIGUOUS_CANONICAL_PROPERTY",
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

  it("reports malformed or ownership-free source rows", () => {
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

    expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
      "INVALID_CATALOG_SOURCE_ROW",
      "MISSING_CANONICAL_PROPERTY",
    ]);
  });
});
