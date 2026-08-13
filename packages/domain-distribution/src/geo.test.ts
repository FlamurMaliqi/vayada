import { describe, expect, it } from "vitest";

import {
  GEO_AI_CONTRACT_CASE_SPECS,
  GEO_AI_CONTRACT_REQUIRED_CASE_IDS,
  GEO_BOOKING_WEB_ROBOTS_POLICIES,
  GEO_INDEXABLE_PAGE_KINDS,
  GEO_NOINDEX_PAGE_KINDS,
  GEO_SITEMAP_FORBIDDEN_PATH_FRAGMENTS,
  geoAiContractCaseSpec,
  geoRobotsPolicyForPageKind,
  validateGeoSitemap,
  validateHotelJsonLdNode,
  validateHotelRoomJsonLdNode,
} from "./geo.js";
import { PUBLIC_BOOKABILITY_FIXTURE_CASE_IDS, PUBLIC_BOOKABILITY_FIXTURES } from "./fixtures.js";

describe("@vayada/domain-distribution — GEO validation contracts", () => {
  // -------------------------------------------------------------------------
  // JSON-LD contract
  // -------------------------------------------------------------------------

  describe("validateHotelJsonLdNode", () => {
    it("accepts a valid Hotel JSON-LD node", () => {
      const result = validateHotelJsonLdNode({
        "@type": "Hotel",
        "@id": "https://hotel-alpenrose.booking.localhost/en#hotel",
        name: "Hotel Alpenrose",
        url: "https://hotel-alpenrose.booking.localhost/en",
        description: "Independent alpine hotel near the old town.",
        address: {
          "@type": "PostalAddress",
          addressLocality: "Innsbruck",
          addressCountry: "AT",
        },
        checkinTime: "15:00",
        checkoutTime: "11:00",
      });

      expect(result.valid).toBe(true);
      expect(result.missingRequiredFields).toEqual([]);
      expect(result.forbiddenFields).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("rejects a node missing required fields", () => {
      const result = validateHotelJsonLdNode({
        "@type": "Hotel",
        // missing @id, name, url, description, address, checkinTime, checkoutTime
      });

      expect(result.valid).toBe(false);
      expect(result.missingRequiredFields).toContain("@id");
      expect(result.missingRequiredFields).toContain("name");
      expect(result.missingRequiredFields).toContain("url");
      expect(result.missingRequiredFields).toContain("description");
      expect(result.missingRequiredFields).toContain("address");
      expect(result.missingRequiredFields).toContain("checkinTime");
      expect(result.missingRequiredFields).toContain("checkoutTime");
    });

    it("rejects a node that exposes private data", () => {
      const result = validateHotelJsonLdNode({
        "@type": "Hotel",
        "@id": "https://hotel-alpenrose.booking.localhost/en#hotel",
        name: "Hotel Alpenrose",
        url: "https://hotel-alpenrose.booking.localhost/en",
        description: "Independent alpine hotel near the old town.",
        address: {
          "@type": "PostalAddress",
          addressLocality: "Innsbruck",
          addressCountry: "AT",
        },
        checkinTime: "15:00",
        checkoutTime: "11:00",
        guestEmail: "guest@example.com",
      });

      expect(result.valid).toBe(false);
      expect(result.forbiddenFields).toContain("guestEmail");
    });

    it("rejects a node with wrong @type", () => {
      const result = validateHotelJsonLdNode({
        "@type": "Restaurant",
        "@id": "https://hotel-alpenrose.booking.localhost/en#hotel",
        name: "Hotel Alpenrose",
        url: "https://hotel-alpenrose.booking.localhost/en",
        description: "Independent alpine hotel near the old town.",
        address: {
          "@type": "PostalAddress",
          addressLocality: "Innsbruck",
          addressCountry: "AT",
        },
        checkinTime: "15:00",
        checkoutTime: "11:00",
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Expected @type "Hotel", got "Restaurant"');
    });
  });

  describe("validateHotelRoomJsonLdNode", () => {
    it("accepts a valid HotelRoom node", () => {
      const result = validateHotelRoomJsonLdNode({
        "@type": "HotelRoom",
        "@id": "https://hotel-alpenrose.booking.localhost/en#room-room_deluxe",
        name: "Deluxe Double Room",
        containedInPlace: {
          "@id": "https://hotel-alpenrose.booking.localhost/en#hotel",
        },
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects a room node that includes offers (GEO regression guard)", () => {
      const result = validateHotelRoomJsonLdNode({
        "@type": "HotelRoom",
        "@id": "https://hotel-alpenrose.booking.localhost/en#room-room_deluxe",
        name: "Deluxe Double Room",
        containedInPlace: {
          "@id": "https://hotel-alpenrose.booking.localhost/en#hotel",
        },
        offers: {
          "@type": "Offer",
          price: 594,
          priceCurrency: "EUR",
          availability: "https://schema.org/InStock",
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'HotelRoom JSON-LD must not include "offers". Price/availability is served by the quote API.',
      );
    });

    it("rejects a room node missing containedInPlace", () => {
      const result = validateHotelRoomJsonLdNode({
        "@type": "HotelRoom",
        "@id": "https://hotel-alpenrose.booking.localhost/en#room-room_deluxe",
        name: "Deluxe Double Room",
        // missing containedInPlace
      });

      expect(result.valid).toBe(false);
      expect(result.missingRequiredFields).toContain("containedInPlace");
    });
  });

  // -------------------------------------------------------------------------
  // Robots / indexability contract
  // -------------------------------------------------------------------------

  describe("GEO robots policy", () => {
    it("classifies public hotel pages as indexable", () => {
      expect(GEO_INDEXABLE_PAGE_KINDS).toContain("public_hotel");
      expect(GEO_INDEXABLE_PAGE_KINDS).toContain("public_room");
    });

    it("classifies private pages as noindex", () => {
      for (const kind of GEO_NOINDEX_PAGE_KINDS) {
        const policy = geoRobotsPolicyForPageKind(kind);
        expect(policy.shouldBeIndexable).toBe(false);
        expect(policy.directive).toBe("noindex,nofollow");
      }
    });

    it("returns index,follow for public page kinds", () => {
      for (const kind of GEO_INDEXABLE_PAGE_KINDS) {
        const policy = geoRobotsPolicyForPageKind(kind);
        expect(policy.shouldBeIndexable).toBe(true);
        expect(policy.directive).toBe("index,follow");
      }
    });

    it("covers checkout, payment, booking_status, and guest_private as noindex", () => {
      const required: string[] = ["checkout", "payment", "booking_status", "guest_private"];
      for (const kind of required) {
        expect(GEO_NOINDEX_PAGE_KINDS).toContain(kind);
      }
    });

    it("has a robots policy entry for every private booking path pattern", () => {
      const noindexPolicies = GEO_BOOKING_WEB_ROBOTS_POLICIES.filter((p) => !p.shouldBeIndexable);
      const noindexPaths = noindexPolicies.map((p) => p.pathPattern);
      // All checkout-related paths must be listed
      expect(noindexPaths.some((p) => p.includes("book"))).toBe(true);
      expect(noindexPaths.some((p) => p.includes("payment"))).toBe(true);
      expect(noindexPaths.some((p) => p.includes("booking"))).toBe(true);
      expect(noindexPaths.some((p) => p.includes("my-booking"))).toBe(true);
      expect(noindexPaths.some((p) => p.includes("addons"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Sitemap contract
  // -------------------------------------------------------------------------

  describe("validateGeoSitemap", () => {
    it("passes when expected URLs are present and no forbidden paths appear", () => {
      const entries = [
        { loc: "https://hotel-alpenrose.booking.localhost/en" },
        { loc: "https://hotel-alpenrose.booking.localhost/de" },
      ];
      const result = validateGeoSitemap(entries, ["https://hotel-alpenrose.booking.localhost/en"]);

      expect(result.valid).toBe(true);
      expect(result.missingUrls).toEqual([]);
      expect(result.forbiddenUrls).toEqual([]);
    });

    it("reports missing expected locale URLs", () => {
      const entries = [{ loc: "https://hotel-alpenrose.booking.localhost/de" }];
      const result = validateGeoSitemap(entries, ["https://hotel-alpenrose.booking.localhost/en"]);

      expect(result.valid).toBe(false);
      expect(result.missingUrls).toContain("https://hotel-alpenrose.booking.localhost/en");
    });

    it("rejects sitemaps that include forbidden path fragments", () => {
      const entries = [
        { loc: "https://hotel-alpenrose.booking.localhost/en" },
        { loc: "https://hotel-alpenrose.booking.localhost/en/book?check_in=2026-09-12" },
        { loc: "https://hotel-alpenrose.booking.localhost/en/payment" },
        { loc: "https://hotel-alpenrose.booking.localhost/en/confirmation?booking=VAY-1267" },
      ];
      const result = validateGeoSitemap(entries, ["https://hotel-alpenrose.booking.localhost/en"]);

      expect(result.valid).toBe(false);
      expect(result.forbiddenUrls.length).toBeGreaterThanOrEqual(3);
    });

    it("has the expected set of forbidden path fragments", () => {
      const required = [
        "/book",
        "/payment",
        "/booking/",
        "/confirmation",
        "/my-booking",
        "/addons",
      ];
      for (const fragment of required) {
        expect(GEO_SITEMAP_FORBIDDEN_PATH_FRAGMENTS).toContain(fragment);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AI profile/quote GEO contract cases
  // -------------------------------------------------------------------------

  describe("GEO AI contract case specs", () => {
    it("defines a spec for every required VAY-664 case ID", () => {
      const specCaseIds = GEO_AI_CONTRACT_CASE_SPECS.map((s) => s.caseId).sort();
      const required = [...GEO_AI_CONTRACT_REQUIRED_CASE_IDS].sort();
      expect(specCaseIds).toEqual(required);
    });

    it("marks private_hotel as non-indexable with no JSON-LD", () => {
      const spec = geoAiContractCaseSpec("private_hotel");
      expect(spec.mustBeIndexable).toBe(false);
      expect(spec.mustHaveJsonLd).toBe(false);
      expect(spec.expectedQuoteStatus).toBe("unavailable");
    });

    it("marks bookable case as indexable with JSON-LD required", () => {
      const spec = geoAiContractCaseSpec("bookable");
      expect(spec.mustBeIndexable).toBe(true);
      expect(spec.mustHaveJsonLd).toBe(true);
      expect(spec.expectedQuoteStatus).toBe("bookable");
    });

    it("marks stale_availability as indexable but with stale quote status", () => {
      const spec = geoAiContractCaseSpec("stale_availability");
      expect(spec.mustBeIndexable).toBe(true);
      expect(spec.mustHaveJsonLd).toBe(true);
      expect(spec.expectedQuoteStatus).toBe("stale");
    });

    it("marks custom_domain as indexable with JSON-LD required", () => {
      const spec = geoAiContractCaseSpec("custom_domain");
      expect(spec.mustBeIndexable).toBe(true);
      expect(spec.mustHaveJsonLd).toBe(true);
    });

    it("marks renamed_property as indexable with JSON-LD required", () => {
      const spec = geoAiContractCaseSpec("renamed_property");
      expect(spec.mustBeIndexable).toBe(true);
      expect(spec.mustHaveJsonLd).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Fixtures cover the required GEO cases
  // -------------------------------------------------------------------------

  describe("PUBLIC_BOOKABILITY_FIXTURES GEO coverage", () => {
    it("includes a private_hotel fixture case", () => {
      expect(PUBLIC_BOOKABILITY_FIXTURE_CASE_IDS).toContain("private_hotel");
    });

    it("private_hotel fixture has bookabilityStatus unavailable with unpublished reason code", () => {
      const fixture = PUBLIC_BOOKABILITY_FIXTURES.find((f) => f.caseId === "private_hotel");
      expect(fixture).toBeDefined();
      expect(fixture?.profile.hotel.trust.bookabilityStatus).toBe("unavailable");
      expect(fixture?.profile.hotel.trust.reasonCodes).toContain("unpublished");
    });

    it("private_hotel fixture quote is unavailable with unpublished reason", () => {
      const fixture = PUBLIC_BOOKABILITY_FIXTURES.find((f) => f.caseId === "private_hotel");
      expect(fixture?.quote).toBeDefined();
      expect(fixture?.quote?.status).toBe("unavailable");
      expect(fixture?.quote?.unavailableReasons.some((r) => r.code === "unpublished")).toBe(true);
      expect(fixture?.quote?.quote).toBeUndefined();
    });

    it("custom_domain fixture has a verified custom domain URL", () => {
      const fixture = PUBLIC_BOOKABILITY_FIXTURES.find((f) => f.caseId === "custom_domain");
      expect(fixture?.profile.hotel.customDomainUrl).toBe("https://book.alpenrose.example");
      expect(fixture?.profile.hotel.trust.domainVerified).toBe(true);
    });

    it("renamed_property fixture uses the new canonical slug", () => {
      const fixture = PUBLIC_BOOKABILITY_FIXTURES.find((f) => f.caseId === "renamed_property");
      expect(fixture?.profile.hotel.slug).toBe("alpenrose-resort");
      expect(fixture?.profile.hotel.canonicalUrl).toContain("alpenrose-resort");
    });

    it("all bookable/discoverable fixtures have JSON-LD-ready profile fields", () => {
      const bookableFixtures = PUBLIC_BOOKABILITY_FIXTURES.filter(
        (f) => f.caseId !== "private_hotel",
      );
      for (const fixture of bookableFixtures) {
        // Every public fixture must have a resolvable name and canonical URL
        expect(fixture.profile.hotel.name).toBeTruthy();
        expect(fixture.profile.hotel.canonicalUrl).toBeTruthy();
        expect(fixture.profile.hotel.slug).toBeTruthy();
      }
    });
  });
});
