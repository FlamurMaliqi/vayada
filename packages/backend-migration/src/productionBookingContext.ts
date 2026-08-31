import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import type {
  BookingBuildContext,
  BookingMediaReference,
  BookingPropertyLink,
  BookingPropertySlug,
  ProductionBookingTargetState,
} from "./productionBookingTypes.js";
import { optionalText, requiredText, sourceId } from "./productionBookingValues.js";

export function createProductionBookingContext(input: {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionBookingTargetState;
}): BookingBuildContext {
  const blockers: IdentityMigrationBlocker[] = [...(input.target.blockers ?? [])];
  const propertyBySource = propertySourceMap(input.target.propertyLinks, blockers);
  const propertyBySlug = propertySlugMap(input.target.propertySlugs, blockers);
  const bookings = input.rows.filter(
    (row) => row.sourceDatabase === "pms" && row.sourceTable === "bookings",
  );
  const addons = input.rows.filter(
    (row) => row.sourceDatabase === "booking" && row.sourceTable === "booking_addons",
  );
  const promos = input.rows.filter(
    (row) => row.sourceDatabase === "booking" && row.sourceTable === "booking_promo_codes",
  );
  const bookingById = uniqueMap(bookings, "id", "DUPLICATE_BOOKING_ID", blockers);
  const bookingByReference = uniqueMap(
    bookings,
    "booking_reference",
    "DUPLICATE_BOOKING_REFERENCE",
    blockers,
  );
  const addonById = uniqueMap(addons, "id", "DUPLICATE_ADDON_ID", blockers);
  const promoById = uniqueMap(promos, "id", "DUPLICATE_PROMO_ID", blockers);
  const mediaBySource = new Map(
    (input.target.media ?? []).map((media) => [`${media.sourceTable}:${media.sourceRowId}`, media]),
  );

  validateRequiredProperties(input.rows, propertyBySource, propertyBySlug, blockers);
  validateUnsupportedSensitiveFields(input.rows, blockers);
  return {
    ...input,
    blockers,
    propertyBySource,
    propertyBySlug,
    bookingById,
    bookingByReference,
    addonById,
    promoById,
    mediaBySource,
  };
}

export function bookingAddonMediaFor(
  context: BookingBuildContext,
  source: IdentitySourceRow,
  propertyId: string,
): { mediaObjectId: string; publicUrl: string } | null {
  const sourceUrl = optionalText(source.data["image"], "image");
  if (!sourceUrl) return null;
  const id = requiredText(source.data["id"], "id").toLowerCase();
  const media = context.mediaBySource.get(`booking_addons:${id}:image`);
  if (
    !media ||
    media.sourceUrl !== sourceUrl ||
    media.propertyId !== propertyId ||
    media.purpose !== "booking.addon.image" ||
    media.migrationRunId !== context.sourceRunId ||
    !isApprovedBookingMedia(media)
  )
    throw new Error("add-on image has no approved active VAY-1055 CDN media object");
  return { mediaObjectId: media.mediaObjectId, publicUrl: media.publicUrl };
}

export function bookingHeaderLogoMediaFor(
  context: BookingBuildContext,
  source: IdentitySourceRow,
  propertyId: string,
): string | null {
  const sourceUrl = optionalText(source.data["branding_logo_url"], "branding_logo_url");
  if (!sourceUrl) return null;
  const id = requiredText(source.data["id"], "id").toLowerCase();
  const media = context.mediaBySource.get(`booking_hotels:${id}:branding_logo_url:booking_header`);
  if (
    !media ||
    media.sourceUrl !== sourceUrl ||
    media.propertyId !== propertyId ||
    media.purpose !== "booking.header_logo" ||
    media.migrationRunId !== context.sourceRunId ||
    !isApprovedBookingMedia(media)
  )
    throw new Error("Booking logo has no approved active VAY-1055 CDN media object");
  return media.mediaObjectId;
}

export function bookingHeroMediaFor(
  context: BookingBuildContext,
  source: IdentitySourceRow,
  propertyId: string,
): string | null {
  const sourceUrl = optionalText(source.data["hero_image"], "hero_image");
  if (!sourceUrl) return null;
  const id = requiredText(source.data["id"], "id").toLowerCase();
  const media = context.mediaBySource.get(`booking_hotels:${id}:hero_image`);
  if (
    !media ||
    media.sourceUrl !== sourceUrl ||
    media.propertyId !== propertyId ||
    media.purpose !== "property.hero_image" ||
    media.migrationRunId !== context.sourceRunId ||
    !isApprovedBookingMedia(media)
  )
    throw new Error("Booking hero has no approved active VAY-1055 CDN media object");
  return media.publicUrl;
}

function isApprovedBookingMedia(media: BookingMediaReference): media is BookingMediaReference & {
  publicUrl: string;
  variantStorageKey: string;
} {
  if (
    media.visibility !== "public" ||
    media.lifecycleStatus !== "active" ||
    !media.publicApproved ||
    !media.publicUrl ||
    !media.bucket.trim() ||
    media.storageKind !== "vayada_managed" ||
    !media.variantStorageKey
  )
    return false;
  const prefix = `public/media/${media.mediaObjectId}/original_safe/`;
  if (
    !media.storageKey.startsWith(prefix) ||
    !media.variantStorageKey.startsWith(prefix) ||
    media.storageKey !== media.variantStorageKey
  )
    return false;
  try {
    const url = new URL(media.publicUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/(^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(url.hostname) &&
      url.pathname === `/${media.variantStorageKey.slice("public/".length)}`
    );
  } catch {
    return false;
  }
}

export function propertyFor(
  context: BookingBuildContext,
  system: "booking" | "pms",
  table: "booking_hotels" | "hotels",
  sourceValue: unknown,
): string {
  const id = requiredText(sourceValue, `${table}.id`).toLowerCase();
  const propertyId = context.propertyBySource.get(`${system}:${table}:${id}`);
  if (!propertyId)
    throw new Error(`no active canonical property link for ${system}.${table} ${id}`);
  return propertyId;
}

export function addBookingBlocker(
  blockers: IdentityMigrationBlocker[],
  code: string,
  source: string,
  id: string,
  message: string,
): void {
  blockers.push({ code, source, sourceId: id, message });
}

function propertySourceMap(
  links: BookingPropertyLink[],
  blockers: IdentityMigrationBlocker[],
): Map<string, string> {
  const grouped = new Map<string, Set<string>>();
  for (const link of links) {
    const expectedRelationship =
      link.sourceSystem === "booking"
        ? "canonical_input"
        : link.sourceSystem === "pms"
          ? "operational_input"
          : null;
    if (link.status !== "active" || link.relationship !== expectedRelationship) continue;
    const key = `${link.sourceSystem}:${link.sourceTable}:${link.sourceId.toLowerCase()}`;
    grouped.set(key, new Set([...(grouped.get(key) ?? []), link.propertyId]));
  }
  const result = new Map<string, string>();
  for (const [key, propertyIds] of grouped) {
    if (propertyIds.size === 1) result.set(key, [...propertyIds][0]!);
    else
      addBookingBlocker(
        blockers,
        "AMBIGUOUS_PROPERTY_SOURCE_LINK",
        "hotel_catalog.property_source_links",
        key,
        "Source row resolves to more than one target property",
      );
  }
  return result;
}

function propertySlugMap(
  slugs: BookingPropertySlug[],
  blockers: IdentityMigrationBlocker[],
): Map<string, string> {
  const grouped = new Map<string, Set<string>>();
  for (const slug of slugs) {
    if (slug.status !== "active") continue;
    const key = slug.slug.trim().toLowerCase();
    grouped.set(key, new Set([...(grouped.get(key) ?? []), slug.propertyId]));
  }
  const result = new Map<string, string>();
  for (const [slug, propertyIds] of grouped) {
    if (propertyIds.size === 1) result.set(slug, [...propertyIds][0]!);
    else
      addBookingBlocker(
        blockers,
        "AMBIGUOUS_PROPERTY_SLUG",
        "hotel_catalog.property_slugs",
        slug,
        "Legacy Booking event slug resolves to more than one target property",
      );
  }
  return result;
}

function uniqueMap(
  rows: IdentitySourceRow[],
  field: string,
  code: string,
  blockers: IdentityMigrationBlocker[],
): Map<string, IdentitySourceRow> {
  const result = new Map<string, IdentitySourceRow>();
  for (const row of rows) {
    try {
      const id = requiredText(row.data[field], field).toLowerCase();
      if (result.has(id))
        addBookingBlocker(
          blockers,
          code,
          `${row.sourceDatabase}.${row.sourceTable}`,
          id,
          `${field} is duplicated`,
        );
      else result.set(id, row);
    } catch (error) {
      addBookingBlocker(
        blockers,
        "INVALID_SOURCE_ROW",
        `${row.sourceDatabase}.${row.sourceTable}`,
        String(row.rowOrdinal),
        error instanceof Error ? error.message : "Invalid source identifier",
      );
    }
  }
  return result;
}

function validateRequiredProperties(
  rows: IdentitySourceRow[],
  bySource: Map<string, string>,
  bySlug: Map<string, string>,
  blockers: IdentityMigrationBlocker[],
): void {
  for (const row of rows) {
    let key: string | null = null;
    if (row.sourceDatabase === "booking" && row.sourceTable === "booking_hotels")
      key = `booking:booking_hotels:${String(row.data["id"] ?? "").toLowerCase()}`;
    else if (
      row.sourceDatabase === "booking" &&
      ["booking_addons", "booking_promo_codes"].includes(row.sourceTable)
    )
      key = `booking:booking_hotels:${String(row.data["hotel_id"] ?? "").toLowerCase()}`;
    else if (
      row.sourceDatabase === "pms" &&
      ["bookings", "booking_drafts"].includes(row.sourceTable)
    )
      key = `pms:hotels:${String(row.data["hotel_id"] ?? "").toLowerCase()}`;
    if (key && !bySource.has(key))
      addBookingBlocker(
        blockers,
        "UNRESOLVED_PROPERTY",
        `${row.sourceDatabase}.${row.sourceTable}`,
        safeId(row),
        `No active catalog source link for ${key}`,
      );
    if (row.sourceDatabase === "booking" && row.sourceTable === "booking_events") {
      const slug = String(row.data["hotel_slug"] ?? "")
        .trim()
        .toLowerCase();
      if (!slug || !bySlug.has(slug))
        addBookingBlocker(
          blockers,
          "UNRESOLVED_EVENT_PROPERTY",
          "booking.booking_events",
          safeId(row),
          "Event hotel_slug has no unique active target property",
        );
    }
  }
}

function validateUnsupportedSensitiveFields(
  rows: IdentitySourceRow[],
  blockers: IdentityMigrationBlocker[],
): void {
  for (const row of rows.filter((item) => item.sourceTable === "booking_additional_guests")) {
    const unsupported = ["gender", "date_of_birth", "passport_number", "room_position"].filter(
      (field) =>
        row.data[field] !== null && row.data[field] !== undefined && row.data[field] !== "",
    );
    if (unsupported.length)
      addBookingBlocker(
        blockers,
        "UNSUPPORTED_SENSITIVE_GUEST_FIELDS",
        "pms.booking_additional_guests",
        safeId(row),
        `Encrypted target contract required for: ${unsupported.join(", ")}`,
      );
  }
}

function safeId(row: IdentitySourceRow): string {
  try {
    return sourceId(
      row,
      row.sourceTable === "booking_promo_usage_state" ? "booking_reference" : "id",
    );
  } catch {
    return String(row.rowOrdinal);
  }
}
