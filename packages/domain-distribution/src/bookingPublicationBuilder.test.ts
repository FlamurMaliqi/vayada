// prettier-ignore
import { createProductReadinessResult, createReadyProductReadinessEvidence, type ReadyProductReadinessEvidence, type SourceEntityRevision } from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import { PUBLIC_BOOKABILITY_FIXTURES } from "./fixtures.js";
import { createBookingPublicationBuilder } from "./bookingPublicationBuilder.js";
// prettier-ignore
import { BOOKING_OWNER_SNAPSHOT_VERSION, type BookingPublicationOwnerSnapshot, type BookingPublicationOwnerSnapshotPort, type BookingPublicationSnapshotContent, type BookingPublicationSnapshotOwner } from "./bookingPublicationOwnerSnapshots.js";

const propertyId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000001";
const generatedAt = "2026-06-06T11:00:00.000Z";

describe("Booking publication builder", () => {
  it("builds only from exact manifest-bound owner snapshots", async () => {
    const readiness = await readyEvidence();
    const harness = setup(readiness);
    const result = await harness.builder.build({ organizationId, readiness, generatedAt });

    expect(result).toMatchObject({
      outcome: "built",
      build: {
        sourceManifestHash: readiness.sourceManifestHash,
        readinessHash: readiness.readinessHash,
        publicContent: { rooms: [{ roomTypeId: "room-deluxe" }] },
      },
    });
    expect(
      result.outcome === "built" && result.build.publicContent.profile.hotel.branding,
    ).not.toHaveProperty("wholesaleCost");
    for (const owner of harness.ports) {
      expect(owner.calls).toHaveLength(1);
      expect(owner.calls[0]).toMatchObject({
        organizationId,
        propertyId,
        sourceManifestHash: readiness.sourceManifestHash,
      });
      expect(Object.isFrozen(owner.calls[0]?.sourceManifest)).toBe(true);
    }
  });

  it("fails closed for unavailable, mismatched, or incomplete snapshots", async () => {
    const readiness = await readyEvidence();
    const snapshots = snapshotSet(readiness);
    await expect(
      run(readiness, { finance: { outcome: "unavailable", owner: "finance" } }),
    ).resolves.toEqual({ outcome: "rejected", code: "owner_snapshot_unavailable" });

    await expect(
      run(readiness, {
        hotel_catalog: { ...snapshots.hotel_catalog, propertyId: "wrong-property" },
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "source_manifest_mismatch" });

    await expect(
      run(readiness, {
        pms: { ...snapshots.pms, content: { ...snapshots.pms.content, rooms: [] } },
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "public_content_incomplete" });

    await expect(
      run(readiness, {
        hotel_catalog: {
          ...snapshots.hotel_catalog,
          content: {
            ...snapshots.hotel_catalog.content,
            publicContacts: [{ type: "email", value: "not-an-email" }],
          },
        },
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "public_content_incomplete" });

    await expect(run(readiness, {}, "http")).resolves.toEqual({
      outcome: "rejected",
      code: "public_content_incomplete",
    });
  });

  it.each(["custom-mismatch", "credentials"] as const)("rejects unsafe %s URLs", async (web) => {
    const readiness = await readyEvidence();
    await expect(run(readiness, {}, web)).resolves.toEqual({
      outcome: "rejected",
      code: "public_content_incomplete",
    });
  });
});

type SnapshotResult<Owner extends BookingPublicationSnapshotOwner> =
  | BookingPublicationOwnerSnapshot<Owner>
  | Readonly<{ outcome: "unavailable"; owner: Owner }>;
type Overrides = Partial<{ [Owner in BookingPublicationSnapshotOwner]: SnapshotResult<Owner> }>;

function run(
  readiness: ReadyProductReadinessEvidence<"booking">,
  overrides: Overrides,
  web: "valid" | "http" | "custom-mismatch" | "credentials" = "valid",
) {
  return setup(readiness, overrides, web).builder.build({
    organizationId,
    readiness,
    generatedAt,
  });
}

function setup(
  readiness: ReadyProductReadinessEvidence<"booking">,
  overrides: Overrides = {},
  web: "valid" | "http" | "custom-mismatch" | "credentials" = "valid",
) {
  const snapshots = snapshotSet(readiness);
  const catalog = port("hotel_catalog", overrides.hotel_catalog ?? snapshots.hotel_catalog);
  const booking = port("booking", overrides.booking ?? snapshots.booking);
  const pms = port("pms", overrides.pms ?? snapshots.pms);
  const finance = port("finance", overrides.finance ?? snapshots.finance);
  return {
    ports: [catalog, booking, pms, finance],
    builder: createBookingPublicationBuilder({
      catalog,
      booking,
      pms,
      finance,
      bookingWeb: ({ slug }) => ({
        canonicalUrl:
          web === "http"
            ? "http://wrong.test"
            : web === "custom-mismatch"
              ? "https://book.hotel.test/en"
              : `https://${web === "credentials" ? "user:pass@" : ""}${slug}.booking.test/en`,
        bookingBaseUrl: `https://${web === "credentials" ? "user:pass@" : ""}${slug}.booking.test`,
        customDomainUrl: web === "custom-mismatch" ? "https://book.hotel.test" : null,
        domainVerified: web === "custom-mismatch",
        bookingDeepLinks: true,
      }),
    }),
  };
}

function port<Owner extends BookingPublicationSnapshotOwner>(
  owner: Owner,
  result: SnapshotResult<Owner>,
) {
  type Request = Parameters<BookingPublicationOwnerSnapshotPort<Owner>["getSnapshot"]>[0];
  const calls: Request[] = [];
  return {
    owner,
    calls,
    async getSnapshot(request: Request) {
      calls.push(request);
      return result;
    },
  } satisfies BookingPublicationOwnerSnapshotPort<Owner> & { calls: Request[] };
}

function snapshotSet(readiness: ReadyProductReadinessEvidence<"booking">) {
  const profile = structuredClone(PUBLIC_BOOKABILITY_FIXTURES[0]!.profile);
  const freshness = { status: "fresh" as const, lastUpdatedAt: "2026-06-06T10:55:00.000Z" };
  // prettier-ignore
  const content: BookingPublicationSnapshotContent = { hotel_catalog: { propertyId, slug: profile.hotel.slug, name: profile.hotel.name, timezone: profile.hotel.timezone, defaultLocale: profile.hotel.defaultLocale, supportedLocales: profile.hotel.supportedLocales, location: profile.hotel.location, summary: profile.hotel.summary, images: profile.hotel.images, amenities: profile.hotel.amenities, profileComplete: true, profileVerified: true, bookingWeb: { customDomainUrl: null, domainVerified: false }, freshness }, booking: { branding: { logoUrl: null, heroImage: profile.hotel.images[0]!.url, heroHeading: profile.hotel.name, heroSubtext: profile.hotel.summary, primaryColor: "#0077b6", fontPairing: "modern", wholesaleCost: "private" } as never, policies: profile.hotel.policies, capabilities: profile.hotel.capabilities, supportedQuoteParameters: profile.hotel.supportedQuoteParameters, freshness }, pms: { availabilityReady: true, rooms: rooms(), calendar: calendar(), freshness }, finance: { defaultCurrency: "EUR", supportedCurrencies: ["EUR"], onlinePayment: true, payAtProperty: true, readyPaymentMethods: ["card", "pay_at_property"], freshness } };
  // prettier-ignore
  return Object.fromEntries((["hotel_catalog", "booking", "pms", "finance"] as const).map((owner) => [owner, { outcome: "snapshot", contractVersion: BOOKING_OWNER_SNAPSHOT_VERSION, owner, organizationId, propertyId, sourceManifestHash: readiness.sourceManifestHash, resolvedSources: readiness.sourceManifest.sources.filter((source) => source.ownerDomain === owner && source.entityType !== "booking_launch_dependency_set.v1"), content: content[owner] }])) as unknown as { [Owner in BookingPublicationSnapshotOwner]: BookingPublicationOwnerSnapshot<Owner> };
}

function rooms() {
  // prettier-ignore
  return [{ roomTypeId: "room-deluxe", name: "Deluxe", description: "", category: "deluxe", occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 1 }, beds: [{ type: "king", quantity: 1 }], bedrooms: 1, bathrooms: 1, bathroomType: "private" as const, size: { value: 32, unit: "sqm" as const }, images: [{ url: "https://cdn.test/room.jpg" }], amenities: ["wifi"], rates: [{ ratePlanId: "flex", currency: "EUR", baseNightlyAmount: "125.00", refundable: true, paymentTiming: "pay_at_property" as const }] }];
}

function calendar() {
  // prettier-ignore
  return { sourceRevision: "calendar-r1", materializedRevision: "calendar-r1", currentLocalDate: "2026-06-06", coverageFrom: "2026-06-06", coverageThrough: "2027-06-06", materializedThrough: "2027-06-06", expectedDayCount: 366, materializedDayCount: 366, gapCount: 0, roomTypeIds: ["room-deluxe"], observedAt: generatedAt };
}

async function readyEvidence() {
  // prettier-ignore
  const sources: SourceEntityRevision[] = [{ ownerDomain: "hotel_catalog", entityType: "property_profile", entityId: propertyId, revision: "catalog-r1" }, { ownerDomain: "booking", entityType: "design_revision", entityId: propertyId, revision: "booking-r1" }, { ownerDomain: "booking", entityType: "booking_launch_dependency_set.v1", entityId: "derived", revision: "derived-r1" }, { ownerDomain: "pms", entityType: "room_snapshot", entityId: "room-deluxe", revision: "room-r1" }, { ownerDomain: "pms", entityType: "pricing_snapshot", entityId: propertyId, revision: "pricing-r1" }, { ownerDomain: "pms", entityType: "pms_operating_calendar.v1", entityId: propertyId, revision: "calendar-r1" }, { ownerDomain: "finance", entityType: "payment_launch_gate", entityId: propertyId, revision: "finance-r1" }];
  // prettier-ignore
  const result = await createProductReadinessResult({ contractVersion: "onboarding-product-readiness.v1", propertyId, product: "booking", status: "ready", sourceManifest: { contractVersion: "onboarding-source-manifest.v1", propertyId, sources }, groups: [{ groupId: "booking.hotel_profile", status: "ready", steps: [{ owningStepId: "present_hotel", status: "ready", entities: [{ source: sources[0]!, status: "ready", blockers: [] }] }] }], evaluatedAt: generatedAt });
  return createReadyProductReadinessEvidence(result, { propertyId, product: "booking" });
}
