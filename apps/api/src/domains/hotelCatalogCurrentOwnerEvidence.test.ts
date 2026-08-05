import { describe, expect, it, vi } from "vitest";

import {
  createPgHotelCatalogCurrentOwnerEvidencePorts,
  type HotelCatalogCurrentOwnerEvidencePool,
} from "./hotelCatalogCurrentOwnerEvidence.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const propertyId = "30000000-0000-4000-8000-000000000001";
const scope = { organizationId, propertyId };

describe("PostgreSQL Hotel Catalog current-owner evidence", () => {
  it("reads independently scoped location and policy source identities", async () => {
    const query = vi.fn(
      async ({ text }: { text: string; values: unknown[]; query_timeout: number }) =>
        result({
          propertyId,
          ownerPropertyId: propertyId,
          revision: text.includes("'hotel_catalog.location'") ? "7" : "9",
        }),
    );
    const ports = createPgHotelCatalogCurrentOwnerEvidencePorts({ pool: pool(query) });

    await expect(ports.location.getCurrentLocationOwnerEvidence(scope)).resolves.toEqual({
      outcome: "available",
      evidence: {
        ...scope,
        ownerKey: "hotel_catalog.location",
        sourceIdentity: `hotel_catalog.location:${propertyId}`,
        revision: 7,
        baseRevision: `hotel_catalog.location:${propertyId}:r7`,
      },
    });
    await expect(ports.policy.getCurrentPolicyOwnerEvidence(scope)).resolves.toEqual({
      outcome: "available",
      evidence: {
        ...scope,
        ownerKey: "hotel_catalog.policy",
        sourceIdentity: `hotel_catalog.policy:${propertyId}`,
        revision: 9,
        baseRevision: `hotel_catalog.policy:${propertyId}:r9`,
      },
    });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [request] of query.mock.calls) {
      expect(request.text).toContain("organization.kind = 'hotel_group'");
      expect(request.text).toContain("resource.product = 'hotel_catalog'");
      expect(request.text).toContain("resource.relationship IN ('owner', 'operator')");
      expect(request.values).toEqual([organizationId, propertyId]);
      expect(request.query_timeout).toBe(5_000);
    }
  });

  it.each([
    [[], { outcome: "missing", reason: "property_scope" }],
    [
      [{ propertyId, ownerPropertyId: null, revision: "3" }],
      { outcome: "missing", reason: "owner_state" },
    ],
    [[{ propertyId, ownerPropertyId: propertyId, revision: "0" }], { outcome: "malformed" }],
    [
      [{ propertyId, ownerPropertyId: "30000000-0000-4000-8000-000000000002", revision: "1" }],
      { outcome: "malformed" },
    ],
  ])("returns a typed fail-closed outcome for row state %#", async (rows, expected) => {
    const ports = createPgHotelCatalogCurrentOwnerEvidencePorts({
      pool: pool(vi.fn(async () => ({ ...result(), rows }))),
    });
    await expect(ports.location.getCurrentLocationOwnerEvidence(scope)).resolves.toEqual(expected);
  });

  it("returns malformed without querying for an invalid runtime scope", async () => {
    const query = vi.fn();
    const ports = createPgHotelCatalogCurrentOwnerEvidencePorts({ pool: pool(query) });
    await expect(
      ports.location.getCurrentLocationOwnerEvidence({ ...scope, propertyId: "wrong" }),
    ).resolves.toEqual({ outcome: "malformed" });
    expect(query).not.toHaveBeenCalled();
  });

  it("maps database rejection to system unavailability", async () => {
    const ports = createPgHotelCatalogCurrentOwnerEvidencePorts({
      pool: pool(vi.fn(async () => Promise.reject(new Error("database unavailable")))),
    });
    await expect(ports.policy.getCurrentPolicyOwnerEvidence(scope)).resolves.toEqual({
      outcome: "unavailable",
      errorSource: "system",
    });
  });
});

function pool(query: ReturnType<typeof vi.fn>): HotelCatalogCurrentOwnerEvidencePool {
  return { query } as HotelCatalogCurrentOwnerEvidencePool;
}

function result(row?: Record<string, unknown>) {
  return {
    command: "SELECT",
    rowCount: row ? 1 : 0,
    oid: 0,
    fields: [],
    rows: row ? [row] : [],
  };
}
