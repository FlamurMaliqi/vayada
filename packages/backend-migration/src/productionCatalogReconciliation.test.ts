import { describe, expect, it } from "vitest";

import type { ProductionCatalogContentPlan } from "./productionCatalogContentPlan.js";
import type { ProductionCatalogCorePlan } from "./productionCatalogCorePlan.js";
import type { ProductionCatalogPresentationPlan } from "./productionCatalogPresentationPlan.js";
import { reconcileProductionCatalog } from "./productionCatalogReconciliation.js";
import type { ProductionCatalogTargetState } from "./productionCatalogTargetReader.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const OLD = "2026-08-01T00:00:00Z";
const NEW = "2026-08-02T00:00:00Z";

describe("production catalog reconciliation", () => {
  it("preserves newer and target-owned state without copying stale legacy values", () => {
    const core = emptyCore();
    core.properties.push(property(OLD, "Legacy name"));
    core.locations.push(location(NEW, "Legacy city"));
    const content = emptyContent();
    content.contacts.push({
      propertyId: PROPERTY,
      channelType: "phone",
      value: "+1",
      purpose: "general",
      isPublic: false,
      sourceSystem: "booking",
      updatedAt: NEW,
    });
    const target = emptyTarget();
    target.properties.push({ ...property(NEW, "Target name") });
    target.locations.push({ ...location(OLD, "Target city") });
    target.contacts.push({
      propertyId: PROPERTY,
      channelType: "phone",
      value: "+1",
      sourceSystem: "booking",
      isPublic: true,
      updatedAt: NEW,
    });
    target.ownerRevisions.push({
      propertyId: PROPERTY,
      ownerKey: "hotel_catalog.location",
      revision: "2",
    });

    const plan = reconcileProductionCatalog(core, content, emptyPresentation(), target);

    expect(plan.blockers).toEqual([]);
    expect(plan.writes.locations).toEqual([]);
    expect(plan.preservedTarget.map((row) => row.reason)).toEqual(
      expect.arrayContaining(["target_newer", "target_owner_revision", "identical"]),
    );
  });

  it("blocks equal-time disagreement and writes only absent rows", () => {
    const core = emptyCore();
    core.properties.push(property(NEW, "Legacy name"));
    core.slugs.push({
      id: PROPERTY,
      propertyId: PROPERTY,
      slug: "new-hotel",
      purpose: "canonical",
      status: "active",
      redirectsToId: null,
      updatedAt: NEW,
    });
    const target = emptyTarget();
    target.properties.push({ ...property(NEW, "Different target name") });

    const plan = reconcileProductionCatalog(core, emptyContent(), emptyPresentation(), target);

    expect(plan.blockers.map((row) => row.code)).toContain("CATALOG_EQUAL_TIME_CONFLICT");
    expect(plan.writes.properties).toEqual([]);
    expect(plan.writes.slugs).toHaveLength(1);
  });

  it("blocks rather than replacing a target canonical slug", () => {
    const core = emptyCore();
    core.slugs.push({
      id: PROPERTY,
      propertyId: PROPERTY,
      slug: "legacy",
      purpose: "canonical",
      status: "active",
      redirectsToId: null,
      updatedAt: NEW,
    });
    const target = emptyTarget();
    target.slugs.push({
      propertyId: PROPERTY,
      slug: "target",
      purpose: "canonical",
      status: "active",
      updatedAt: OLD,
    });

    const plan = reconcileProductionCatalog(core, emptyContent(), emptyPresentation(), target);

    expect(plan.blockers.map((row) => row.code)).toContain("CATALOG_CANONICAL_SLUG_CONFLICT");
    expect(plan.writes.slugs).toEqual([]);
  });
});

function property(updatedAt: string, displayName: string) {
  return {
    id: PROPERTY,
    publicId: `legacy-property-${PROPERTY}`,
    displayName,
    propertyType: null,
    category: null,
    starRating: null,
    defaultLocale: "en",
    supportedLocales: ["en"],
    profileStatus: "complete" as const,
    completenessReasons: [],
    createdAt: OLD,
    updatedAt,
  };
}
function location(updatedAt: string, city: string) {
  return {
    propertyId: PROPERTY,
    countryCode: "AT",
    region: null,
    city,
    streetAddress: null,
    postalCode: null,
    rawMarketplaceLocation: null,
    latitude: null,
    longitude: null,
    timezone: "Europe/Vienna",
    sourceConfidence: "high" as const,
    migrationNotes: null,
    updatedAt,
  };
}
function emptyCore(): ProductionCatalogCorePlan {
  return { properties: [], slugs: [], locations: [], blockers: [], checksum: "" };
}
function emptyContent(): ProductionCatalogContentPlan {
  return { profiles: [], amenities: [], contacts: [], policies: [], blockers: [], checksum: "" };
}
function emptyPresentation(): ProductionCatalogPresentationPlan {
  return { domains: [], media: [], blockers: [], checksum: "" };
}
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
