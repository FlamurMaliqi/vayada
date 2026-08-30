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
import type { ProductionCatalogCorePlan } from "./productionCatalogCorePlan.js";
import type { CatalogOwnershipPlan, CatalogSourceSystem } from "./productionCatalogOwnership.js";

export type PlannedCatalogProfile = {
  propertyId: string;
  locale: string;
  shortDescription: string | null;
  longDescription: string | null;
  sourceConfidence: "high" | "medium" | "low";
  updatedAt: string;
};
export type PlannedCatalogAmenity = {
  propertyId: string;
  amenityKey: string;
  label: string;
  sourceSystem: CatalogSourceSystem;
  publicSafe: false;
  updatedAt: string;
};
export type PlannedCatalogContact = {
  propertyId: string;
  channelType:
    | "phone"
    | "email"
    | "whatsapp"
    | "website"
    | "instagram"
    | "facebook"
    | "tiktok"
    | "youtube";
  value: string;
  purpose: "general";
  isPublic: false;
  sourceSystem: "booking" | "marketplace";
  updatedAt: string;
};
export type PlannedCatalogPolicy = {
  propertyId: string;
  checkInTime: string | null;
  checkOutTime: string | null;
  cancellationSummary: string | null;
  paymentPolicySummary: string | null;
  updatedAt: string;
};
export type ProductionCatalogContentPlan = {
  profiles: PlannedCatalogProfile[];
  amenities: PlannedCatalogAmenity[];
  contacts: PlannedCatalogContact[];
  policies: PlannedCatalogPolicy[];
  blockers: IdentityMigrationBlocker[];
  checksum: string;
};

export function planProductionCatalogContent(
  rows: IdentitySourceRow[],
  ownership: CatalogOwnershipPlan,
  core: ProductionCatalogCorePlan,
): ProductionCatalogContentPlan {
  const blockers = [...core.blockers];
  const profiles = new Map<string, PlannedCatalogProfile>();
  const amenities = new Map<string, PlannedCatalogAmenity>();
  const contacts = new Map<string, PlannedCatalogContact>();
  const policies: PlannedCatalogPolicy[] = [];

  for (const group of ownership.properties) {
    const booking = group.booking;
    const marketplace = group.marketplace[0];
    try {
      const defaultLocale = text(
        booking.data["default_language"] ?? "en",
        "default_language",
      ).toLowerCase();
      const bookingDescription = optionalText(booking.data["description"], "description");
      const marketplaceDescription = optionalText(marketplace?.data["about"], "about");
      if (bookingDescription || marketplaceDescription)
        profiles.set(`${group.propertyId}:${defaultLocale}`, {
          propertyId: group.propertyId,
          locale: defaultLocale,
          shortDescription: null,
          longDescription: bookingDescription ?? marketplaceDescription,
          sourceConfidence: bookingDescription
            ? "high"
            : marketplace?.status === "verified"
              ? "medium"
              : "low",
          updatedAt: bookingDescription ? booking.updatedAt : marketplace!.updatedAt,
        });

      addAmenities(
        amenities,
        group.propertyId,
        booking.data["amenities"],
        "booking",
        booking.updatedAt,
        blockers,
      );
      if (group.pms[0])
        addAmenities(
          amenities,
          group.propertyId,
          group.pms[0]!.data["benefits"],
          "pms",
          group.pms[0]!.updatedAt,
          blockers,
        );
      addContacts(contacts, group.propertyId, booking.data, "booking", booking.updatedAt);
      if (marketplace)
        addContacts(
          contacts,
          group.propertyId,
          marketplace.data,
          "marketplace",
          marketplace.updatedAt,
        );
      policies.push({
        propertyId: group.propertyId,
        checkInTime: time(
          booking.data["check_in_time"],
          "check_in_time",
          blockers,
          booking.sourceId,
        ),
        checkOutTime: time(
          booking.data["check_out_time"],
          "check_out_time",
          blockers,
          booking.sourceId,
        ),
        cancellationSummary: optionalText(
          booking.data["cancellation_policy_text"],
          "cancellation_policy_text",
        ),
        paymentPolicySummary: optionalText(booking.data["terms_text"], "terms_text"),
        updatedAt: booking.updatedAt,
      });
    } catch (error) {
      addBlocker(
        blockers,
        "INVALID_CATALOG_CONTENT",
        "booking.booking_hotels",
        booking.sourceId,
        error instanceof Error ? error.message : "Invalid catalog content",
      );
    }
  }

  for (const row of rows.filter(
    (item) =>
      item.sourceDatabase === "booking" && item.sourceTable === "booking_hotel_translations",
  )) {
    try {
      const propertyId = uuid(row.data["hotel_id"], "hotel_id");
      if (!ownership.properties.some((group) => group.propertyId === propertyId)) continue;
      const locale = text(row.data["locale"], "locale").toLowerCase();
      const description = optionalText(row.data["description"], "description");
      if (description)
        profiles.set(`${propertyId}:${locale}`, {
          propertyId,
          locale,
          shortDescription: null,
          longDescription: description,
          sourceConfidence: "high",
          updatedAt: ownership.properties.find((group) => group.propertyId === propertyId)!.booking
            .updatedAt,
        });
      const translatedAmenities = row.data["amenities"];
      if (translatedAmenities)
        addAmenities(
          amenities,
          propertyId,
          translatedAmenities,
          "booking",
          ownership.properties.find((group) => group.propertyId === propertyId)!.booking.updatedAt,
          blockers,
        );
    } catch (error) {
      addBlocker(
        blockers,
        "INVALID_CATALOG_TRANSLATION_CONTENT",
        "booking.booking_hotel_translations",
        `row:${row.rowOrdinal}`,
        error instanceof Error ? error.message : "Invalid translation content",
      );
    }
  }
  const content = {
    profiles: sortedBy([...profiles.values()], (row) => `${row.propertyId}:${row.locale}`),
    amenities: sortedBy([...amenities.values()], (row) => `${row.propertyId}:${row.amenityKey}`),
    contacts: sortedBy(
      [...contacts.values()],
      (row) => `${row.propertyId}:${row.channelType}:${row.value}`,
    ),
    policies: sortedBy(policies, (row) => row.propertyId),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
  return { ...content, checksum: createHash("sha256").update(stableJson(content)).digest("hex") };
}

function addAmenities(
  target: Map<string, PlannedCatalogAmenity>,
  propertyId: string,
  value: unknown,
  sourceSystem: "booking" | "pms",
  updatedAt: string,
  blockers: IdentityMigrationBlocker[],
): void {
  if (value == null) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    addBlocker(
      blockers,
      "INVALID_CATALOG_AMENITIES",
      `${sourceSystem}.${sourceSystem === "booking" ? "booking_hotels" : "hotels"}`,
      propertyId,
      "Amenities must be a string array",
    );
    return;
  }
  for (const label of value) {
    const amenityKey = label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    if (!amenityKey) continue;
    const key = `${propertyId}:${amenityKey}`;
    if (!target.has(key))
      target.set(key, {
        propertyId,
        amenityKey,
        label: label.trim(),
        sourceSystem,
        publicSafe: false,
        updatedAt,
      });
  }
}

function addContacts(
  target: Map<string, PlannedCatalogContact>,
  propertyId: string,
  data: Record<string, unknown>,
  sourceSystem: "booking" | "marketplace",
  updatedAt: string,
): void {
  const fields =
    sourceSystem === "booking"
      ? ({
          phone: "contact_phone",
          email: "contact_email",
          whatsapp: "contact_whatsapp",
          instagram: "social_instagram",
          facebook: "social_facebook",
          tiktok: "social_tiktok",
          youtube: "social_youtube",
        } as const)
      : ({ phone: "phone", website: "website" } as const);
  for (const [channelType, field] of Object.entries(fields) as Array<
    [PlannedCatalogContact["channelType"], string]
  >) {
    const value = optionalText(data[field], field)?.trim();
    if (!value) continue;
    target.set(`${propertyId}:${channelType}:${value}`, {
      propertyId,
      channelType,
      value,
      purpose: "general",
      isPublic: false,
      sourceSystem,
      updatedAt,
    });
  }
}

function time(
  value: unknown,
  field: string,
  blockers: IdentityMigrationBlocker[],
  sourceId: string,
): string | null {
  const result = optionalText(value, field);
  if (!result) return null;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result)) return result;
  addBlocker(
    blockers,
    "INVALID_CATALOG_POLICY_TIME",
    "booking.booking_hotels",
    sourceId,
    `${field} must be HH:MM`,
  );
  return null;
}
