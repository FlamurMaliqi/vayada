/**
 * GEO validation contract — VAY-664.
 *
 * Defines the TypeScript types and pure validation functions that downstream
 * tests (unit, Playwright e2e, and migration parity checks) use to assert:
 *
 * 1. Public hotel pages emit parseable, required-field-complete JSON-LD.
 * 2. Private booking/guest pages are excluded from indexing.
 * 3. Sitemaps include public hotel/room paths and exclude private paths.
 * 4. The public AI profile/quote contract covers all required test cases.
 *
 * This file is deliberately side-effect-free: no HTTP calls, no DOM reads.
 * Playwright specs import the types here and add the browser layer on top.
 */

import { FORBIDDEN_PUBLIC_BOOKABILITY_KEYS } from "./index.js";

// ---------------------------------------------------------------------------
// JSON-LD contract
// ---------------------------------------------------------------------------

export const GEO_JSON_LD_SCHEMA_CONTEXT = "https://schema.org" as const;

export const GEO_REQUIRED_HOTEL_JSON_LD_FIELDS = [
  "@type",
  "@id",
  "name",
  "url",
  "description",
  "address",
  "checkinTime",
  "checkoutTime",
] as const;

export const GEO_REQUIRED_HOTEL_ROOM_JSON_LD_FIELDS = [
  "@type",
  "@id",
  "name",
  "containedInPlace",
] as const;

export type GeoRequiredHotelJsonLdField = (typeof GEO_REQUIRED_HOTEL_JSON_LD_FIELDS)[number];

export type GeoRequiredHotelRoomJsonLdField =
  (typeof GEO_REQUIRED_HOTEL_ROOM_JSON_LD_FIELDS)[number];

/**
 * The minimal public-safe JSON-LD Hotel node shape emitted by booking-web.
 * Downstream tests assert every required field is present and non-empty.
 * Optional fields may be present but must not expose private tenant data.
 */
export type GeoHotelJsonLdNode = {
  "@type": "Hotel";
  "@id": string;
  name: string;
  url: string;
  description?: string | null;
  image?: string[];
  checkinTime?: string | null;
  checkoutTime?: string | null;
  address?: {
    "@type": "PostalAddress";
    streetAddress?: string | null;
    addressLocality?: string | null;
    addressCountry?: string | null;
  };
  starRating?: { "@type": "Rating"; ratingValue: number };
  containsPlace?: Array<{ "@id": string }>;
};

/**
 * The minimal public-safe JSON-LD HotelRoom node shape.
 * `containedInPlace` must reference the parent Hotel `@id`.
 * `offers` must NOT appear on public room nodes (price/availability
 * is served by the quote API, not embedded in JSON-LD).
 */
export type GeoHotelRoomJsonLdNode = {
  "@type": "HotelRoom";
  "@id": string;
  name: string;
  containedInPlace: { "@id": string };
  description?: string | null;
  image?: string[];
  bed?: string | null;
  floorSize?: { "@type": "QuantitativeValue"; value: number; unitCode: string };
  occupancy?: { "@type": "QuantitativeValue"; maxValue: number };
  // `offers` must be absent; its presence is a GEO regression.
  offers?: never;
};

/** Full @graph array extracted from a public hotel page's JSON-LD script. */
export type GeoPublicHotelJsonLdGraph = {
  "@context": typeof GEO_JSON_LD_SCHEMA_CONTEXT;
  "@graph": Array<GeoHotelJsonLdNode | GeoHotelRoomJsonLdNode>;
};

export type GeoJsonLdValidationResult = {
  valid: boolean;
  missingRequiredFields: string[];
  forbiddenFields: string[];
  errors: string[];
};

/**
 * Derived from FORBIDDEN_PUBLIC_BOOKABILITY_KEYS so the two lists stay in
 * sync automatically.  Do NOT maintain a separate list here.
 *
 * Keys are stored lowercased for case-insensitive matching against JSON-LD
 * object keys.  The map from lowercase → original preserves the original
 * casing for error reporting.
 */
const FORBIDDEN_JSON_LD_FIELDS_LOWER_TO_ORIGINAL: ReadonlyMap<string, string> = new Map(
  FORBIDDEN_PUBLIC_BOOKABILITY_KEYS.map((k) => [k.toLowerCase(), k]),
);

/**
 * Recursively collects all object keys (lowercased) from a value tree.
 * Only key names are visited — values are never scanned.
 */
function collectJsonLdKeys(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdKeys(item, out);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.add(key.toLowerCase());
    collectJsonLdKeys(child, out);
  }
}

/**
 * Validates a parsed JSON-LD Hotel node against the GEO contract.
 * Returns a typed result that tests can assert on without branching.
 */
export function validateHotelJsonLdNode(node: Record<string, unknown>): GeoJsonLdValidationResult {
  const missingRequiredFields: string[] = [];
  const forbiddenFields: string[] = [];
  const errors: string[] = [];

  for (const field of GEO_REQUIRED_HOTEL_JSON_LD_FIELDS) {
    const value = node[field];
    if (value === undefined || value === null || value === "") {
      missingRequiredFields.push(field);
    }
  }

  if (node["@type"] !== "Hotel") {
    errors.push(`Expected @type "Hotel", got "${String(node["@type"])}"`);
  }

  const presentKeys = new Set<string>();
  collectJsonLdKeys(node, presentKeys);
  for (const [lowerKey, originalKey] of FORBIDDEN_JSON_LD_FIELDS_LOWER_TO_ORIGINAL) {
    if (presentKeys.has(lowerKey)) {
      forbiddenFields.push(originalKey);
    }
  }

  return {
    valid:
      missingRequiredFields.length === 0 && forbiddenFields.length === 0 && errors.length === 0,
    missingRequiredFields,
    forbiddenFields,
    errors,
  };
}

/**
 * Validates a parsed JSON-LD HotelRoom node against the GEO contract.
 */
export function validateHotelRoomJsonLdNode(
  node: Record<string, unknown>,
): GeoJsonLdValidationResult {
  const missingRequiredFields: string[] = [];
  const forbiddenFields: string[] = [];
  const errors: string[] = [];

  for (const field of GEO_REQUIRED_HOTEL_ROOM_JSON_LD_FIELDS) {
    const value = node[field];
    if (value === undefined || value === null || value === "") {
      missingRequiredFields.push(field);
    }
  }

  if (node["@type"] !== "HotelRoom") {
    errors.push(`Expected @type "HotelRoom", got "${String(node["@type"])}"`);
  }

  if ("offers" in node && node["offers"] !== undefined) {
    errors.push(
      'HotelRoom JSON-LD must not include "offers". Price/availability is served by the quote API.',
    );
  }

  const presentKeys = new Set<string>();
  collectJsonLdKeys(node, presentKeys);
  for (const [lowerKey, originalKey] of FORBIDDEN_JSON_LD_FIELDS_LOWER_TO_ORIGINAL) {
    if (presentKeys.has(lowerKey)) {
      forbiddenFields.push(originalKey);
    }
  }

  return {
    valid:
      missingRequiredFields.length === 0 && forbiddenFields.length === 0 && errors.length === 0,
    missingRequiredFields,
    forbiddenFields,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Robots / indexability contract
// ---------------------------------------------------------------------------

/**
 * Page kind classification for robots/crawlability policy.
 *
 * - `public_hotel`: the hotel storefront and room listing. Must be indexable.
 * - `public_room`: an individual room page. Must be indexable.
 * - `checkout`: the multi-step booking form. Must NOT be indexed.
 * - `payment`: the payment step. Must NOT be indexed.
 * - `booking_status`: guest booking confirmation/status. Must NOT be indexed.
 * - `guest_private`: any page that could show guest PII. Must NOT be indexed.
 */
export const GEO_PAGE_KINDS = [
  "public_hotel",
  "public_room",
  "checkout",
  "payment",
  "booking_status",
  "guest_private",
] as const;

export type GeoPageKind = (typeof GEO_PAGE_KINDS)[number];

export const GEO_INDEXABLE_PAGE_KINDS: readonly GeoPageKind[] = [
  "public_hotel",
  "public_room",
] as const;

export const GEO_NOINDEX_PAGE_KINDS: readonly GeoPageKind[] = [
  "checkout",
  "payment",
  "booking_status",
  "guest_private",
] as const;

/**
 * Maps booking-web route path patterns to page kind.
 * Used by GEO validation tests to assert that the correct robots policy
 * is applied without requiring live server responses.
 */
export type GeoPageRobotsPolicy = {
  pathPattern: string;
  pageKind: GeoPageKind;
  shouldBeIndexable: boolean;
  description: string;
};

/**
 * Canonical booking-web robots policy for GEO validation.
 * Tests should assert every entry here matches the live page behavior.
 */
export const GEO_BOOKING_WEB_ROBOTS_POLICIES: readonly GeoPageRobotsPolicy[] = [
  {
    pathPattern: "/{locale}",
    pageKind: "public_hotel",
    shouldBeIndexable: true,
    description: "Hotel storefront root must be indexable.",
  },
  {
    pathPattern: "/{locale}/rooms/{roomId}",
    pageKind: "public_room",
    shouldBeIndexable: true,
    description: "Individual room page must be indexable.",
  },
  {
    pathPattern: "/{locale}/book",
    pageKind: "checkout",
    shouldBeIndexable: false,
    description: "Booking form checkout step must not be indexed.",
  },
  {
    pathPattern: "/{locale}/payment",
    pageKind: "payment",
    shouldBeIndexable: false,
    description: "Payment step must not be indexed.",
  },
  {
    pathPattern: "/{locale}/booking/{reference}",
    pageKind: "booking_status",
    shouldBeIndexable: false,
    description: "Guest booking status page must not be indexed.",
  },
  {
    pathPattern: "/{locale}/confirmation",
    pageKind: "booking_status",
    shouldBeIndexable: false,
    description: "Guest payment confirmation page must not be indexed.",
  },
  {
    pathPattern: "/{locale}/my-booking",
    pageKind: "guest_private",
    shouldBeIndexable: false,
    description: "Guest private booking dashboard must not be indexed.",
  },
  {
    pathPattern: "/{locale}/addons",
    pageKind: "guest_private",
    shouldBeIndexable: false,
    description: "Add-ons selection step must not be indexed.",
  },
] as const;

/**
 * Returns the expected robots policy for a given page kind.
 */
export function geoRobotsPolicyForPageKind(kind: GeoPageKind): {
  shouldBeIndexable: boolean;
  directive: "index,follow" | "noindex,nofollow";
} {
  const shouldBeIndexable = GEO_INDEXABLE_PAGE_KINDS.includes(
    kind as (typeof GEO_INDEXABLE_PAGE_KINDS)[number],
  );
  return {
    shouldBeIndexable,
    directive: shouldBeIndexable ? "index,follow" : "noindex,nofollow",
  };
}

// ---------------------------------------------------------------------------
// Sitemap contract
// ---------------------------------------------------------------------------

/**
 * A single entry in a hotel public sitemap.
 * The contract requires hotel root and supported-locale URLs to be present.
 * Private pages must never appear.
 */
export type GeoSitemapEntry = {
  loc: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
};

export type GeoSitemapValidationResult = {
  valid: boolean;
  missingUrls: string[];
  forbiddenUrls: string[];
  errors: string[];
};

/**
 * URL path fragments that must NEVER appear in a public hotel sitemap.
 * Tests should parse the sitemap XML and assert none of these match.
 */
export const GEO_SITEMAP_FORBIDDEN_PATH_FRAGMENTS = [
  "/book",
  "/payment",
  "/booking/",
  "/confirmation",
  "/my-booking",
  "/addons",
] as const;

export type GeoSitemapForbiddenFragment = (typeof GEO_SITEMAP_FORBIDDEN_PATH_FRAGMENTS)[number];

/**
 * Validates a list of sitemap entries against the GEO contract.
 * @param entries - parsed sitemap URL entries
 * @param expectedBaseUrls - base URLs that must appear at least once (canonical locale variants)
 */
export function validateGeoSitemap(
  entries: GeoSitemapEntry[],
  expectedBaseUrls: string[],
): GeoSitemapValidationResult {
  const missingUrls: string[] = [];
  const forbiddenUrls: string[] = [];
  const errors: string[] = [];

  for (const expected of expectedBaseUrls) {
    const found = entries.some(
      (entry) => entry.loc === expected || entry.loc.startsWith(expected + "/"),
    );
    if (!found) {
      missingUrls.push(expected);
    }
  }

  for (const entry of entries) {
    for (const fragment of GEO_SITEMAP_FORBIDDEN_PATH_FRAGMENTS) {
      if (entry.loc.includes(fragment)) {
        forbiddenUrls.push(`${entry.loc} (matches forbidden fragment "${fragment}")`);
      }
    }
  }

  return {
    valid: missingUrls.length === 0 && forbiddenUrls.length === 0 && errors.length === 0,
    missingUrls,
    forbiddenUrls,
    errors,
  };
}

// ---------------------------------------------------------------------------
// AI profile/quote GEO test case contract
// ---------------------------------------------------------------------------

/**
 * The test case IDs required by VAY-664 acceptance criteria.
 * These must be covered by `PUBLIC_BOOKABILITY_FIXTURES` or dedicated
 * GEO validation tests.
 */
export const GEO_AI_CONTRACT_REQUIRED_CASE_IDS = [
  "bookable",
  "unavailable",
  "stale_availability",
  "missing_payment_readiness",
  "custom_domain",
  "renamed_property",
  "private_hotel",
] as const;

export type GeoAiContractCaseId = (typeof GEO_AI_CONTRACT_REQUIRED_CASE_IDS)[number];

/**
 * Maps each required GEO AI contract case to its expected quote status
 * and the required fixture case it is covered by.
 */
export type GeoAiContractCaseSpec = {
  caseId: GeoAiContractCaseId;
  description: string;
  expectedProfileBookabilityStatus: "bookable" | "unavailable";
  expectedQuoteStatus: "bookable" | "unavailable" | "stale";
  mustHaveJsonLd: boolean;
  mustBeIndexable: boolean;
};

export const GEO_AI_CONTRACT_CASE_SPECS: readonly GeoAiContractCaseSpec[] = [
  {
    caseId: "bookable",
    description: "Fully bookable hotel with live offer and deep link.",
    expectedProfileBookabilityStatus: "bookable",
    expectedQuoteStatus: "bookable",
    mustHaveJsonLd: true,
    mustBeIndexable: true,
  },
  {
    caseId: "unavailable",
    description: "Profile is public but no inventory exists for the requested stay.",
    expectedProfileBookabilityStatus: "unavailable",
    expectedQuoteStatus: "unavailable",
    mustHaveJsonLd: true,
    mustBeIndexable: true,
  },
  {
    caseId: "stale_availability",
    description: "Availability source is stale; quote must not be served as fresh.",
    expectedProfileBookabilityStatus: "bookable",
    expectedQuoteStatus: "stale",
    mustHaveJsonLd: true,
    mustBeIndexable: true,
  },
  {
    caseId: "missing_payment_readiness",
    description: "Hotel has no configured public payment method.",
    expectedProfileBookabilityStatus: "unavailable",
    expectedQuoteStatus: "unavailable",
    mustHaveJsonLd: true,
    mustBeIndexable: true,
  },
  {
    caseId: "custom_domain",
    description: "Verified custom domain is canonical for JSON-LD, canonical meta, and sitemap.",
    expectedProfileBookabilityStatus: "bookable",
    expectedQuoteStatus: "bookable",
    mustHaveJsonLd: true,
    mustBeIndexable: true,
  },
  {
    caseId: "renamed_property",
    description: "Old slug redirects; canonical slug appears in JSON-LD and sitemap.",
    expectedProfileBookabilityStatus: "bookable",
    expectedQuoteStatus: "bookable",
    mustHaveJsonLd: true,
    mustBeIndexable: true,
  },
  {
    caseId: "private_hotel",
    description:
      "Disabled or unpublished hotel must not appear in sitemap, " +
      "must not emit indexable JSON-LD, and must return an unpublished reason in the quote API.",
    expectedProfileBookabilityStatus: "unavailable",
    expectedQuoteStatus: "unavailable",
    mustHaveJsonLd: false,
    mustBeIndexable: false,
  },
] as const;

/**
 * Returns the spec for a given GEO AI contract case ID.
 */
export function geoAiContractCaseSpec(caseId: GeoAiContractCaseId): GeoAiContractCaseSpec {
  const spec = GEO_AI_CONTRACT_CASE_SPECS.find((s) => s.caseId === caseId);
  if (!spec) {
    throw new Error(`No GEO AI contract spec for case "${caseId}"`);
  }
  return spec;
}
