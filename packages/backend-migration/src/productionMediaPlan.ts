import { createHash } from "node:crypto";

import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import {
  deterministicUuid,
  iso,
  optionalText,
  requiredText,
  stableJson,
  uuid,
} from "./productionBookingValues.js";

export type ProductionMediaPurpose =
  | "booking.header_logo"
  | "booking.addon.image"
  | "property.hero_image"
  | "property.gallery_image"
  | "property.logo"
  | "marketplace.offer.media"
  | "marketplace.creator.profile_image"
  | "marketplace.collaboration_chat.attachment"
  | "pms.room_type.media"
  | "pms.messaging.attachment";

export type ProductionMediaReference = {
  mediaObjectId: string;
  sourceSystem: "booking" | "marketplace" | "pms";
  sourceTable: string;
  sourceRowId: string;
  sourceField: string;
  sourceUrl: string;
  sourceUpdatedAt: string;
  sourceReferenceSha256: string;
  purpose: ProductionMediaPurpose;
  visibility: "public" | "private";
  publicApproved: boolean;
  propertyId: string | null;
  ownerOrganizationId: string;
  resourceProduct: "booking" | "hotel_catalog" | "marketplace" | "pms";
  resourceType: string;
  resourceId: string;
  sortOrder: number;
  originalFilename: string;
  retainedUntil: string | null;
};

export type ProductionMediaQuarantine = {
  sourceSystem: "booking" | "marketplace" | "pms";
  sourceTable: string;
  sourceRowId: string;
  sourceField: string;
  sourceValueSha256: string;
  purpose: ProductionMediaPurpose;
  reasonCode: "INVALID_HTTPS_URL" | "INVALID_STRING_ARRAY";
};

export type ExistingProductionMediaObject = {
  id: string;
  sourceSystem: string;
  sourceTable: string;
  sourceRowId: string;
  sourceUrl: string;
  purpose: string;
  lifecycleStatus: string;
  visibility: string;
  publicApproved: boolean;
  migrationRunId: string | null;
  checksumSha256: string;
  bucket: string;
  storageKind: string;
  storageKey: string;
  propertyId: string | null;
  ownerOrganizationId: string;
  resourceProduct: string;
  resourceType: string;
  resourceId: string;
  retainedUntil: string | null;
  migrationCase: string | null;
  variants: Array<{
    name: string;
    visibility: string;
    storageKey: string;
    publicCdnUrl: string | null;
  }>;
};

export type ProductionMediaTargetState = {
  propertyLinks: Array<{
    sourceSystem: string;
    sourceTable: string;
    sourceId: string;
    propertyId: string;
    relationship: string;
    status: string;
    migrationRunId: string | null;
    migrationDisposition?: "canonical" | "private_quarantine" | null;
  }>;
  resourceLinks: Array<{
    organizationId: string;
    product: string;
    resourceType: string;
    resourceId: string;
    relationship: string;
    status: string;
  }>;
  mediaObjects: ExistingProductionMediaObject[];
};

export type ProductionMediaPlan = {
  sourceRunId: string;
  inventoryChecksumSha256: string;
  checksum: string;
  references: ProductionMediaReference[];
  pending: ProductionMediaReference[];
  reused: ProductionMediaReference[];
  quarantines: ProductionMediaQuarantine[];
  blockers: IdentityMigrationBlocker[];
  counts: {
    planned: number;
    pending: number;
    reused: number;
    quarantined: number;
    public: number;
    private: number;
  };
};

export function buildProductionMediaPlan(input: {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionMediaTargetState;
  legacyPmsBucket: string;
  targetBucket: string;
  cdnBaseUrl: string;
}): ProductionMediaPlan {
  const blockers: IdentityMigrationBlocker[] = [];
  const quarantines: ProductionMediaQuarantine[] = [];
  const context = createContext(input, blockers, quarantines);
  const references: ProductionMediaReference[] = [];

  for (const row of input.rows) {
    try {
      if (row.sourceDatabase === "booking" && row.sourceTable === "booking_hotels")
        references.push(...bookingHotel(context, row));
      else if (row.sourceDatabase === "booking" && row.sourceTable === "booking_addons")
        references.push(...bookingAddon(context, row));
      else if (row.sourceDatabase === "marketplace" && row.sourceTable === "hotel_profiles")
        references.push(...marketplaceHotel(context, row));
      else if (row.sourceDatabase === "marketplace" && row.sourceTable === "hotel_listings")
        references.push(...marketplaceListing(context, row));
      else if (row.sourceDatabase === "marketplace" && row.sourceTable === "creators")
        references.push(...marketplaceCreator(context, row));
      else if (row.sourceDatabase === "marketplace" && row.sourceTable === "chat_messages")
        references.push(...marketplaceChat(context, row));
      else if (row.sourceDatabase === "pms" && row.sourceTable === "room_types")
        references.push(...pmsRoomType(context, row));
      else if (row.sourceDatabase === "pms" && row.sourceTable === "message_attachments")
        references.push(...pmsAttachment(context, row));
    } catch (error) {
      block(
        blockers,
        "INVALID_MEDIA_SOURCE_ROW",
        `${row.sourceDatabase}.${row.sourceTable}`,
        safeId(row),
        error instanceof Error ? error.message : "Media source row is invalid",
      );
    }
  }

  const ordered = references.sort((left, right) => mediaKey(left).localeCompare(mediaKey(right)));
  const seen = new Set<string>();
  for (const reference of ordered) {
    const key = mediaKey(reference);
    if (seen.has(key))
      block(
        blockers,
        "DUPLICATE_MEDIA_REFERENCE",
        `${reference.sourceSystem}.${reference.sourceTable}`,
        reference.sourceRowId,
        "More than one source value owns this media identity",
      );
    seen.add(key);
  }

  const current = new Map(input.target.mediaObjects.map((row) => [mediaKey(row), row]));
  const pending: ProductionMediaReference[] = [];
  const reused: ProductionMediaReference[] = [];
  for (const reference of ordered) {
    const existing = current.get(mediaKey(reference));
    if (!existing) {
      pending.push(reference);
      continue;
    }
    const expectedVariants =
      reference.visibility === "public"
        ? ["blur_preview", "large", "original_safe", "thumbnail"]
        : ["provider_original"];
    const cdnBaseUrl = normalizedCdnBaseUrl(input.cdnBaseUrl);
    const originalVariant =
      reference.visibility === "public" ? "original_safe" : "provider_original";
    const mediaStoragePrefix = `${reference.visibility}/media/${reference.mediaObjectId}/${originalVariant}/`;
    const ready =
      existing.id === reference.mediaObjectId &&
      existing.sourceUrl === reference.sourceUrl &&
      existing.visibility === reference.visibility &&
      existing.lifecycleStatus === "active" &&
      existing.publicApproved === reference.publicApproved &&
      existing.migrationRunId === input.sourceRunId &&
      /^[0-9a-f]{64}$/.test(existing.checksumSha256) &&
      existing.bucket === input.targetBucket &&
      existing.storageKind === "vayada_managed" &&
      existing.storageKey.startsWith(mediaStoragePrefix) &&
      existing.propertyId === reference.propertyId &&
      existing.ownerOrganizationId === reference.ownerOrganizationId &&
      existing.resourceProduct === reference.resourceProduct &&
      existing.resourceType === reference.resourceType &&
      existing.resourceId === reference.resourceId &&
      existing.retainedUntil === reference.retainedUntil &&
      existing.migrationCase ===
        (reference.purpose === "marketplace.collaboration_chat.attachment"
          ? "media-url-migration"
          : null) &&
      expectedVariants.every((name) =>
        existing.variants.some(
          (variant) =>
            variant.name === name &&
            variant.visibility === reference.visibility &&
            variant.storageKey.startsWith(
              `${reference.visibility}/media/${reference.mediaObjectId}/${name}/`,
            ) &&
            (reference.visibility === "private"
              ? variant.publicCdnUrl === null
              : variant.publicCdnUrl !== null &&
                publicCdnUrlMatchesStorageKey(
                  variant.publicCdnUrl,
                  variant.storageKey,
                  cdnBaseUrl,
                )),
        ),
      );
    if (ready) reused.push(reference);
    else
      block(
        blockers,
        "MEDIA_TARGET_CONFLICT",
        "platform.media_objects",
        existing.id,
        "Existing media identity differs from this immutable source run; target state was preserved",
      );
  }

  const orderedQuarantines = quarantines.sort((left, right) =>
    quarantineKey(left).localeCompare(quarantineKey(right)),
  );
  const inventoryChecksumSha256 = sha256({ references: ordered, quarantines: orderedQuarantines });
  const material = {
    sourceRunId: input.sourceRunId,
    inventoryChecksumSha256,
    references: ordered,
    quarantines: orderedQuarantines,
    blockers: sortedBlockers(blockers),
  };
  return {
    ...material,
    checksum: sha256(material),
    pending,
    reused,
    counts: {
      planned: ordered.length,
      pending: pending.length,
      reused: reused.length,
      quarantined: orderedQuarantines.length,
      public: ordered.filter((row) => row.visibility === "public").length,
      private: ordered.filter((row) => row.visibility === "private").length,
    },
  };
}

type Context = ReturnType<typeof createContext>;
type MediaOwnerScope = {
  organizationId: string;
  ownerStatus: "active" | "suspended" | "archived";
};

function createContext(
  input: {
    sourceRunId: string;
    completedAt: string;
    rows: IdentitySourceRow[];
    target: ProductionMediaTargetState;
    legacyPmsBucket: string;
    targetBucket: string;
    cdnBaseUrl: string;
  },
  blockers: IdentityMigrationBlocker[],
  quarantines: ProductionMediaQuarantine[],
) {
  const property = uniqueMap(
    input.target.propertyLinks.filter(
      (row) => row.status === "active" && row.migrationRunId === input.sourceRunId,
    ),
    (row) => `${row.sourceSystem}:${row.sourceTable}:${row.sourceId.toLowerCase()}`,
    (row) => row.propertyId,
    blockers,
    "AMBIGUOUS_MEDIA_PROPERTY",
  );
  const privateProperties = new Set(
    input.target.propertyLinks
      .filter(
        (row) =>
          row.status === "active" &&
          row.migrationRunId === input.sourceRunId &&
          row.migrationDisposition === "private_quarantine",
      )
      .map((row) => `${row.sourceSystem}:${row.sourceTable}:${row.sourceId.toLowerCase()}`),
  );
  const organization = uniqueOwnerMap(
    input.target.resourceLinks.filter(
      (row) => row.status === "active" || row.status === "suspended" || row.status === "archived",
    ),
    (row) =>
      `${row.product}:${row.resourceType}:${row.resourceId.toLowerCase()}:${row.relationship}`,
    blockers,
  );
  const byTable = new Map<string, IdentitySourceRow[]>();
  for (const row of input.rows)
    byTable.set(row.sourceTable, [...(byTable.get(row.sourceTable) ?? []), row]);
  return {
    ...input,
    blockers,
    quarantines,
    property,
    privateProperties,
    organization,
    byTable,
  };
}

function bookingHotel(context: Context, row: IdentitySourceRow): ProductionMediaReference[] {
  const id = uuid(row.data["id"], "id");
  const scope = hotelScope(
    context,
    "booking",
    "booking_hotels",
    id,
    "booking",
    "booking_hotel",
    "owner",
  );
  const updatedAt = timestamp(row);
  const result: ProductionMediaReference[] = [];
  appendUrl(result, context, row, scope, {
    value: row.data["hero_image"],
    field: "hero_image",
    rowId: `${id}:hero_image`,
    purpose: "property.hero_image",
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: scope.propertyId,
    sortOrder: 0,
  });
  for (
    const [index, value] of mediaStrings(context, row, row.data["images"], {
      field: "images",
      rowId: `${id}:images`,
      purpose: "property.gallery_image",
    }).entries()
  )
    appendUrl(result, context, row, scope, {
      value,
      field: `images[${index}]`,
      rowId: `${id}:images:${index + 1}`,
      purpose: "property.gallery_image",
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: scope.propertyId,
      sortOrder: index,
    });
  appendUrl(result, context, row, scope, {
    value: row.data["branding_logo_url"],
    field: "branding_logo_url",
    rowId: `${id}:branding_logo_url`,
    purpose: "property.logo",
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: scope.propertyId,
    sortOrder: 0,
  });
  appendUrl(result, context, row, scope, {
    value: row.data["branding_logo_url"],
    field: "branding_logo_url",
    rowId: `${id}:branding_logo_url:booking_header`,
    purpose: "booking.header_logo",
    product: "booking",
    resourceType: "booking_hotel",
    resourceId: id,
    sortOrder: 0,
  });
  return result.map((reference) => ({ ...reference, sourceUpdatedAt: updatedAt }));
}

function bookingAddon(context: Context, row: IdentitySourceRow): ProductionMediaReference[] {
  const id = uuid(row.data["id"], "id");
  const hotelId = uuid(row.data["hotel_id"], "hotel_id");
  const scope = hotelScope(
    context,
    "booking",
    "booking_hotels",
    hotelId,
    "booking",
    "booking_hotel",
    "owner",
  );
  const result: ProductionMediaReference[] = [];
  appendUrl(result, context, row, scope, {
    value: row.data["image"],
    field: "image",
    rowId: `${id}:image`,
    purpose: "booking.addon.image",
    product: "booking",
    resourceType: "addon",
    resourceId: id,
    sortOrder: 0,
  });
  return result;
}

function marketplaceHotel(context: Context, row: IdentitySourceRow): ProductionMediaReference[] {
  const id = uuid(row.data["id"], "id");
  const scope = hotelScope(
    context,
    "marketplace",
    "hotel_profiles",
    id,
    "marketplace",
    "hotel_profile",
    "owner",
  );
  const result: ProductionMediaReference[] = [];
  appendUrl(result, context, row, scope, {
    value: row.data["picture"],
    field: "picture",
    rowId: `${id}:picture`,
    purpose: "property.logo",
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: scope.propertyId,
    sortOrder: 1,
  });
  return result;
}

function marketplaceListing(context: Context, row: IdentitySourceRow): ProductionMediaReference[] {
  const id = uuid(row.data["id"], "id");
  const hotelId = uuid(row.data["hotel_profile_id"], "hotel_profile_id");
  const scope = hotelScope(
    context,
    "marketplace",
    "hotel_profiles",
    hotelId,
    "marketplace",
    "hotel_profile",
    "owner",
  );
  const result: ProductionMediaReference[] = [];
  for (
    const [index, value] of mediaStrings(context, row, row.data["images"], {
      field: "images",
      rowId: `${id}:images`,
      purpose: "marketplace.offer.media",
    }).entries()
  )
    appendUrl(result, context, row, scope, {
      value,
      field: `images[${index}]`,
      rowId: `${id}:images:${index + 1}`,
      purpose: "marketplace.offer.media",
      product: "marketplace",
      resourceType: "marketplace_offer",
      resourceId: id,
      sortOrder: index,
    });
  return result;
}

function marketplaceCreator(context: Context, row: IdentitySourceRow): ProductionMediaReference[] {
  const id = uuid(row.data["id"], "id");
  const ownerScope = owner(context, "marketplace", "creator_profile", id, "owner");
  const result: ProductionMediaReference[] = [];
  appendUrl(
    result,
    context,
    row,
    { propertyId: null, ...ownerScope },
    {
      value: row.data["profile_picture"],
      field: "profile_picture",
      rowId: `${id}:profile_picture`,
      purpose: "marketplace.creator.profile_image",
      product: "marketplace",
      resourceType: "creator_profile",
      resourceId: id,
      sortOrder: 0,
    },
  );
  return result;
}

function marketplaceChat(context: Context, row: IdentitySourceRow): ProductionMediaReference[] {
  if (String(row.data["message_type"] ?? "").toLowerCase() !== "image") return [];
  const id = uuid(row.data["id"], "id");
  const collaborationId = uuid(row.data["collaboration_id"], "collaboration_id");
  const collaboration = find(context, "collaborations", collaborationId);
  const hotelId = uuid(collaboration.data["hotel_id"], "hotel_id");
  const hotel = hotelScope(
    context,
    "marketplace",
    "hotel_profiles",
    hotelId,
    "marketplace",
    "hotel_profile",
    "owner",
  );
  const creatorId = uuid(collaboration.data["creator_id"], "creator_id");
  const creator = find(context, "creators", creatorId);
  const senderId = uuid(row.data["sender_id"], "sender_id");
  const creatorUserId = uuid(creator.data["user_id"], "creator.user_id");
  const hotelProfile = find(context, "hotel_profiles", hotelId);
  const hotelUserId = uuid(hotelProfile.data["user_id"], "hotel.user_id");
  const ownerScope =
    senderId === creatorUserId
      ? owner(context, "marketplace", "creator_profile", creatorId, "owner")
      : senderId === hotelUserId
        ? { organizationId: hotel.organizationId, ownerStatus: hotel.ownerStatus }
        : null;
  if (!ownerScope)
    throw new Error("sender_id is neither the collaboration creator nor hotel owner");
  const metadata = object(row.data["metadata"]);
  const value = metadata["legacySourceUrl"] ?? metadata["url"] ?? row.data["content"];
  const retainedUntil = retentionDate(row.data["created_at"]);
  if (Date.parse(retainedUntil) <= Date.parse(context.completedAt)) return [];
  const result: ProductionMediaReference[] = [];
  appendUrl(
    result,
    context,
    row,
    { propertyId: hotel.propertyId, ...ownerScope },
    {
      value,
      field: "image",
      rowId: `${id}:image`,
      purpose: "marketplace.collaboration_chat.attachment",
      product: "marketplace",
      resourceType: "collaboration_chat_message",
      resourceId: id,
      sortOrder: 0,
      visibility: "private",
      retainedUntil,
    },
  );
  return result;
}

function pmsRoomType(context: Context, row: IdentitySourceRow): ProductionMediaReference[] {
  const id = uuid(row.data["id"], "id");
  const hotelId = uuid(row.data["hotel_id"], "hotel_id");
  const scope = hotelScope(context, "pms", "hotels", hotelId, "pms", "pms_hotel", "operator");
  const result: ProductionMediaReference[] = [];
  for (
    const [index, value] of mediaStrings(context, row, row.data["images"], {
      field: "images",
      rowId: `${id}:images`,
      purpose: "pms.room_type.media",
    }).entries()
  )
    appendUrl(result, context, row, scope, {
      value,
      field: `images[${index}]`,
      rowId: `${id}:images:${index + 1}`,
      purpose: "pms.room_type.media",
      product: "pms",
      resourceType: "room_type",
      resourceId: id,
      sortOrder: index,
    });
  return result;
}

function pmsAttachment(context: Context, row: IdentitySourceRow): ProductionMediaReference[] {
  const id = uuid(row.data["id"], "id");
  const message = find(context, "messages", uuid(row.data["message_id"], "message_id"));
  const thread = find(context, "message_threads", uuid(message.data["thread_id"], "thread_id"));
  const hotelId = uuid(thread.data["hotel_id"], "hotel_id");
  const scope = hotelScope(context, "pms", "hotels", hotelId, "pms", "pms_hotel", "operator");
  const sourceKey = row.data["s3_key"];
  const s3Key = optionalText(
    typeof sourceKey === "string" ? sourceKey.trim() : sourceKey,
    "s3_key",
  );
  const sourceUrl = row.data["source_url"];
  if (!s3Key && (sourceUrl === null || sourceUrl === undefined || sourceUrl === "")) return [];
  const value = s3Key ? s3Url(context.legacyPmsBucket, s3Key) : sourceUrl;
  const result: ProductionMediaReference[] = [];
  appendUrl(result, context, row, scope, {
    value,
    field: s3Key ? "s3_key" : "source_url",
    rowId: `${id}:${s3Key ? "s3_key" : "source_url"}`,
    purpose: "pms.messaging.attachment",
    product: "pms",
    resourceType: "message_attachment",
    resourceId: id,
    sortOrder: 0,
    visibility: "private",
  });
  return result;
}

function appendUrl(
  target: ProductionMediaReference[],
  context: Context,
  row: IdentitySourceRow,
  scope: { propertyId: string | null } & MediaOwnerScope,
  input: {
    value: unknown;
    field: string;
    rowId: string;
    purpose: ProductionMediaPurpose;
    product: ProductionMediaReference["resourceProduct"];
    resourceType: string;
    resourceId: string;
    sortOrder: number;
    visibility?: "public" | "private";
    retainedUntil?: string | null;
  },
): void {
  let value: string | null;
  try {
    value = optionalText(input.value, input.field);
  } catch {
    quarantineField(context, row, input, "INVALID_HTTPS_URL");
    return;
  }
  if (!value) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    quarantineField(context, row, input, "INVALID_HTTPS_URL");
    return;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    quarantineField(context, row, input, "INVALID_HTTPS_URL");
    return;
  }
  const visibility = scope.ownerStatus === "active" ? (input.visibility ?? "public") : "private";
  const material = {
    sourceSystem: row.sourceDatabase as ProductionMediaReference["sourceSystem"],
    sourceTable: row.sourceTable,
    sourceRowId: input.rowId,
    sourceField: input.field,
    sourceUrl: value,
    sourceUpdatedAt: timestamp(row),
    purpose: input.purpose,
    visibility,
    publicApproved: visibility === "public",
    propertyId: scope.propertyId,
    ownerOrganizationId: scope.organizationId,
    resourceProduct: input.product,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    sortOrder: input.sortOrder,
    retainedUntil: input.retainedUntil ?? null,
  };
  target.push({
    ...material,
    mediaObjectId: deterministicUuid(
      "vayada",
      "production-media",
      row.sourceDatabase,
      row.sourceTable,
      input.rowId,
      input.purpose,
    ),
    sourceReferenceSha256: sha256(material),
    originalFilename: originalFilename(parsed),
  });
}

function originalFilename(url: URL): string {
  const encoded = url.pathname.split("/").at(-1) || "legacy-media";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "legacy-media";
  }
}

function retentionDate(value: unknown): string {
  const createdAt = new Date(iso(value, "created_at"));
  createdAt.setUTCFullYear(createdAt.getUTCFullYear() + 2);
  return createdAt.toISOString();
}

function normalizedCdnBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /(^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(url.hostname)
  )
    throw new Error("cdnBaseUrl must be a non-S3 HTTPS origin");
  return `${url.origin}/`;
}

function publicCdnUrlMatchesStorageKey(value: string, storageKey: string, base: string): boolean {
  try {
    const url = new URL(value);
    return (
      storageKey.startsWith("public/") &&
      url.toString() === new URL(storageKey.slice(7), base).toString()
    );
  } catch {
    return false;
  }
}

function hotelScope(
  context: Context,
  sourceSystem: string,
  sourceTable: string,
  sourceId: string,
  product: string,
  resourceType: string,
  relationship: string,
): { propertyId: string } & MediaOwnerScope {
  const propertyId = context.property.get(`${sourceSystem}:${sourceTable}:${sourceId}`);
  if (!propertyId)
    throw new Error(
      `no active ${context.sourceRunId} property link for ${sourceSystem}.${sourceTable} ${sourceId}`,
    );
  const ownerScope = owner(context, product, resourceType, sourceId, relationship);
  return {
    propertyId,
    ...ownerScope,
    ...(context.privateProperties.has(`${sourceSystem}:${sourceTable}:${sourceId}`)
      ? { ownerStatus: "archived" as const }
      : {}),
  };
}

function owner(
  context: Context,
  product: string,
  resourceType: string,
  resourceId: string,
  relationship: string,
): MediaOwnerScope {
  const result = context.organization.get(
    `${product}:${resourceType}:${resourceId}:${relationship}`,
  );
  if (!result)
    throw new Error(`no authoritative owner for ${product}.${resourceType} ${resourceId}`);
  return result;
}

function timestamp(row: IdentitySourceRow): string {
  return iso(row.data["updated_at"] ?? row.data["created_at"], "updated_at");
}

function mediaStrings(
  context: Context,
  row: IdentitySourceRow,
  value: unknown,
  input: {
    field: string;
    rowId: string;
    purpose: ProductionMediaPurpose;
  },
): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    quarantineField(context, row, { ...input, value }, "INVALID_STRING_ARRAY");
    return [];
  }
  return value.filter((item) => item.trim());
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function find(context: Context, table: string, id: string): IdentitySourceRow {
  const rows = (context.byTable.get(table) ?? []).filter(
    (row) => String(row.data["id"] ?? "").toLowerCase() === id,
  );
  if (rows.length !== 1) throw new Error(`${table} ${id} resolves to ${rows.length} source rows`);
  return rows[0]!;
}

function uniqueMap<T>(
  rows: T[],
  key: (row: T) => string,
  value: (row: T) => string,
  blockers: IdentityMigrationBlocker[],
  code: string,
): Map<string, string> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows)
    grouped.set(key(row), new Set([...(grouped.get(key(row)) ?? []), value(row)]));
  const result = new Map<string, string>();
  for (const [item, values] of grouped)
    if (values.size === 1) result.set(item, [...values][0]!);
    else block(blockers, code, "identity", item, "Source scope resolves to multiple target owners");
  return result;
}

function uniqueOwnerMap(
  rows: ProductionMediaTargetState["resourceLinks"],
  key: (row: ProductionMediaTargetState["resourceLinks"][number]) => string,
  blockers: IdentityMigrationBlocker[],
): Map<string, MediaOwnerScope> {
  const grouped = new Map<string, Map<string, MediaOwnerScope>>();
  for (const row of rows) {
    const item = key(row);
    const scope = {
      organizationId: row.organizationId,
      ownerStatus: row.status as MediaOwnerScope["ownerStatus"],
    };
    const values = grouped.get(item) ?? new Map<string, MediaOwnerScope>();
    values.set(`${scope.organizationId}:${scope.ownerStatus}`, scope);
    grouped.set(item, values);
  }
  const result = new Map<string, MediaOwnerScope>();
  for (const [item, values] of grouped)
    if (values.size === 1) result.set(item, [...values.values()][0]!);
    else
      block(
        blockers,
        "AMBIGUOUS_MEDIA_OWNER",
        "identity",
        item,
        "Source scope resolves to multiple target owners",
      );
  return result;
}

function s3Url(bucket: string, key: string): string {
  const host = requiredText(bucket, "legacyPmsBucket");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(host))
    throw new Error("legacyPmsBucket is invalid");
  return new URL(key.replace(/^\/+/, ""), `https://${host}.s3.amazonaws.com/`).toString();
}

function mediaKey(value: {
  sourceSystem: string;
  sourceTable: string;
  sourceRowId: string;
  purpose: string;
}): string {
  return `${value.sourceSystem}:${value.sourceTable}:${value.sourceRowId}:${value.purpose}`;
}

function quarantineKey(value: ProductionMediaQuarantine): string {
  return `${mediaKey(value)}:${value.sourceField}:${value.reasonCode}`;
}

function quarantineField(
  context: Context,
  row: IdentitySourceRow,
  input: {
    value: unknown;
    field: string;
    rowId: string;
    purpose: ProductionMediaPurpose;
  },
  reasonCode: ProductionMediaQuarantine["reasonCode"],
): void {
  context.quarantines.push({
    sourceSystem: row.sourceDatabase as ProductionMediaQuarantine["sourceSystem"],
    sourceTable: row.sourceTable,
    sourceRowId: input.rowId,
    sourceField: input.field,
    sourceValueSha256: sha256({ value: input.value }),
    purpose: input.purpose,
    reasonCode,
  });
}

function safeId(row: IdentitySourceRow): string {
  return typeof row.data["id"] === "string" ? row.data["id"] : `row:${row.rowOrdinal}`;
}

function block(
  blockers: IdentityMigrationBlocker[],
  code: string,
  source: string,
  sourceId: string,
  message: string,
): void {
  blockers.push({ code, source, sourceId, message });
}

function sortedBlockers(blockers: IdentityMigrationBlocker[]): IdentityMigrationBlocker[] {
  return blockers.sort((left, right) =>
    `${left.code}:${left.source}:${left.sourceId}`.localeCompare(
      `${right.code}:${right.source}:${right.sourceId}`,
    ),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
