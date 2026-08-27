import type { SourceEntityRevision } from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

// prettier-ignore
import { BOOKING_OWNER_SNAPSHOT_VERSION, bookingPublicationOwnerSnapshotProvenanceMatches, type BookingPublicationOwnerSnapshot, type BookingPublicationSnapshotContent, type BookingPublicationSnapshotOwner, type BookingPublicationSnapshotRequest } from "./bookingPublicationOwnerSnapshots.js";

const propertyId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000001";
const sourceManifestHash = `sha256:${"1".repeat(64)}` as const;
// prettier-ignore
const sources: SourceEntityRevision[] = [{ ownerDomain: "hotel_catalog", entityType: "property_profile", entityId: propertyId, revision: "catalog-r1" }, { ownerDomain: "booking", entityType: "design_revision", entityId: propertyId, revision: "booking-r1" }, { ownerDomain: "booking", entityType: "booking_launch_dependency_set.v1", entityId: "derived", revision: "derived-r1" }, { ownerDomain: "pms", entityType: "room_snapshot", entityId: "room-deluxe", revision: "room-r1" }, { ownerDomain: "pms", entityType: "pricing_snapshot", entityId: propertyId, revision: "pricing-r1" }, { ownerDomain: "pms", entityType: "pms_operating_calendar.v1", entityId: propertyId, revision: "calendar-r1" }, { ownerDomain: "finance", entityType: "payment_launch_gate", entityId: propertyId, revision: "finance-r1" }];
const request: BookingPublicationSnapshotRequest = {
  organizationId,
  propertyId,
  sourceManifestHash,
  sourceManifest: { contractVersion: "onboarding-source-manifest.v1", propertyId, sources },
};

describe("Booking publication owner snapshots", () => {
  it("matches each owner's exact manifest sources and ignores derived bindings", () => {
    for (const owner of ["hotel_catalog", "booking", "pms", "finance"] as const) {
      const value = snapshot(owner);
      expect(bookingPublicationOwnerSnapshotProvenanceMatches(value, owner, request)).toBe(true);
      if (owner === "booking")
        expect(value.resolvedSources.map(({ entityType }) => entityType)).not.toContain(
          "booking_launch_dependency_set.v1",
        );
    }
  });

  it.each(["wrong", "missing", "extra"] as const)("rejects %s resolved sources", (fault) => {
    const value = snapshot("pms");
    const resolvedSources = [...value.resolvedSources];
    if (fault === "wrong") resolvedSources[0] = { ...resolvedSources[0]!, revision: "wrong" };
    if (fault === "missing") resolvedSources.pop();
    if (fault === "extra") resolvedSources.push({ ...resolvedSources[0]!, entityId: "extra" });
    expect(
      bookingPublicationOwnerSnapshotProvenanceMatches(
        { ...value, resolvedSources },
        "pms",
        request,
      ),
    ).toBe(false);
  });

  it("binds the materialized calendar to its manifest revision", () => {
    const value = snapshot("pms");
    const content = { ...value.content, calendar: { sourceRevision: "wrong-r1" } };
    expect(
      bookingPublicationOwnerSnapshotProvenanceMatches({ ...value, content }, "pms", request),
    ).toBe(false);
  });

  it("requires a content envelope without claiming to validate its fields", () => {
    expect(
      bookingPublicationOwnerSnapshotProvenanceMatches(
        { ...snapshot("finance"), content: null },
        "finance",
        request,
      ),
    ).toBe(false);
  });

  it.each(["source", "revision", "identity", "duplicate"] as const)(
    "rejects missing or ambiguous calendar %s",
    (fault) => {
      const value = snapshot("pms");
      const calendar = value.resolvedSources.find(
        ({ entityType }) => entityType === "pms_operating_calendar.v1",
      )!;
      let resolvedSources = value.resolvedSources.filter((source) => source !== calendar);
      if (fault === "identity")
        resolvedSources = [...resolvedSources, { ...calendar, entityId: "wrong" }];
      if (fault === "duplicate")
        resolvedSources = [...value.resolvedSources, { ...calendar, entityId: "other" }];
      const content = fault === "revision" ? { ...value.content, calendar: {} } : value.content;
      expect(
        bookingPublicationOwnerSnapshotProvenanceMatches(
          { ...value, content, resolvedSources },
          "pms",
          { ...request, sourceManifest: { ...request.sourceManifest, sources: resolvedSources } },
        ),
      ).toBe(false);
    },
  );

  it("rejects reserved derived provenance outside Booking", () => {
    const wrong = {
      ...sources[0]!,
      ownerDomain: "pms" as const,
      entityType: "booking_launch_dependency_set.v1",
    };
    const sourceManifest = { ...request.sourceManifest, sources: [...sources, wrong] };
    expect(
      bookingPublicationOwnerSnapshotProvenanceMatches(snapshot("pms"), "pms", {
        ...request,
        sourceManifest,
      }),
    ).toBe(false);
  });
});

function snapshot<Owner extends BookingPublicationSnapshotOwner>(
  owner: Owner,
): BookingPublicationOwnerSnapshot<Owner> {
  const content = (
    owner === "pms" ? { calendar: { sourceRevision: "calendar-r1" } } : {}
  ) as BookingPublicationSnapshotContent[Owner];
  return {
    outcome: "snapshot",
    contractVersion: BOOKING_OWNER_SNAPSHOT_VERSION,
    owner,
    organizationId,
    propertyId,
    sourceManifestHash,
    resolvedSources: sources.filter(
      (source) =>
        source.ownerDomain === owner && source.entityType !== "booking_launch_dependency_set.v1",
    ) as unknown as BookingPublicationOwnerSnapshot<Owner>["resolvedSources"],
    content,
  };
}
