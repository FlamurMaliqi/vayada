import { describe, expect, it } from "vitest";

import { readPlatformPropertyRetirementImpact } from "./platformPropertyLifecycleImpactRepository.js";

const propertyId = "11111111-1111-4111-8111-111111111111";

describe("platform property retirement impact", () => {
  it("returns every required dependency category and actionable blockers", async () => {
    const queries: string[] = [];
    const impact = await readPlatformPropertyRetirementImpact(
      {
        async query<T>(sql: string) {
          queries.push(sql);
          return {
            rows: [
              {
                propertyId,
                lifecycleStatus: "active",
                lifecycleRevision: "4",
                linkedOrganizations: "2",
                activeEntitlements: "3",
                suspendedEntitlements: "1",
                totalBookings: "8",
                activeBookings: "2",
                roomTypes: "4",
                rooms: "12",
                totalPayments: "5",
                unresolvedPayments: "1",
                totalPayouts: "3",
                openPayouts: "0",
                billingEntitlements: "2",
                mediaObjects: "6",
                marketplaceActive: true,
                distributionStatus: "public",
                bookingRevisionActive: true,
                connectedChannels: "1",
              } as T,
            ],
          };
        },
      },
      propertyId,
    );

    expect(impact).toMatchObject({
      contractVersion: "platform-property-lifecycle.v1",
      propertyId,
      lifecycleStatus: "active",
      lifecycleRevision: 4,
      organizations: { linked: 2 },
      entitlements: { active: 3, suspended: 1 },
      bookings: { total: 8, active: 2 },
      inventory: { roomTypes: 4, rooms: 12 },
      finance: {
        totalPayments: 5,
        unresolvedPayments: 1,
        totalPayouts: 3,
        openPayouts: 0,
        billingEntitlements: 2,
      },
      media: { objects: 6 },
      publicExposure: {
        marketplaceActive: true,
        distributionStatus: "public",
        bookingRevisionActive: true,
      },
      canRetire: false,
      hardDeletion: { allowed: false, reason: "hard_delete_not_supported" },
    });
    expect(impact?.blockers.map(({ code, count }) => [code, count])).toEqual([
      ["active_bookings", 2],
      ["unresolved_payments", 1],
      ["connected_channels", 1],
    ]);
    expect(queries[0]).toContain("booking.guest_bookings");
    expect(queries[0]).toContain("finance.payments");
    expect(queries[0]).toContain("finance.billing_entitlements");
    expect(queries[0]).toContain("'draft'");
    expect(queries[0]).toContain("pms.channel_connections");
    expect(queries[0]).not.toContain("PMS_DATABASE_URL");
  });

  it("locks the Catalog property when used by the retirement command", async () => {
    let sql = "";
    const impact = await readPlatformPropertyRetirementImpact(
      {
        async query(statement: string) {
          sql = statement;
          return { rows: [] };
        },
      },
      propertyId,
      true,
    );

    expect(impact).toBeNull();
    expect(sql).toContain("FOR UPDATE");
  });
});
