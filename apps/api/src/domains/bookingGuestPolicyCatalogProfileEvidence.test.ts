import { describe, expect, it, vi } from "vitest";

import {
  createBookingGuestPolicyCatalogProfileEvidencePort,
  type BookingGuestPolicyCatalogProfileEvidencePool,
} from "./bookingGuestPolicyCatalogProfileEvidence.js";

const organizationId = "13000000-0000-4000-8000-000000000001";
const propertyId = "13000000-0000-4000-8000-000000000002";

describe("Booking guest-policy Catalog profile evidence", () => {
  it("returns exact scoped profile and canonical timezone evidence", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ propertyId, profileRevision: "7", timeZone: "Europe/Berlin" }],
      rowCount: 1,
    }));
    const port = createBookingGuestPolicyCatalogProfileEvidencePort({
      pool: { query } as unknown as BookingGuestPolicyCatalogProfileEvidencePool,
    });

    await expect(port.getCatalogProfileEvidence({ organizationId, propertyId })).resolves.toEqual({
      outcome: "available",
      evidence: {
        source: {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: propertyId,
          revision: "profile:7",
        },
        timeZone: "Europe/Berlin",
      },
    });
    expect(query.mock.calls[0]?.[1]).toEqual([organizationId, propertyId]);
    expect(query.mock.calls[0]?.[0]).toContain("AND EXISTS (");
    expect(query.mock.calls[0]?.[0]).toContain("resource.relationship IN ('owner', 'operator')");
  });

  it.each([
    [null, "timezone_missing"],
    ["Not/A_Zone", "timezone_invalid"],
  ] as const)("reports %s without inventing timezone evidence", async (timeZone, outcome) => {
    const port = createBookingGuestPolicyCatalogProfileEvidencePort({
      pool: pool([{ propertyId, profileRevision: 1, timeZone }]),
    });
    await expect(port.getCatalogProfileEvidence({ organizationId, propertyId })).resolves.toEqual(
      expect.objectContaining({ outcome }),
    );
  });

  it("fails malformed scopes before owner access and unavailable rows closed", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [],
      rowCount: 0,
    }));
    const port = createBookingGuestPolicyCatalogProfileEvidencePort({
      pool: { query } as unknown as BookingGuestPolicyCatalogProfileEvidencePool,
    });
    await expect(
      port.getCatalogProfileEvidence({ organizationId, propertyId: "not-a-property" }),
    ).resolves.toEqual({ outcome: "malformed" });
    expect(query).not.toHaveBeenCalled();
    await expect(port.getCatalogProfileEvidence({ organizationId, propertyId })).resolves.toEqual({
      outcome: "unavailable",
      errorSource: "provider",
    });
  });

  it.each([
    [[{ propertyId, profileRevision: "1.0", timeZone: "Europe/Berlin" }]],
    [
      [
        { propertyId, profileRevision: 1, timeZone: "Europe/Berlin" },
        { propertyId, profileRevision: 1, timeZone: "Europe/Berlin" },
      ],
    ],
  ])("rejects ambiguous or non-canonical owner evidence", async (rows) => {
    const port = createBookingGuestPolicyCatalogProfileEvidencePort({ pool: pool(rows) });
    await expect(port.getCatalogProfileEvidence({ organizationId, propertyId })).resolves.toEqual({
      outcome: "malformed",
    });
  });
});

function pool(rows: unknown[]) {
  return {
    async query() {
      return { rows, rowCount: rows.length };
    },
  } as unknown as BookingGuestPolicyCatalogProfileEvidencePool;
}
