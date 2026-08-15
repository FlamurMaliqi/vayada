import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createActiveBookingPublicationProfileRepository } from "./routes/activeBookingPublicationProfile.js";
import type { PublicHotelProfileReadPool } from "./routes/aiHotels.js";

const profile = PUBLIC_BOOKABILITY_FIXTURES.find(({ caseId }) => caseId === "bookable")!.profile;

describe("active immutable Booking publication profile reads", () => {
  it("returns only a profile reached through the active revision pointer", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const repository = createActiveBookingPublicationProfileRepository({
      connectionString: "postgresql://unused",
      pool: pool(async (text, values) => {
        calls.push({ text, values });
        return [{ propertyId: profile.hotel.propertyId, profile }];
      }),
    });

    await expect(
      repository.findProfileBySlug(` ${profile.hotel.slug.toUpperCase()} `),
    ).resolves.toEqual(profile);
    expect(calls[0]?.text).toContain("distribution.active_public_booking_revision");
    expect(calls[0]?.text).toContain("distribution.public_booking_content_revisions");
    expect(calls[0]?.values).toEqual([profile.hotel.slug]);
  });

  it("fails closed for poisoned or unpublished profile content", async () => {
    const privateProfile = structuredClone(profile);
    privateProfile.hotel.trust.bookabilityStatus = "unavailable";
    privateProfile.hotel.trust.reasonCodes = ["unpublished"];
    const repository = createActiveBookingPublicationProfileRepository({
      connectionString: "postgresql://unused",
      pool: pool(async () => [{ propertyId: profile.hotel.propertyId, profile: privateProfile }]),
    });

    await expect(repository.findProfileBySlug(profile.hotel.slug)).resolves.toBeNull();
    await expect(repository.findProfileBySlug("../private")).resolves.toBeNull();

    privateProfile.hotel.capabilities.instantBook = "true" as unknown as boolean;
    await expect(repository.findProfileBySlug(profile.hotel.slug)).resolves.toBeNull();
  });

  it("normalizes custom domains and gates immutable content on current verified ownership", async () => {
    const calls: unknown[][] = [];
    const domainProfile = structuredClone(profile);
    domainProfile.hotel.canonicalUrl = "https://Book.Example.test:443/en";
    domainProfile.hotel.bookingBaseUrl = "https://Book.Example.test:443/";
    domainProfile.hotel.customDomainUrl = "https://Book.Example.test:443/";
    domainProfile.hotel.trust.domainVerified = true;
    const repository = createActiveBookingPublicationProfileRepository({
      connectionString: "postgresql://unused",
      pool: pool(async (text, values) => {
        calls.push([text, values]);
        return [{ propertyId: domainProfile.hotel.propertyId, profile: domainProfile }];
      }),
    });

    await expect(
      repository.findProfileByCustomDomain?.("HTTPS://Book.Example.test/path"),
    ).resolves.toEqual(domainProfile);
    expect(calls[0]?.[0]).toContain("hotel_catalog.property_domains");
    expect(calls[0]?.[0]).toContain("verification_status = 'verified'");
    expect(calls[0]?.[1]).toEqual(["book.example.test"]);
  });
});

function pool(
  query: (text: string, values?: readonly unknown[]) => Promise<QueryResultRow[]>,
): PublicHotelProfileReadPool {
  return {
    async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
      return { rows: (await query(text, values)) as T[] };
    },
    async end() {},
  };
}
