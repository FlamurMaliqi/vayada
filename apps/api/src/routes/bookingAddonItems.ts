import { queryCurrency } from "../domains/pmsPricingReadModel.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseAddonEconomicTerms, type AddonEconomicTerms } from "@vayada/domain-booking";
import type { PropertyPlanReadModel } from "@vayada/domain-finance";
import pg, { type QueryResultRow } from "pg";

import { readPropertyPlan } from "../domains/propertyPlanReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

const ADDON_CATEGORIES = new Set(["dining", "experience", "transport", "wellness", "other"]);
const PRICING_MODELS = new Set(["per_stay", "per_night", "per_guest", "per_guest_night"]);
const WRITABLE_STATUSES = new Set(["active", "disabled"]);

export type BookingAddonPricingModel = "per_stay" | "per_night" | "per_guest" | "per_guest_night";

export type AddonPhoto = { mediaObjectId: string | null; imageUrl: string; isCover: boolean };
type AddonDetails = {
  photos?: AddonPhoto[];
  location?: string | null;
  maxGuests?: number | null;
  leadTime?: string | null;
  maxQuantity?: number;
};

export type BookingAddonItemStatus = "active" | "disabled" | "retired";

export type BookingAddonItem = {
  addonItemId: string;
  hotelId: string;
  propertyId: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  category: "dining" | "experience" | "transport" | "wellness" | "other";
  imageUrl: string | null;
  imageMediaObjectId: string | null;
  duration: string | null;
  pricingModel: BookingAddonPricingModel;
  publicVisible: boolean;
  status: BookingAddonItemStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
} & AddonEconomicTerms &
  AddonDetails;

export type CreateBookingAddonItemBody = {
  name: string;
  description: string;
  price: string;
  currency: string;
  category: BookingAddonItem["category"];
  imageMediaObjectId: string | null;
  duration: string | null;
  pricingModel: BookingAddonPricingModel;
  publicVisible: boolean;
  status: Exclude<BookingAddonItemStatus, "retired">;
  sortOrder: number;
} & AddonEconomicTerms &
  AddonDetails;

type UpdateAddonEconomicTerms =
  | { ownershipKind?: never; partnerCommissionRate?: never }
  | AddonEconomicTerms;

export type UpdateBookingAddonItemBody = Partial<
  Omit<CreateBookingAddonItemBody, keyof AddonEconomicTerms>
> &
  UpdateAddonEconomicTerms;

export type BookingAddonItemsContext = {
  addonItems: BookingAddonItem[];
  propertyCurrency?: string;
  propertyPlan: PropertyPlanReadModel;
};

export type CreateBookingAddonItemResult =
  | { outcome: "created"; addonItem: BookingAddonItem }
  | {
      outcome: "plan_limit_reached";
      currentCount: number;
      propertyPlan: PropertyPlanReadModel;
    };

export type BookingAddonItemsRepository = {
  listAddonItemsByHotelId(hotelId: string): Promise<BookingAddonItemsContext | null>;
  createAddonItemByHotelId(
    hotelId: string,
    body: CreateBookingAddonItemBody,
  ): Promise<CreateBookingAddonItemResult | null>;
  updateAddonItemByHotelId(
    hotelId: string,
    addonItemId: string,
    body: UpdateBookingAddonItemBody,
  ): Promise<BookingAddonItem | null>;
  retireAddonItemByHotelId(hotelId: string, addonItemId: string): Promise<boolean>;
  close?(): Promise<void>;
};

export type BookingAddonItemsQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{
    rows: T[];
  }>;
};

export type BookingAddonItemsPool = BookingAddonItemsQueryable & {
  end?(): Promise<void>;
  connect?(): Promise<BookingAddonItemsPoolClient>;
};

export type BookingAddonItemsPoolClient = BookingAddonItemsQueryable & {
  release(): void;
};

type AddonItemsParams = {
  hotelId: string;
};

type AddonItemParams = AddonItemsParams & {
  addonItemId: string;
};

type BookingAddonItemsError = {
  statusCode: 401 | 403 | 404 | 409 | 422 | 500;
  code:
    | "unauthenticated"
    | "missing_permission"
    | "missing_entitlement"
    | "inactive_entitlement"
    | "missing_resource_access"
    | "invalid_payload"
    | "plan_limit_reached"
    | "not_found"
    | "read_model_unavailable"
    | "write_model_unavailable";
  category: "authentication" | "authorization" | "validation" | "read_model" | "write_model";
  message: string;
  details?: unknown;
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; details: string[] };

class BookingAddonImageInvalidError extends Error {}

export async function registerBookingAddonItemRoutes(
  app: FastifyInstance,
  repository: BookingAddonItemsRepository,
): Promise<void> {
  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Params: AddonItemsParams }>("/hotels/:hotelId/addon-items", async (request, reply) => {
    const { hotelId } = request.params;
    const accessError = authorize(request, hotelId);
    if (accessError) return sendAddonItemsError(reply, accessError);

    try {
      const context = await repository.listAddonItemsByHotelId(hotelId);
      if (!context) return sendAddonItemsError(reply, readNotFoundError());
      return context;
    } catch {
      return sendAddonItemsError(reply, readUnavailableError());
    }
  });

  app.post<{ Params: AddonItemsParams; Body: unknown }>(
    "/hotels/:hotelId/addon-items",
    async (request, reply) => {
      const { hotelId } = request.params;
      const accessError = authorize(request, hotelId);
      if (accessError) return sendAddonItemsError(reply, accessError);

      const parsed = parseCreateBody(request.body);
      if (!parsed.ok) return sendInvalidPayload(reply, parsed.details);

      try {
        const result = await repository.createAddonItemByHotelId(hotelId, parsed.value);
        if (!result) return sendAddonItemsError(reply, writeNotFoundError());
        if (result.outcome === "plan_limit_reached") {
          return sendAddonItemsError(reply, addonLimitError(result));
        }
        return reply.status(201).send(result.addonItem);
      } catch (error) {
        if (error instanceof BookingAddonImageInvalidError)
          return sendInvalidPayload(reply, [error.message]);
        return sendAddonItemsError(reply, writeUnavailableError());
      }
    },
  );

  app.patch<{ Params: AddonItemParams; Body: unknown }>(
    "/hotels/:hotelId/addon-items/:addonItemId",
    async (request, reply) => {
      const { hotelId, addonItemId } = request.params;
      const accessError = authorize(request, hotelId);
      if (accessError) return sendAddonItemsError(reply, accessError);

      const parsed = parseUpdateBody(request.body);
      if (!parsed.ok) return sendInvalidPayload(reply, parsed.details);

      try {
        const addonItem = await repository.updateAddonItemByHotelId(
          hotelId,
          addonItemId,
          parsed.value,
        );
        if (!addonItem) return sendAddonItemsError(reply, writeNotFoundError());
        return addonItem;
      } catch (error) {
        if (error instanceof BookingAddonImageInvalidError)
          return sendInvalidPayload(reply, [error.message]);
        return sendAddonItemsError(reply, writeUnavailableError());
      }
    },
  );

  app.delete<{ Params: AddonItemParams }>(
    "/hotels/:hotelId/addon-items/:addonItemId",
    async (request, reply) => {
      const { hotelId, addonItemId } = request.params;
      const accessError = authorize(request, hotelId);
      if (accessError) return sendAddonItemsError(reply, accessError);

      try {
        const retired = await repository.retireAddonItemByHotelId(hotelId, addonItemId);
        if (!retired) return sendAddonItemsError(reply, writeNotFoundError());
        return reply.status(204).send();
      } catch {
        return sendAddonItemsError(reply, writeUnavailableError());
      }
    },
  );
}

export function createPgTargetBookingAddonItemsRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingAddonItemsPool;
}): BookingAddonItemsRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Target booking add-on items repository connectionString must not be empty");
  }

  const pool: BookingAddonItemsPool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as BookingAddonItemsPool);

  async function resolvePropertyId(
    queryable: BookingAddonItemsQueryable,
    hotelId: string,
  ): Promise<string | null> {
    const result = await queryable.query<{ propertyId: string }>(
      `WITH direct_property AS (
         SELECT property.id::text AS "propertyId"
         FROM hotel_catalog.properties property
         WHERE property.id::text = $1
       ),
       property_candidates AS (
         SELECT "propertyId" FROM direct_property
         UNION ALL
         SELECT property_id::text AS "propertyId"
         FROM hotel_catalog.property_source_links
         WHERE source_system = 'booking'
           AND source_table = 'booking_hotels'
           AND source_id = $1
           AND relationship = 'canonical_input'
           AND status = 'active'
           AND NOT EXISTS (SELECT 1 FROM direct_property)
       )
       SELECT "propertyId" FROM property_candidates`,
      [hotelId],
    );
    if (result.rows.length > 1) {
      throw new Error(`Duplicate active canonical booking hotel source links for ${hotelId}`);
    }
    return result.rows[0]?.propertyId ?? null;
  }

  return {
    async listAddonItemsByHotelId(hotelId) {
      const propertyId = await resolvePropertyId(pool, hotelId);
      if (!propertyId) return null;
      const [result, propertyPlan, pricingCurrency] = await Promise.all([
        pool.query<AddonItemRow>(
          `${addonItemSelectSql()}
         WHERE addon_definitions.property_id = $1
           AND addon_definitions.status <> 'retired'
         ORDER BY COALESCE((addon_definitions.metadata ->> 'sortOrder')::int, 0),
                  addon_definitions.created_at,
                  addon_definitions.id`,
          [propertyId],
        ),
        readPropertyPlan(pool, propertyId),
        queryCurrency(pool, propertyId),
      ]);
      return {
        propertyCurrency: pricingCurrency?.currency,
        addonItems: result.rows.map((row) => toAddonItem(row, hotelId)),
        propertyPlan,
      };
    },
    async createAddonItemByHotelId(hotelId, body) {
      if (!pool.connect) {
        throw new Error("Target booking add-on creation requires transactional pool access");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const propertyId = await resolvePropertyId(client, hotelId);
        if (!propertyId) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query(
          `SELECT id FROM hotel_catalog.properties WHERE id = $1::uuid FOR UPDATE`,
          [propertyId],
        );
        const propertyPlan = await readPropertyPlan(client, propertyId);
        const countResult = await client.query<{ currentCount: string }>(
          `SELECT count(*)::text AS "currentCount"
           FROM booking.addon_definitions
           WHERE property_id = $1::uuid AND status <> 'retired'`,
          [propertyId],
        );
        const currentCount = Number(countResult.rows[0]?.currentCount ?? 0);
        if (currentCount >= propertyPlan.limits.maxAddons) {
          await client.query("COMMIT");
          return { outcome: "plan_limit_reached", currentCount, propertyPlan };
        }
        const currency = await queryCurrency(client, propertyId);
        if (!currency)
          throw new BookingAddonImageInvalidError("Property pricing currency is unavailable.");
        body = { ...body, currency: currency.currency };
        const photos = await resolveAddonPhotos(client, propertyId, body.photos);
        const image =
          photos === undefined
            ? await resolveAddonImage(client, propertyId, body.imageMediaObjectId)
            : (photos.find((photo) => photo.isCover) ?? null);
        const order = await client.query<{ nextOrder: number }>(
          `SELECT COALESCE(MAX((metadata ->> 'sortOrder')::int), -1) + 1 AS "nextOrder" FROM booking.addon_definitions WHERE property_id = $1::uuid AND status <> 'retired'`,
          [propertyId],
        );
        body = { ...body, photos, sortOrder: order.rows[0]?.nextOrder ?? 0 };
        const insertResult = await client.query<{ addonItemId: string }>(
          `INSERT INTO booking.addon_definitions (
             property_id, name, description, category, pricing_model,
             price_amount, currency, public_visible, status,
             ownership_kind, partner_commission_rate, metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11::numeric, $12::jsonb)
           RETURNING id::text AS "addonItemId"`,
          [
            propertyId,
            body.name,
            body.description,
            body.category,
            body.pricingModel,
            body.price,
            body.currency,
            body.publicVisible,
            body.status,
            body.ownershipKind,
            body.partnerCommissionRate,
            JSON.stringify(metadataFromBody(body, image)),
          ],
        );
        const addonItemId = insertResult.rows[0]?.addonItemId;
        if (!addonItemId) {
          throw new Error("Target booking add-on insert did not return an id");
        }
        const result = await client.query<AddonItemRow>(
          `${addonItemSelectSql()}
           WHERE addon_definitions.id = $1::uuid`,
          [addonItemId],
        );
        await client.query("COMMIT");
        const row = result.rows[0];
        return row ? { outcome: "created", addonItem: toAddonItem(row, hotelId) } : null;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async updateAddonItemByHotelId(hotelId, addonItemId, body) {
      if (
        ("ownershipKind" in body || "partnerCommissionRate" in body) &&
        !parseAddonEconomicTerms(body)
      ) {
        throw new Error("Add-on economic updates require a complete valid ownership pair");
      }
      const propertyId = await resolvePropertyId(pool, hotelId);
      if (!propertyId) return null;
      if (body.price !== undefined || body.currency !== undefined) {
        const currency = await queryCurrency(pool, propertyId);
        if (!currency)
          throw new BookingAddonImageInvalidError("Property pricing currency is unavailable.");
        body = { ...body, currency: currency.currency };
      }
      const photos = await resolveAddonPhotos(pool, propertyId, body.photos, addonItemId);
      const image =
        photos === undefined
          ? await resolveAddonImage(pool, propertyId, body.imageMediaObjectId)
          : (photos.find((photo) => photo.isCover) ?? null);
      body = { ...body, photos };
      const values: unknown[] = [propertyId, addonItemId];
      const sets: string[] = [];
      addSet(sets, values, "name", body.name);
      addSet(sets, values, "description", body.description);
      addSet(sets, values, "category", body.category);
      addSet(sets, values, "pricing_model", body.pricingModel);
      addSet(sets, values, "price_amount", body.price, "::numeric");
      addSet(sets, values, "currency", body.currency);
      addSet(sets, values, "public_visible", body.publicVisible);
      addSet(sets, values, "status", body.status);
      if (body.ownershipKind !== undefined) {
        addSet(sets, values, "ownership_kind", body.ownershipKind);
        addSet(sets, values, "partner_commission_rate", body.partnerCommissionRate, "::numeric");
      }
      const metadata = metadataFromBody(body, image);
      if (Object.keys(metadata).length > 0) {
        values.push(JSON.stringify(metadata));
        sets.push(`metadata = metadata || $${values.length}::jsonb`);
      }
      values.push(new Date());
      sets.push(`updated_at = $${values.length}`);

      const result = await pool.query<AddonItemRow>(
        `WITH updated AS (
           UPDATE booking.addon_definitions
           SET ${sets.join(", ")}
           WHERE property_id = $1 AND id::text = $2 AND status <> 'retired'
           RETURNING id
         )
         ${addonItemSelectSql()}
         JOIN updated ON updated.id = addon_definitions.id`,
        values,
      );
      const row = result.rows[0];
      return row ? toAddonItem(row, hotelId) : null;
    },
    async retireAddonItemByHotelId(hotelId, addonItemId) {
      const propertyId = await resolvePropertyId(pool, hotelId);
      if (!propertyId) return false;
      const result = await pool.query<{ id: string }>(
        `UPDATE booking.addon_definitions
         SET status = 'retired', updated_at = now()
         WHERE property_id = $1 AND id::text = $2
         RETURNING id::text AS id`,
        [propertyId, addonItemId],
      );
      return result.rows.length > 0;
    },
    async close() {
      await pool.end?.();
    },
  };
}

type AddonItemRow = {
  addonItemId: string;
  propertyId: string;
  name: string;
  description: string | null;
  category: string | null;
  pricingModel: BookingAddonPricingModel;
  price: string;
  currency: string;
  publicVisible: boolean;
  status: BookingAddonItemStatus;
  ownershipKind: string;
  partnerCommissionRate: string | null;
  metadata: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function addonItemSelectSql(): string {
  return `SELECT
    addon_definitions.id::text AS "addonItemId",
    addon_definitions.property_id::text AS "propertyId",
    addon_definitions.name,
    addon_definitions.description,
    COALESCE(addon_definitions.category, 'other') AS category,
    addon_definitions.pricing_model AS "pricingModel",
    addon_definitions.price_amount::text AS price,
    addon_definitions.currency,
    addon_definitions.public_visible AS "publicVisible",
    addon_definitions.status,
    addon_definitions.ownership_kind AS "ownershipKind",
    addon_definitions.partner_commission_rate::text AS "partnerCommissionRate",
    addon_definitions.metadata,
    addon_definitions.created_at AS "createdAt",
    addon_definitions.updated_at AS "updatedAt"
   FROM booking.addon_definitions`;
}

function addSet(
  sets: string[],
  values: unknown[],
  column: string,
  value: unknown,
  cast = "",
): void {
  if (value === undefined) return;
  values.push(value);
  sets.push(`${column} = $${values.length}${cast}`);
}

async function resolveAddonImage(
  queryable: BookingAddonItemsQueryable,
  propertyId: string,
  mediaObjectId: string | null | undefined,
): Promise<{ mediaObjectId: string; imageUrl: string } | null | undefined> {
  if (mediaObjectId === undefined) return undefined;
  if (mediaObjectId === null) return null;
  const result = await queryable.query<{ mediaObjectId: string; imageUrl: string }>(
    `SELECT media.id::text AS "mediaObjectId", variant.public_cdn_url AS "imageUrl"
       FROM platform.media_objects media
       JOIN platform.media_variants variant
         ON variant.media_object_id = media.id
        AND variant.variant_name = 'original_safe'
        AND variant.visibility = 'public'
      WHERE media.id = $1::uuid
        AND media.property_id = $2::uuid
        AND media.purpose = 'booking.addon.image'
        AND media.resource_product = 'booking'
        AND media.storage_kind = 'vayada_managed'
        AND media.storage_key LIKE
              'public/media/' || media.id::text || '/original_safe/%'
        AND media.visibility = 'public'
        AND media.public_approved = TRUE
        AND media.lifecycle_status = 'active'
        AND media.deleted_at IS NULL
        AND variant.storage_key = media.storage_key
        AND variant.storage_key LIKE
              'public/media/' || media.id::text || '/original_safe/%'
        AND variant.public_cdn_url IS NOT NULL
        AND variant.public_cdn_url !~* '^https://(?:[a-z0-9.-]+\\.)?s3(?:[.-][a-z0-9-]+)?\\.amazonaws\\.com(?::[0-9]+)?/'
        AND substring(
              variant.public_cdn_url
              FROM '^https://[a-z0-9.-]+(?::[0-9]+)?(/[^?#]*)$'
            ) = '/' || substring(variant.storage_key FROM 8)`,
    [mediaObjectId, propertyId],
  );
  const image = result.rows[0];
  if (!image)
    throw new BookingAddonImageInvalidError(
      "imageMediaObjectId must reference an active approved add-on image for this property.",
    );
  return image;
}

function toAddonItem(row: AddonItemRow, hotelId: string): BookingAddonItem {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const economicTerms = parseAddonEconomicTerms(row);
  if (!economicTerms) throw new Error("Stored add-on economics are invalid");
  const imageUrl = nullableString(metadata.imageUrl);
  const imageMediaObjectId = nullableString(metadata.mediaObjectId);
  const duration = nullableString(metadata.duration);
  const sortOrder = typeof metadata.sortOrder === "number" ? metadata.sortOrder : 0;
  return {
    addonItemId: row.addonItemId,
    hotelId,
    propertyId: row.propertyId,
    name: row.name,
    description: row.description ?? "",
    price: row.price,
    currency: row.currency,
    category: normalizeAddonCategory(row.category),
    imageUrl,
    imageMediaObjectId,
    duration,
    photos: Array.isArray(metadata.photos)
      ? (metadata.photos as AddonPhoto[])
      : imageUrl
        ? [{ imageUrl, mediaObjectId: imageMediaObjectId, isCover: true }]
        : [],
    location: nullableString(metadata.location),
    leadTime: nullableString(metadata.leadTime),
    maxGuests: typeof metadata.maxGuests === "number" ? metadata.maxGuests : null,
    maxQuantity: typeof metadata.maxQuantity === "number" ? metadata.maxQuantity : 1,
    pricingModel: row.pricingModel,
    publicVisible: row.publicVisible,
    status: row.status,
    sortOrder,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    ...economicTerms,
  };
}

function metadataFromBody(
  body: Partial<CreateBookingAddonItemBody>,
  image: { mediaObjectId: string | null; imageUrl: string } | null | undefined,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (image !== undefined) {
    metadata.imageUrl = image?.imageUrl ?? null;
    metadata.mediaObjectId = image?.mediaObjectId ?? null;
  }
  if ("duration" in body) metadata.duration = body.duration ?? null;
  if ("sortOrder" in body) metadata.sortOrder = body.sortOrder ?? 0;
  for (const key of ["photos", "location", "leadTime", "maxGuests", "maxQuantity"] as const) {
    if (body[key] !== undefined) metadata[key] = body[key];
  }
  return metadata;
}

function parseCreateBody(body: unknown): ValidationResult<CreateBookingAddonItemBody> {
  const parsed = expectObject(body);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const details = unknownFields(input);
  const name = requiredString(input, "name", details);
  const description = optionalString(input, "description", details) ?? "";
  const price = requiredPrice(input, details);
  const currency = requiredCurrency(input, details);
  const category = requiredEnum(input, "category", ADDON_CATEGORIES, details);
  const imageMediaObjectId = optionalNullableUuid(input, "imageMediaObjectId", details);
  const duration = optionalNullableString(input, "duration", details);
  const pricingModel = optionalEnum(input, "pricingModel", PRICING_MODELS, details) ?? "per_stay";
  const publicVisible = optionalBoolean(input, "publicVisible", details) ?? true;
  const status = optionalEnum(input, "status", WRITABLE_STATUSES, details) ?? "active";
  const sortOrder = optionalInteger(input, "sortOrder", details) ?? 0;
  const extra = parseAddonDetails(input, details);
  const economicTerms = parseEconomicTerms(input, details, true) ?? {
    ownershipKind: "property",
    partnerCommissionRate: null,
  };
  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      name,
      description,
      price,
      currency,
      category: category as CreateBookingAddonItemBody["category"],
      imageMediaObjectId,
      duration,
      pricingModel: pricingModel as BookingAddonPricingModel,
      publicVisible,
      status: status as CreateBookingAddonItemBody["status"],
      sortOrder,
      ...economicTerms,
      ...extra,
    },
  };
}

function parseUpdateBody(body: unknown): ValidationResult<UpdateBookingAddonItemBody> {
  const parsed = expectObject(body);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const details = unknownFields(input);
  if (Object.keys(input).length === 0) details.push("At least one add-on item field is required.");

  const value: UpdateBookingAddonItemBody = parseAddonDetails(input, details);
  if ("name" in input) value.name = requiredString(input, "name", details);
  if ("description" in input) value.description = optionalString(input, "description", details);
  if ("price" in input) value.price = requiredPrice(input, details);
  if ("currency" in input) value.currency = requiredCurrency(input, details);
  if ("category" in input) {
    value.category = requiredEnum(
      input,
      "category",
      ADDON_CATEGORIES,
      details,
    ) as CreateBookingAddonItemBody["category"];
  }
  if ("imageMediaObjectId" in input)
    value.imageMediaObjectId = optionalNullableUuid(input, "imageMediaObjectId", details);
  if ("duration" in input) value.duration = optionalNullableString(input, "duration", details);
  if ("pricingModel" in input) {
    value.pricingModel = requiredEnum(
      input,
      "pricingModel",
      PRICING_MODELS,
      details,
    ) as BookingAddonPricingModel;
  }
  if ("publicVisible" in input)
    value.publicVisible = requiredBoolean(input, "publicVisible", details);
  if ("status" in input) {
    value.status = requiredEnum(
      input,
      "status",
      WRITABLE_STATUSES,
      details,
    ) as CreateBookingAddonItemBody["status"];
  }
  if ("sortOrder" in input) value.sortOrder = requiredInteger(input, "sortOrder", details);
  const economicTerms = parseEconomicTerms(input, details, false);
  if (economicTerms) Object.assign(value, economicTerms);
  if (details.length > 0) return { ok: false, details };
  return { ok: true, value };
}

const KNOWN_FIELDS = new Set([
  "photos",
  "location",
  "leadTime",
  "maxGuests",
  "maxQuantity",
  "name",
  "description",
  "price",
  "currency",
  "category",
  "imageMediaObjectId",
  "duration",
  "pricingModel",
  "publicVisible",
  "status",
  "sortOrder",
  "ownershipKind",
  "partnerCommissionRate",
]);

function parseEconomicTerms(
  input: Record<string, unknown>,
  details: string[],
  defaultToProperty: boolean,
): AddonEconomicTerms | undefined {
  if (!defaultToProperty && !("ownershipKind" in input) && !("partnerCommissionRate" in input)) {
    return undefined;
  }
  const parsed = parseAddonEconomicTerms({
    ownershipKind: input["ownershipKind"] ?? (defaultToProperty ? "property" : undefined),
    partnerCommissionRate: input["partnerCommissionRate"] ?? null,
  });
  if (!parsed) {
    details.push(
      "ownershipKind and partnerCommissionRate must be property/null or partner/a 0..100 decimal with at most four decimal places.",
    );
  }
  return parsed ?? undefined;
}

function expectObject(body: unknown): ValidationResult<Record<string, unknown>> {
  if (!isRecord(body)) return { ok: false, details: ["Body must be an object."] };
  return { ok: true, value: body };
}

function unknownFields(input: Record<string, unknown>): string[] {
  return Object.keys(input)
    .filter((key) => !KNOWN_FIELDS.has(key))
    .map((key) => `${key} is not allowed.`);
}

function requiredString(input: Record<string, unknown>, key: string, details: string[]): string {
  const value = optionalString(input, key, details);
  if (!value) details.push(`${key} is required.`);
  return value ?? "";
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  details: string[],
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    details.push(`${key} must be a string.`);
    return undefined;
  }
  return value.trim();
}

function optionalNullableString(
  input: Record<string, unknown>,
  key: string,
  details: string[],
): string | null {
  if (!(key in input) || input[key] === null) return null;
  return optionalString(input, key, details) ?? null;
}

function optionalNullableUuid(
  input: Record<string, unknown>,
  key: string,
  details: string[],
): string | null {
  const value = optionalNullableString(input, key, details);
  if (
    value &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    details.push(`${key} must be a UUID or null.`);
  return value;
}

function requiredPrice(input: Record<string, unknown>, details: string[]): string {
  const value = requiredString(input, "price", details);
  if (value && !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    details.push("price must be a non-negative decimal string.");
  }
  return value;
}

function requiredCurrency(input: Record<string, unknown>, details: string[]): string {
  const value = requiredString(input, "currency", details);
  if (value && !/^[A-Z]{3}$/.test(value))
    details.push("currency must be an uppercase ISO-4217 code.");
  return value;
}

function optionalEnum(
  input: Record<string, unknown>,
  key: string,
  allowed: Set<string>,
  details: string[],
): string | undefined {
  if (!(key in input)) return undefined;
  return requiredEnum(input, key, allowed, details);
}

function requiredEnum(
  input: Record<string, unknown>,
  key: string,
  allowed: Set<string>,
  details: string[],
): string {
  const value = requiredString(input, key, details);
  if (value && !allowed.has(value)) details.push(`${key} is invalid.`);
  return value;
}

function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
  details: string[],
): boolean | undefined {
  if (!(key in input)) return undefined;
  return requiredBoolean(input, key, details);
}

function requiredBoolean(input: Record<string, unknown>, key: string, details: string[]): boolean {
  const value = input[key];
  if (typeof value !== "boolean") {
    details.push(`${key} must be a boolean.`);
    return false;
  }
  return value;
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  details: string[],
): number | undefined {
  if (!(key in input)) return undefined;
  return requiredInteger(input, key, details);
}

function requiredInteger(input: Record<string, unknown>, key: string, details: string[]): number {
  const value = input[key];
  if (!Number.isInteger(value)) {
    details.push(`${key} must be an integer.`);
    return 0;
  }
  return value as number;
}

function normalizeAddonCategory(value: string | null): BookingAddonItem["category"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "dining" || normalized === "food") return "dining";
  if (normalized === "experience") return "experience";
  if (normalized === "transport") return "transport";
  if (normalized === "wellness") return "wellness";
  return "other";
}

function authorize(request: FastifyRequest, hotelId: string): BookingAddonItemsError | null {
  try {
    enforceRoutePolicy(request, {
      permission: "booking.settings.manage",
      entitlement: {
        product: "booking",
        key: "booking-engine",
        resource: { product: "booking", resourceType: "booking_hotel", resourceId: hotelId },
      },
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: hotelId,
        allowedRelationships: ["owner", "operator"],
      },
    });
    return null;
  } catch (error) {
    if (!isStatusError(error)) throw error;
    if (error.statusCode === 401) {
      return {
        statusCode: 401,
        code: "unauthenticated",
        category: "authentication",
        message: "A valid access token is required.",
      };
    }
    const code = authorizationCode(error.message, request, hotelId);
    return {
      statusCode: 403,
      code,
      category: "authorization",
      message: authorizationMessage(code),
    };
  }
}

function authorizationCode(
  message: string,
  request: FastifyRequest,
  hotelId: string,
): Exclude<
  BookingAddonItemsError["code"],
  | "unauthenticated"
  | "invalid_payload"
  | "plan_limit_reached"
  | "not_found"
  | "read_model_unavailable"
  | "write_model_unavailable"
> {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactiveEntitlement(request, hotelId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function hasInactiveEntitlement(request: FastifyRequest, hotelId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (entitlement.product !== "booking" || entitlement.key !== "booking-engine") {
        return false;
      }
      if (entitlement.status === "active") return false;
      if (!entitlement.resource) return true;
      return (
        entitlement.resource.product === "booking" &&
        entitlement.resource.resourceType === "booking_hotel" &&
        entitlement.resource.resourceId === hotelId
      );
    }) ?? false
  );
}

function authorizationMessage(code: BookingAddonItemsError["code"]): string {
  if (code === "missing_permission") return "Missing required booking settings permission.";
  if (code === "missing_entitlement") return "Missing active booking engine entitlement.";
  if (code === "inactive_entitlement") return "Booking engine entitlement is not active.";
  return "Missing booking hotel access.";
}

function sendInvalidPayload(reply: FastifyReply, details: string[]): FastifyReply {
  return sendAddonItemsError(reply, {
    statusCode: 422,
    code: "invalid_payload",
    category: "validation",
    message: "Booking add-on item payload is invalid.",
    details,
  });
}

function readNotFoundError(): BookingAddonItemsError {
  return {
    statusCode: 404,
    code: "not_found",
    category: "read_model",
    message: "Booking add-on item target not found.",
  };
}

function writeNotFoundError(): BookingAddonItemsError {
  return {
    statusCode: 404,
    code: "not_found",
    category: "write_model",
    message: "Booking add-on item target not found.",
  };
}

function addonLimitError(
  result: Extract<CreateBookingAddonItemResult, { outcome: "plan_limit_reached" }>,
): BookingAddonItemsError {
  const { currentCount, propertyPlan } = result;
  const maxAllowed = propertyPlan.limits.maxAddons;
  const message =
    propertyPlan.plan === "commission"
      ? currentCount > maxAllowed
        ? "You have more add-ons than your plan allows. Remove add-ons to add new ones, or upgrade for up to 9."
        : "You've reached the 3 add-on limit. Upgrade to the paid plan for up to 9 add-ons."
      : "You've reached the 9 add-on limit for the paid plan.";
  return {
    statusCode: 409,
    code: "plan_limit_reached",
    category: "validation",
    message,
    details: {
      feature: "addons",
      plan: propertyPlan.plan,
      currentCount,
      maxAllowed,
    },
  };
}

function readUnavailableError(): BookingAddonItemsError {
  return {
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    message: "Booking add-on items could not be loaded.",
  };
}

function writeUnavailableError(): BookingAddonItemsError {
  return {
    statusCode: 500,
    code: "write_model_unavailable",
    category: "write_model",
    message: "Booking add-on items could not be saved.",
  };
}

function sendAddonItemsError(reply: FastifyReply, error: BookingAddonItemsError): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function isStatusError(error: unknown): error is { statusCode: number; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseAddonDetails(input: Record<string, unknown>, details: string[]): AddonDetails {
  const value: AddonDetails = {};
  for (const key of ["location", "leadTime"] as const)
    if (key in input) value[key] = optionalNullableString(input, key, details);
  for (const key of ["maxGuests", "maxQuantity"] as const) {
    if (!(key in input)) continue;
    if (key === "maxGuests" && input[key] === null) {
      value.maxGuests = null;
      continue;
    }
    const number = input[key];
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > 2147483647
    )
      details.push(`${key} must be a positive integer.`);
    else value[key] = number;
  }
  if ("photos" in input) {
    const photos = input.photos;
    if (
      !Array.isArray(photos) ||
      photos.length > 5 ||
      photos.some(
        (photo) =>
          !isRecord(photo) ||
          typeof photo.isCover !== "boolean" ||
          (photo.mediaObjectId !== null &&
            (typeof photo.mediaObjectId !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                photo.mediaObjectId,
              ))) ||
          (photo.mediaObjectId === null && typeof photo.imageUrl !== "string"),
      ) ||
      (photos.length > 0 && photos.filter((photo) => photo.isCover).length !== 1)
    )
      details.push("photos must contain up to five images and exactly one cover.");
    else if (
      new Set(photos.map((photo) => photo.mediaObjectId ?? photo.imageUrl)).size !== photos.length
    )
      details.push("photos must be unique.");
    else value.photos = photos as AddonPhoto[];
  }
  return value;
}

async function resolveAddonPhotos(
  queryable: BookingAddonItemsQueryable,
  propertyId: string,
  photos: AddonPhoto[] | undefined,
  addonItemId?: string,
): Promise<AddonPhoto[] | undefined> {
  if (photos === undefined) return undefined;
  const result: AddonPhoto[] = [];
  for (const photo of photos) {
    if (photo.mediaObjectId) {
      const image = await resolveAddonImage(queryable, propertyId, photo.mediaObjectId);
      result.push({ ...image!, isCover: photo.isCover });
    } else {
      // Imported images can be retained only on the same property's existing add-on.
      const existing = addonItemId
        ? await queryable.query<{ allowed: boolean }>(
            `SELECT true AS allowed FROM booking.addon_definitions WHERE property_id = $1::uuid AND id::text = $2 AND ((metadata ->> 'imageUrl' = $3 AND metadata ->> 'mediaObjectId' IS NULL) OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(metadata -> 'photos', '[]'::jsonb)) photo WHERE photo ->> 'imageUrl' = $3 AND photo ->> 'mediaObjectId' IS NULL))`,
            [propertyId, addonItemId, photo.imageUrl],
          )
        : null;
      if (!existing?.rows[0]?.allowed)
        throw new BookingAddonImageInvalidError(
          "Photos must reference approved images belonging to this property.",
        );
      result.push({ mediaObjectId: null, imageUrl: photo.imageUrl, isCover: photo.isCover });
    }
  }
  return result;
}
