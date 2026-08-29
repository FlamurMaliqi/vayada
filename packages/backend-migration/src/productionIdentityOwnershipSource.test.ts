import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  mapOwnershipStatus,
  parseIdentityOwnershipRows,
} from "./productionIdentityOwnershipSource.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-01-01T00:00:00.000Z";

describe("production ownership source mapping", () => {
  it.each([
    ["booking.booking_hotels", "live", "active"],
    ["marketplace.hotel_profiles", "pending", "suspended"],
    ["pms.affiliates", "rejected", "archived"],
    ["booking.booking_hotels", "retired", null],
    ["marketplace.hotel_profiles", "approved", null],
  ] as const)("maps %s %s to %s", (source, status, expected) => {
    expect(mapOwnershipStatus(source, status)).toBe(expected);
  });

  it("maps changed product tables into one explicit ownership shape", () => {
    const rows = [
      row("booking", "booking_hotels", { platform_status: "live" }),
      row("pms", "hotels"),
      row("marketplace", "hotel_profiles", { status: "verified" }),
      row("marketplace", "creators"),
      row("pms", "affiliates", { status: "approved", full_name: "Affiliate Owner" }),
    ];

    const result = parseIdentityOwnershipRows(rows);

    expect(result.blockers).toEqual([]);
    expect(result.owners.find((owner) => owner.source === "pms.affiliates")?.name).toBe(
      "Affiliate Owner",
    );
    expect(
      result.owners.map(({ source, kind, product, resourceType, relationship }) => ({
        source,
        kind,
        product,
        resourceType,
        relationship,
      })),
    ).toEqual([
      {
        source: "booking.booking_hotels",
        kind: "hotel_group",
        product: "booking",
        resourceType: "booking_hotel",
        relationship: "owner",
      },
      {
        source: "marketplace.creators",
        kind: "creator_workspace",
        product: "marketplace",
        resourceType: "creator_profile",
        relationship: "owner",
      },
      {
        source: "marketplace.hotel_profiles",
        kind: "hotel_group",
        product: "marketplace",
        resourceType: "hotel_profile",
        relationship: "owner",
      },
      {
        source: "pms.affiliates",
        kind: "affiliate_partner",
        product: "affiliate",
        resourceType: "affiliate",
        relationship: "owner",
      },
      {
        source: "pms.hotels",
        kind: "hotel_group",
        product: "pms",
        resourceType: "pms_hotel",
        relationship: "operator",
      },
    ]);
  });

  it("skips unclaimed affiliates and blocks invalid required ownership", () => {
    const result = parseIdentityOwnershipRows([
      row("pms", "affiliates", { user_id: null, status: "pending" }),
      row("booking", "booking_hotels", { user_id: null, platform_status: "live" }),
      row("marketplace", "hotel_profiles", { status: "mystery" }),
    ]);

    expect(result.owners).toEqual([]);
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: "INVALID_SOURCE_ROW", source: "booking.booking_hotels" }),
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        source: "marketplace.hotel_profiles",
        message: "status mystery is unsupported",
      }),
    ]);
  });
});

function row(
  sourceDatabase: IdentitySourceRow["sourceDatabase"],
  sourceTable: string,
  overrides: Record<string, unknown> = {},
): IdentitySourceRow {
  return {
    sourceDatabase,
    sourceTable,
    rowOrdinal: 1,
    data: {
      id: RESOURCE_ID,
      user_id: USER_ID,
      name: "Legacy resource",
      created_at: CREATED,
      updated_at: CREATED,
      ...overrides,
    },
  };
}
