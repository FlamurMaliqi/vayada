import { describe, expect, it } from "vitest";

import {
  HOTEL_CATALOG_CURRENT_OWNER_REVISION_MAX,
  createHotelCatalogCurrentOwnerEvidence,
  parseHotelCatalogCurrentOwnerEvidenceScope,
  parseHotelCatalogLocationCurrentOwnerEvidenceResult,
  parseHotelCatalogPolicyCurrentOwnerEvidenceResult,
} from "./hotelCatalogCurrentOwnerEvidence.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const propertyId = "30000000-0000-4000-8000-000000000001";
const scope = { organizationId, propertyId };

describe("Hotel Catalog current-owner evidence", () => {
  it("normalizes an exact scope and creates canonical stable source identities", () => {
    expect(
      parseHotelCatalogCurrentOwnerEvidenceScope({
        organizationId: organizationId.toUpperCase(),
        propertyId: propertyId.toUpperCase(),
      }),
    ).toEqual(scope);
    expect(createHotelCatalogCurrentOwnerEvidence("hotel_catalog.location", scope, 7)).toEqual({
      ...scope,
      ownerKey: "hotel_catalog.location",
      sourceIdentity: `hotel_catalog.location:${propertyId}`,
      revision: 7,
      baseRevision: `hotel_catalog.location:${propertyId}:r7`,
    });
    expect(createHotelCatalogCurrentOwnerEvidence("hotel_catalog.policy", scope, 9)).toEqual({
      ...scope,
      ownerKey: "hotel_catalog.policy",
      sourceIdentity: `hotel_catalog.policy:${propertyId}`,
      revision: 9,
      baseRevision: `hotel_catalog.policy:${propertyId}:r9`,
    });
  });

  it("parses and freezes exact independently typed owner evidence", () => {
    const location = available("hotel_catalog.location", 4);
    const policy = available("hotel_catalog.policy", 6);
    const parsedLocation = parseHotelCatalogLocationCurrentOwnerEvidenceResult(location, scope);
    const parsedPolicy = parseHotelCatalogPolicyCurrentOwnerEvidenceResult(policy, scope);
    expect(parsedLocation).toEqual(location);
    expect(parsedPolicy).toEqual(policy);
    expect(Object.isFrozen(parsedLocation)).toBe(true);
    expect(
      Object.isFrozen(parsedLocation?.outcome === "available" && parsedLocation.evidence),
    ).toBe(true);
  });

  it.each([
    { outcome: "missing", reason: "property_scope" },
    { outcome: "missing", reason: "owner_state" },
    { outcome: "malformed" },
    { outcome: "unavailable", errorSource: "provider" },
    { outcome: "unavailable", errorSource: "system" },
  ])("keeps typed absence and failure outcome %#", (value) => {
    expect(parseHotelCatalogLocationCurrentOwnerEvidenceResult(value, scope)).toEqual(value);
  });

  it.each([
    { ...available("hotel_catalog.location", 1), extra: true },
    { outcome: "missing" },
    { outcome: "missing", reason: "policy" },
    { outcome: "unavailable", errorSource: "network" },
    available("hotel_catalog.policy", 1),
    available("hotel_catalog.location", 0),
    available("hotel_catalog.location", HOTEL_CATALOG_CURRENT_OWNER_REVISION_MAX + 1),
    withEvidence({ organizationId: "20000000-0000-4000-8000-000000000001" }),
    withEvidence({ propertyId: "30000000-0000-4000-8000-000000000002" }),
    withEvidence({ sourceIdentity: `hotel_catalog.location:${propertyId}:other` }),
    withEvidence({ baseRevision: `hotel_catalog.location:${propertyId}:r8` }),
  ])("rejects malformed, cross-scope, and fabricated location evidence %#", (value) => {
    expect(parseHotelCatalogLocationCurrentOwnerEvidenceResult(value, scope)).toBeNull();
  });

  it("rejects accessors, symbol keys, non-data prototypes, and malformed scopes", () => {
    const accessor = Object.defineProperty({}, "outcome", {
      enumerable: true,
      get: () => "malformed",
    });
    const symbol = { outcome: "malformed", [Symbol("forged")]: true };
    expect(parseHotelCatalogLocationCurrentOwnerEvidenceResult(accessor, scope)).toBeNull();
    expect(parseHotelCatalogLocationCurrentOwnerEvidenceResult(symbol, scope)).toBeNull();
    expect(
      parseHotelCatalogLocationCurrentOwnerEvidenceResult(
        Object.assign(Object.create({}), { outcome: "malformed" }),
        scope,
      ),
    ).toBeNull();
    expect(
      parseHotelCatalogCurrentOwnerEvidenceScope({ organizationId, propertyId, extra: 1 }),
    ).toBe(null);
  });
});

function available(ownerKey: "hotel_catalog.location" | "hotel_catalog.policy", revision: number) {
  const evidence = createHotelCatalogCurrentOwnerEvidence(ownerKey, scope, revision);
  return { outcome: "available", evidence };
}

function withEvidence(override: Record<string, unknown>) {
  const result = available("hotel_catalog.location", 7);
  return { ...result, evidence: { ...result.evidence, ...override } };
}
