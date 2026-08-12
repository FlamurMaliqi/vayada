import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PropertyPlanReadModel } from "@vayada/domain-finance";
import pg, { type QueryResultRow } from "pg";

import { readPropertyPlan } from "../domains/propertyPlanReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

const ADDON_CATEGORIES = new Set(["dining", "experience", "transport", "wellness", "other"]);
const PRICING_MODELS = new Set(["per_stay", "per_night", "per_guest", "per_guest_night"]);
const WRITABLE_STATUSES = new Set(["active", "disabled"]);

export type BookingAddonPricingModel = "per_stay" | "per_night" | "per_guest" | "per_guest_night";

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
  duration: string | null;
  pricingModel: BookingAddonPricingModel;
  publicVisible: boolean;
  status: BookingAddonItemStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateBookingAddonItemBody = {
  name: string;
  description: string;
  price: string;
  currency: string;
  category: BookingAddonItem["category"];
  imageUrl: string | null;
  duration: string | null;
  pricingModel: BookingAddonPricingModel;
  publicVisible: boolean;
  status: Exclude<BookingAddonItemStatus, "retired">;
  sortOrder: number;
};

export type UpdateBookingAddonItemBody = Partial<CreateBookingAddonItemBody>;

export type BookingAddonItemsContext = {
  addonItems: BookingAddonItem[];
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
      } catch {
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
      } catch {
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
      const [result, propertyPlan] = await Promise.all([
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
      ]);
      return {
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
        const insertResult = await client.query<{ addonItemId: string }>(
          `INSERT INTO booking.addon_definitions (
             property_id, name, description, category, pricing_model,
             price_amount, currency, public_visible, status, metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10::jsonb)
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
            JSON.stringify(metadataFromBody(body)),
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
      const propertyId = await resolvePropertyId(pool, hotelId);
      if (!propertyId) return null;
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
      const metadata = metadataFromBody(body);
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

function toAddonItem(row: AddonItemRow, hotelId: string): BookingAddonItem {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const imageUrl = nullableString(metadata.imageUrl);
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
    duration,
    pricingModel: row.pricingModel,
    publicVisible: row.publicVisible,
    status: row.status,
    sortOrder,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function metadataFromBody(body: Partial<CreateBookingAddonItemBody>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if ("imageUrl" in body) metadata.imageUrl = body.imageUrl ?? null;
  if ("duration" in body) metadata.duration = body.duration ?? null;
  if ("sortOrder" in body) metadata.sortOrder = body.sortOrder ?? 0;
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
  const imageUrl = optionalNullableString(input, "imageUrl", details);
  const duration = optionalNullableString(input, "duration", details);
  const pricingModel = optionalEnum(input, "pricingModel", PRICING_MODELS, details) ?? "per_stay";
  const publicVisible = optionalBoolean(input, "publicVisible", details) ?? true;
  const status = optionalEnum(input, "status", WRITABLE_STATUSES, details) ?? "active";
  const sortOrder = optionalInteger(input, "sortOrder", details) ?? 0;
  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      name,
      description,
      price,
      currency,
      category: category as CreateBookingAddonItemBody["category"],
      imageUrl,
      duration,
      pricingModel: pricingModel as BookingAddonPricingModel,
      publicVisible,
      status: status as CreateBookingAddonItemBody["status"],
      sortOrder,
    },
  };
}

function parseUpdateBody(body: unknown): ValidationResult<UpdateBookingAddonItemBody> {
  const parsed = expectObject(body);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const details = unknownFields(input);
  if (Object.keys(input).length === 0) details.push("At least one add-on item field is required.");

  const value: UpdateBookingAddonItemBody = {};
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
  if ("imageUrl" in input) value.imageUrl = optionalNullableString(input, "imageUrl", details);
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
  if (details.length > 0) return { ok: false, details };
  return { ok: true, value };
}

const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "price",
  "currency",
  "category",
  "imageUrl",
  "duration",
  "pricingModel",
  "publicVisible",
  "status",
  "sortOrder",
]);

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
