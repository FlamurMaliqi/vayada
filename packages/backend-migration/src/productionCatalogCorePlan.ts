import { createHash } from "node:crypto";

import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import {
  addBlocker,
  optionalText,
  stableJson,
  text,
  uuid,
} from "./productionIdentitySourceValidation.js";
import type { CatalogOwnershipPlan } from "./productionCatalogOwnership.js";

export type PlannedCatalogProperty = {
  id: string;
  publicId: string;
  displayName: string;
  propertyType: string | null;
  category: string | null;
  starRating: number | null;
  defaultLocale: string;
  supportedLocales: string[];
  profileStatus: "complete" | "incomplete" | "private";
  completenessReasons: string[];
  createdAt: string;
  updatedAt: string;
};
export type PlannedCatalogSlug = {
  id: string;
  propertyId: string;
  slug: string;
  purpose: "canonical" | "redirect";
  status: "active" | "redirected";
  redirectsToId: string | null;
  updatedAt: string;
};
export type PlannedCatalogLocation = {
  propertyId: string;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  streetAddress: string | null;
  postalCode: string | null;
  rawMarketplaceLocation: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  sourceConfidence: "high" | "low";
  migrationNotes: string | null;
  updatedAt: string;
};
export type ProductionCatalogCorePlan = {
  properties: PlannedCatalogProperty[];
  slugs: PlannedCatalogSlug[];
  locations: PlannedCatalogLocation[];
  blockers: IdentityMigrationBlocker[];
  checksum: string;
};

export function planProductionCatalogCore(
  rows: IdentitySourceRow[],
  ownership: CatalogOwnershipPlan,
): ProductionCatalogCorePlan {
  const blockers = [...ownership.blockers];
  const translationLocales = parseTranslationLocales(rows, blockers);
  const properties: PlannedCatalogProperty[] = [];
  const slugs: PlannedCatalogSlug[] = [];
  const locations: PlannedCatalogLocation[] = [];

  for (const group of ownership.properties) {
    const booking = group.booking;
    const pms = group.pms[0];
    try {
      const location = buildLocation(
        group.propertyId,
        booking.data,
        pms?.data,
        group.marketplace[0]?.data,
      );
      const defaultLocale = locale(booking.data["default_language"] ?? "en", "default_language");
      const supportedLocales = uniqueLocales([
        defaultLocale,
        ...jsonStringArray(booking.data["supported_languages"], "supported_languages"),
        ...(translationLocales.get(group.propertyId) ?? []),
      ]);
      const canonicalSlug = booking.slug!;
      const canonicalSlugId = stableCatalogId("slug", `${group.propertyId}:${canonicalSlug}`);
      const completenessReasons = [
        ...(!location.countryCode || !location.city ? ["location_unverified"] : []),
        ...(!location.timezone ? ["timezone_missing"] : []),
      ];
      const profileStatus =
        booking.status !== "live"
          ? "private"
          : completenessReasons.length === 0
            ? "complete"
            : "incomplete";
      properties.push({
        id: group.propertyId,
        publicId: `legacy-property-${group.propertyId}`,
        displayName: booking.name,
        propertyType: optionalText(pms?.data["property_type"], "property_type"),
        category: null,
        starRating: starRating(booking.data["star_rating"], blockers, booking.sourceId),
        defaultLocale,
        supportedLocales,
        profileStatus,
        completenessReasons,
        createdAt: booking.createdAt,
        updatedAt: [booking.updatedAt, pms?.updatedAt]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1)!,
      });
      slugs.push({
        id: canonicalSlugId,
        propertyId: group.propertyId,
        slug: canonicalSlug,
        purpose: "canonical",
        status: "active",
        redirectsToId: null,
        updatedAt: booking.updatedAt,
      });
      for (const redirect of new Set(
        jsonStringArray(booking.data["previous_slugs"], "previous_slugs"),
      )) {
        if (redirect === canonicalSlug) {
          addBlocker(
            blockers,
            "INVALID_REDIRECT_SLUG",
            "booking.booking_hotels",
            booking.sourceId,
            "previous_slugs contains the active canonical slug",
          );
          continue;
        }
        slugs.push({
          id: stableCatalogId("slug", `${group.propertyId}:${redirect}`),
          propertyId: group.propertyId,
          slug: redirect.trim().toLowerCase(),
          purpose: "redirect",
          status: "redirected",
          redirectsToId: canonicalSlugId,
          updatedAt: booking.updatedAt,
        });
      }

      locations.push(location);
    } catch (error) {
      addBlocker(
        blockers,
        "INVALID_CATALOG_CORE_FACT",
        "booking.booking_hotels",
        booking.sourceId,
        error instanceof Error ? error.message : "Invalid catalog core fact",
      );
    }
  }
  const propertyIds = new Set(ownership.properties.map((group) => group.propertyId));
  for (const hotelId of translationLocales.keys())
    if (!propertyIds.has(hotelId))
      addBlocker(
        blockers,
        "ORPHAN_CATALOG_TRANSLATION",
        "booking.booking_hotel_translations",
        hotelId,
        "Translation does not map to a canonical property",
      );
  addDuplicateValues(slugs, (row) => row.slug, "DUPLICATE_CATALOG_SLUG", blockers);
  const content = {
    properties: sortedBy(properties, (row) => row.id),
    slugs: sortedBy(slugs, (row) => `${row.slug}:${row.propertyId}`),
    locations: sortedBy(locations, (row) => row.propertyId),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
  return {
    ...content,
    checksum: createHash("sha256").update(stableJson(content)).digest("hex"),
  };
}

function buildLocation(
  propertyId: string,
  booking: Record<string, unknown>,
  pms: Record<string, unknown> | undefined,
  marketplace: Record<string, unknown> | undefined,
): PlannedCatalogLocation {
  const country =
    optionalText(pms?.["country"], "country") ?? optionalText(booking["country"], "country");
  const countryCode =
    country && /^[A-Za-z]{2}$/.test(country.trim()) ? country.trim().toUpperCase() : null;
  const latitude = numberOrNull(pms?.["latitude"], "latitude");
  const longitude = numberOrNull(pms?.["longitude"], "longitude");
  if ((latitude === null) !== (longitude === null))
    throw new Error("latitude and longitude must be supplied together");
  const timezone =
    optionalText(pms?.["timezone"], "timezone") ?? optionalText(booking["timezone"], "timezone");
  const notes =
    country && !countryCode ? `Legacy country retained without ISO promotion: ${country}` : null;
  return {
    propertyId,
    countryCode,
    region: optionalText(pms?.["state"], "state"),
    city: optionalText(pms?.["city"], "city"),
    streetAddress:
      optionalText(pms?.["address"], "address") ??
      optionalText(booking["contact_address"], "contact_address"),
    postalCode: optionalText(pms?.["zip_code"], "zip_code"),
    rawMarketplaceLocation: optionalText(marketplace?.["location"], "location"),
    latitude: latitude !== null && longitude !== null ? latitude : null,
    longitude: latitude !== null && longitude !== null ? longitude : null,
    timezone: timezone && /^[A-Za-z_]+\/[A-Za-z0-9_+./-]+$/.test(timezone) ? timezone : null,
    sourceConfidence: pms ? "high" : "low",
    migrationNotes: notes,
    updatedAt:
      optionalText(pms?.["updated_at"], "updated_at") ?? text(booking["updated_at"], "updated_at"),
  };
}

function parseTranslationLocales(
  rows: IdentitySourceRow[],
  blockers: IdentityMigrationBlocker[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows.filter(
    (item) =>
      item.sourceDatabase === "booking" && item.sourceTable === "booking_hotel_translations",
  )) {
    try {
      const hotelId = uuid(row.data["hotel_id"], "hotel_id");
      result.set(hotelId, [...(result.get(hotelId) ?? []), locale(row.data["locale"], "locale")]);
    } catch (error) {
      addBlocker(
        blockers,
        "INVALID_CATALOG_TRANSLATION",
        "booking.booking_hotel_translations",
        `row:${row.rowOrdinal}`,
        error instanceof Error ? error.message : "Invalid translation",
      );
    }
  }
  return result;
}

export function stableCatalogId(kind: string, value: string): string {
  const bytes = Buffer.from(
    createHash("sha1").update(`vayada:catalog:${kind}:${value}`).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function locale(value: unknown, field: string): string {
  const result = text(value, field).trim().toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z0-9]{2,8})*$/.test(result)) throw new Error(`${field} is not a locale`);
  return result;
}
function uniqueLocales(values: string[]): string[] {
  return [...new Set(values)].sort();
}
function jsonStringArray(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${field} must be a string array`);
  return value.map((item) => item.trim().toLowerCase()).filter(Boolean);
}
function numberOrNull(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be numeric`);
  return value;
}
function starRating(
  value: unknown,
  blockers: IdentityMigrationBlocker[],
  sourceId: string,
): number | null {
  const rating = numberOrNull(value, "star_rating");
  if (rating === null || rating === 0) return null;
  if (rating >= 1 && rating <= 5) return rating;
  addBlocker(
    blockers,
    "INVALID_STAR_RATING",
    "booking.booking_hotels",
    sourceId,
    "star_rating must be between 0 and 5",
  );
  return null;
}
function addDuplicateValues<T extends { propertyId: string }>(
  rows: T[],
  value: (row: T) => string,
  code: string,
  blockers: IdentityMigrationBlocker[],
): void {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows)
    grouped.set(value(row), new Set([...(grouped.get(value(row)) ?? []), row.propertyId]));
  for (const [item, owners] of grouped)
    if (owners.size > 1)
      addBlocker(
        blockers,
        code,
        "hotel_catalog",
        item,
        "Value resolves to multiple canonical properties",
      );
}
