import { describe, expect, it } from "vitest";

import type { ProductionCatalogContentPlan } from "./productionCatalogContentPlan.js";
import type { ProductionCatalogCorePlan } from "./productionCatalogCorePlan.js";
import type { ProductionCatalogPresentationPlan } from "./productionCatalogPresentationPlan.js";
import { reconcileProductionCatalog } from "./productionCatalogReconciliation.js";
import type { ProductionCatalogTargetState } from "./productionCatalogTargetReader.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const OLD = "2026-08-01T00:00:00Z";
const NEW = "2026-08-02T00:00:00Z";
const RUN = "vay1351-0123456789abcdef01234567";

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

  it("treats target publication status as target-owned", () => {
    const core = emptyCore();
    core.properties.push(property(NEW, "Hotel"));
    const target = emptyTarget();
    target.properties.push({ ...property(NEW, "Hotel"), profileStatus: "private" });

    const plan = reconcileProductionCatalog(core, emptyContent(), emptyPresentation(), target);

    expect(plan.blockers).toEqual([]);
    expect(plan.writes.properties).toEqual([]);
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

  it("preserves child-row deletions on reruns of the same immutable source", () => {
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
    target.sourceLinks.push({
      propertyId: PROPERTY,
      sourceSystem: "booking",
      sourceTable: "booking_hotels",
      sourceId: PROPERTY,
      relationship: "canonical_input",
      migrationRunId: RUN,
    });

    const plan = reconcileProductionCatalog(emptyCore(), content, emptyPresentation(), target);

    expect(plan.writes.contacts).toEqual([]);
    expect(plan.preservedTarget).toEqual([
      expect.objectContaining({
        entity: "property_contact_channels",
        reason: "target_removed",
      }),
    ]);
  });
  it("recovers arrival ranges only for unchanged migration-owned policy rows", () => {
    const content = emptyContent();
    content.policies.push({
      propertyId: PROPERTY,
      checkInTime: "12:00",
      checkOutTime: "11:00",
      checkInUntil: "23:00",
      checkOutFrom: null,
      cancellationSummary: null,
      paymentPolicySummary: null,
      updatedAt: OLD,
    });
    const target = emptyTarget();
    target.policies.push({ ...content.policies[0], checkInTime: "15:00", checkInUntil: null });
    target.sourceLinks.push({
      propertyId: PROPERTY,
      sourceSystem: "booking",
      sourceTable: "booking_hotels",
      sourceId: PROPERTY,
      relationship: "canonical_input",
      migrationRunId: RUN,
    });
    const reconcile = () =>
      reconcileProductionCatalog(emptyCore(), content, emptyPresentation(), target);
    expect(reconcile().writes.policies).toEqual(content.policies);
    target.ownerRevisions.push({
      propertyId: PROPERTY,
      ownerKey: "hotel_catalog.policy",
      revision: "2",
    });
    expect(reconcile().writes.policies).toEqual([]);
    target.ownerRevisions = [];
    target.sourceLinks = [];
    expect(reconcile().blockers.map((item) => item.code)).toContain("CATALOG_EQUAL_TIME_CONFLICT");
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
    ownerLinks: [],
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
