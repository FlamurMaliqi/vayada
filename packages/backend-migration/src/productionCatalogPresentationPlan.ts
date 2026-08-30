import { createHash } from "node:crypto";

import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import { addBlocker, optionalText, stableJson } from "./productionIdentitySourceValidation.js";
import type { ProductionCatalogContentPlan } from "./productionCatalogContentPlan.js";
import { stableCatalogId } from "./productionCatalogCorePlan.js";
import type { CatalogOwnershipPlan, CatalogSourceSystem } from "./productionCatalogOwnership.js";

export type ExistingCatalogDomain = {
  id: string;
  propertyId: string;
  hostname: string;
  verificationStatus: "verified" | "pending" | "failed" | "disabled";
  canonicalWhenVerified: boolean;
  verifiedAt: string | null;
  updatedAt: string;
};
export type ExistingCatalogMediaObject = {
  id: string;
  propertyId: string | null;
  purpose: "property.hero_image" | "property.gallery_image" | "property.logo";
  sourceSystem: CatalogSourceSystem;
  sourceTable: string;
  sourceRowId: string;
  visibility: "public" | "private";
  lifecycleStatus: string;
  publicApproved: boolean;
};
export type PlannedCatalogDomain = ExistingCatalogDomain;
export type PlannedCatalogMediaAssignment = {
  id: string;
  propertyId: string;
  platformMediaObjectId: string;
  mediaType: "hero_image" | "gallery_image" | "logo";
  sortOrder: number;
  sourceSystem: CatalogSourceSystem;
  publicApproved: boolean;
  updatedAt: string;
};
export type ProductionCatalogPresentationPlan = {
  domains: PlannedCatalogDomain[];
  media: PlannedCatalogMediaAssignment[];
  blockers: IdentityMigrationBlocker[];
  checksum: string;
};

export function planProductionCatalogPresentation(
  rows: IdentitySourceRow[],
  ownership: CatalogOwnershipPlan,
  content: ProductionCatalogContentPlan,
  existing: { domains?: ExistingCatalogDomain[]; mediaObjects?: ExistingCatalogMediaObject[] } = {},
): ProductionCatalogPresentationPlan {
  const blockers = [...content.blockers];
  const domains: PlannedCatalogDomain[] = [];
  const media: PlannedCatalogMediaAssignment[] = [];
  const existingDomains = existing.domains ?? [];
  const domainsByHostname = new Map(existingDomains.map((row) => [row.hostname, row]));
  const mediaBySource = new Map(
    (existing.mediaObjects ?? []).map((row) => [mediaSourceKey(row), row]),
  );

  for (const group of ownership.properties) {
    const booking = group.booking;
    let hostname: string | undefined;
    try {
      hostname = optionalText(booking.data["custom_domain"], "custom_domain")
        ?.trim()
        .toLowerCase()
        .replace(/\.$/, "");
    } catch (error) {
      addBlocker(
        blockers,
        "INVALID_CUSTOM_DOMAIN",
        "booking.booking_hotels",
        booking.sourceId,
        error instanceof Error ? error.message : "custom_domain is malformed",
      );
    }
    if (hostname) {
      if (!validHostname(hostname))
        addBlocker(
          blockers,
          "INVALID_CUSTOM_DOMAIN",
          "booking.booking_hotels",
          booking.sourceId,
          "custom_domain is not a normalized hostname",
        );
      else {
        const current = domainsByHostname.get(hostname);
        if (current && current.propertyId !== group.propertyId)
          addBlocker(
            blockers,
            "DOMAIN_PROPERTY_CONFLICT",
            "hotel_catalog.property_domains",
            hostname,
            "Verified hostname belongs to another canonical property",
          );
        else {
          const canonical = existingDomains.find(
            (row) =>
              row.propertyId === group.propertyId &&
              row.verificationStatus === "verified" &&
              row.canonicalWhenVerified,
          );
          if (canonical && canonical.hostname !== hostname)
            addBlocker(
              blockers,
              "DOMAIN_CANONICAL_CONFLICT",
              "hotel_catalog.property_domains",
              group.propertyId,
              "Source domain conflicts with the verified target canonical domain",
            );
          else
            domains.push(
              current ?? {
                id: stableCatalogId("domain", hostname),
                propertyId: group.propertyId,
                hostname,
                verificationStatus: "pending",
                canonicalWhenVerified: false,
                verifiedAt: null,
                updatedAt: booking.updatedAt,
              },
            );
        }
      }
    }

    let references: MediaReference[] = [];
    try {
      references = mediaReferences(
        booking.data,
        booking.updatedAt,
        group.marketplace[0]?.data,
        group.marketplace[0]?.updatedAt,
      );
    } catch (error) {
      addBlocker(
        blockers,
        "INVALID_MEDIA_REFERENCE",
        "booking.booking_hotels",
        booking.sourceId,
        error instanceof Error ? error.message : "media reference is malformed",
      );
    }
    for (const reference of references) {
      const object = mediaBySource.get(mediaSourceKey(reference));
      if (!object) {
        addBlocker(
          blockers,
          "UNRESOLVED_MEDIA_REFERENCE",
          `${reference.sourceSystem}.${reference.sourceTable}`,
          reference.sourceRowId,
          "VAY-1055 has not produced a matching Platform Media object",
        );
        continue;
      }
      if (object.propertyId !== group.propertyId || object.purpose !== reference.purpose) {
        addBlocker(
          blockers,
          "MEDIA_OWNERSHIP_CONFLICT",
          "platform.media_objects",
          object.id,
          "Platform Media ownership or purpose does not match the catalog assignment",
        );
        continue;
      }
      const ready =
        object.lifecycleStatus === "external_reference" ||
        (object.lifecycleStatus === "active" &&
          (object.visibility === "private" || object.publicApproved));
      if (!ready) {
        addBlocker(
          blockers,
          "MEDIA_NOT_READY",
          "platform.media_objects",
          object.id,
          "Platform Media object is not active or safely retained as an external reference",
        );
        continue;
      }
      media.push({
        id: stableCatalogId(
          "media-assignment",
          `${group.propertyId}:${object.id}:${reference.mediaType}`,
        ),
        propertyId: group.propertyId,
        platformMediaObjectId: object.id,
        mediaType: reference.mediaType,
        sortOrder: reference.sortOrder,
        sourceSystem: reference.sourceSystem,
        publicApproved:
          object.visibility === "public" &&
          object.lifecycleStatus === "active" &&
          object.publicApproved,
        updatedAt: reference.updatedAt,
      });
    }
  }
  addDuplicateDomains(domains, blockers);
  const result = {
    domains: sortedBy(domains, (row) => row.hostname),
    media: sortedBy(media, (row) => `${row.propertyId}:${row.mediaType}:${row.sortOrder}`),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
  return { ...result, checksum: createHash("sha256").update(stableJson(result)).digest("hex") };
}

type MediaReference = {
  sourceSystem: "booking" | "marketplace";
  sourceTable: "booking_hotels" | "hotel_profiles";
  sourceRowId: string;
  purpose: ExistingCatalogMediaObject["purpose"];
  mediaType: PlannedCatalogMediaAssignment["mediaType"];
  sortOrder: number;
  updatedAt: string;
};
function mediaReferences(
  booking: Record<string, unknown>,
  bookingUpdatedAt: string,
  marketplace: Record<string, unknown> | undefined,
  marketplaceUpdatedAt: string | undefined,
): MediaReference[] {
  const bookingId = String(booking["id"]);
  const result: MediaReference[] = [];
  if (optionalText(booking["hero_image"], "hero_image"))
    result.push({
      sourceSystem: "booking",
      sourceTable: "booking_hotels",
      sourceRowId: `${bookingId}:hero_image`,
      purpose: "property.hero_image",
      mediaType: "hero_image",
      sortOrder: 0,
      updatedAt: bookingUpdatedAt,
    });
  const images = booking["images"];
  if (images != null && (!Array.isArray(images) || images.some((url) => typeof url !== "string")))
    throw new Error("booking_hotels.images must be a string array");
  for (const [index, url] of ((images ?? []) as string[]).entries())
    if (url.trim())
      result.push({
        sourceSystem: "booking",
        sourceTable: "booking_hotels",
        sourceRowId: `${bookingId}:images:${index + 1}`,
        purpose: "property.gallery_image",
        mediaType: "gallery_image",
        sortOrder: index,
        updatedAt: bookingUpdatedAt,
      });
  if (optionalText(booking["branding_logo_url"], "branding_logo_url"))
    result.push({
      sourceSystem: "booking",
      sourceTable: "booking_hotels",
      sourceRowId: `${bookingId}:branding_logo_url`,
      purpose: "property.logo",
      mediaType: "logo",
      sortOrder: 0,
      updatedAt: bookingUpdatedAt,
    });
  if (marketplace && optionalText(marketplace["picture"], "picture")) {
    const profileId = String(marketplace["id"]);
    result.push({
      sourceSystem: "marketplace",
      sourceTable: "hotel_profiles",
      sourceRowId: `${profileId}:picture`,
      purpose: "property.logo",
      mediaType: "logo",
      sortOrder: 1,
      updatedAt: marketplaceUpdatedAt!,
    });
  }
  return result;
}
function mediaSourceKey(value: {
  sourceSystem: string;
  sourceTable: string;
  sourceRowId: string;
}): string {
  return `${value.sourceSystem}:${value.sourceTable}:${value.sourceRowId}`;
}
function validHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    value.split(".").length > 1 &&
    value.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))
  );
}
function addDuplicateDomains(
  rows: PlannedCatalogDomain[],
  blockers: IdentityMigrationBlocker[],
): void {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows)
    grouped.set(row.hostname, new Set([...(grouped.get(row.hostname) ?? []), row.propertyId]));
  for (const [hostname, properties] of grouped)
    if (properties.size > 1)
      addBlocker(
        blockers,
        "DUPLICATE_CATALOG_DOMAIN",
        "hotel_catalog.property_domains",
        hostname,
        "Hostname resolves to multiple canonical properties",
      );
}
