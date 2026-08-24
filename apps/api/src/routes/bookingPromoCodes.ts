import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type QueryResultRow } from "pg";

import { enforceRoutePolicy } from "./policy.js";

const DISCOUNT_TYPES = new Set(["percentage", "fixed"]);
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type BookingPromoDiscountType = "percentage" | "fixed";

export type BookingPromoCode = {
  promoCodeId: string;
  hotelId: string;
  propertyId: string;
  code: string;
  discountType: BookingPromoDiscountType;
  discountValue: string;
  minBookingValue: string | null;
  applicableRoomIds: string[] | null;
  validFrom: string | null;
  validUntil: string | null;
  stayDateFrom: string | null;
  stayDateUntil: string | null;
  isActive: boolean;
  maxUses: number;
  currentUses: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateBookingPromoCodeBody = {
  code: string;
  discountType: BookingPromoDiscountType;
  discountValue: string;
  minBookingValue: string | null;
  applicableRoomIds: string[] | null;
  validFrom: string | null;
  validUntil: string | null;
  stayDateFrom: string | null;
  stayDateUntil: string | null;
  isActive: boolean;
  maxUses: number;
};

export type UpdateBookingPromoCodeBody = Partial<CreateBookingPromoCodeBody>;

export type BookingPromoCodesRepository = {
  listPromoCodesByHotelId(hotelId: string): Promise<BookingPromoCode[] | null>;
  createPromoCodeByHotelId(
    hotelId: string,
    body: CreateBookingPromoCodeBody,
  ): Promise<BookingPromoCode | null>;
  updatePromoCodeByHotelId(
    hotelId: string,
    promoCodeId: string,
    body: UpdateBookingPromoCodeBody,
  ): Promise<BookingPromoCode | null>;
  retirePromoCodeByHotelId(hotelId: string, promoCodeId: string): Promise<boolean>;
  close?(): Promise<void>;
};

export type BookingPromoCodesPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{
    rows: T[];
  }>;
  end?(): Promise<void>;
};

type PromoCodesParams = {
  hotelId: string;
};

type PromoCodeParams = PromoCodesParams & {
  promoCodeId: string;
};

type BookingPromoCodesError = {
  statusCode: 401 | 403 | 404 | 409 | 422 | 500;
  code:
    | "unauthenticated"
    | "missing_permission"
    | "missing_entitlement"
    | "inactive_entitlement"
    | "missing_resource_access"
    | "invalid_payload"
    | "conflict"
    | "not_found"
    | "read_model_unavailable"
    | "write_model_unavailable";
  category: "authentication" | "authorization" | "validation" | "read_model" | "write_model";
  message: string;
  details?: unknown;
};

type ValidationResult<T> = { ok: true; value: T } | { ok: false; details: string[] };

export async function registerBookingPromoCodeRoutes(
  app: FastifyInstance,
  repository: BookingPromoCodesRepository,
): Promise<void> {
  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Params: PromoCodesParams }>("/hotels/:hotelId/promo-codes", async (request, reply) => {
    const { hotelId } = request.params;
    const accessError = authorize(request, hotelId);
    if (accessError) return sendPromoCodesError(reply, accessError);

    try {
      const promoCodes = await repository.listPromoCodesByHotelId(hotelId);
      if (!promoCodes) return sendPromoCodesError(reply, readNotFoundError());
      return { promoCodes };
    } catch {
      return sendPromoCodesError(reply, readUnavailableError());
    }
  });

  app.post<{ Params: PromoCodesParams; Body: unknown }>(
    "/hotels/:hotelId/promo-codes",
    async (request, reply) => {
      const { hotelId } = request.params;
      const accessError = authorize(request, hotelId);
      if (accessError) return sendPromoCodesError(reply, accessError);

      const parsed = parseCreateBody(request.body);
      if (!parsed.ok) return sendInvalidPayload(reply, parsed.details);

      try {
        const promoCode = await repository.createPromoCodeByHotelId(hotelId, parsed.value);
        if (!promoCode) return sendPromoCodesError(reply, writeNotFoundError());
        return reply.status(201).send(promoCode);
      } catch (error) {
        if (isUniqueViolation(error)) return sendPromoCodesError(reply, duplicateCodeError());
        if (isInvalidTargetPayloadError(error)) {
          return sendInvalidPayload(reply, [
            "Booking promo-code payload violates target constraints.",
          ]);
        }
        return sendPromoCodesError(reply, writeUnavailableError());
      }
    },
  );

  app.patch<{ Params: PromoCodeParams; Body: unknown }>(
    "/hotels/:hotelId/promo-codes/:promoCodeId",
    async (request, reply) => {
      const { hotelId, promoCodeId } = request.params;
      const accessError = authorize(request, hotelId);
      if (accessError) return sendPromoCodesError(reply, accessError);

      const parsed = parseUpdateBody(request.body);
      if (!parsed.ok) return sendInvalidPayload(reply, parsed.details);

      try {
        const currentPromoCodes = await repository.listPromoCodesByHotelId(hotelId);
        if (!currentPromoCodes) return sendPromoCodesError(reply, writeNotFoundError());
        const currentPromoCode = currentPromoCodes.find(
          (promoCode) => promoCode.promoCodeId === promoCodeId,
        );
        if (!currentPromoCode) return sendPromoCodesError(reply, writeNotFoundError());
        const effectiveDetails = validateEffectiveUpdate(currentPromoCode, parsed.value);
        if (effectiveDetails.length > 0) return sendInvalidPayload(reply, effectiveDetails);

        const promoCode = await repository.updatePromoCodeByHotelId(
          hotelId,
          promoCodeId,
          parsed.value,
        );
        if (!promoCode) return sendPromoCodesError(reply, writeNotFoundError());
        return promoCode;
      } catch (error) {
        if (isUniqueViolation(error)) return sendPromoCodesError(reply, duplicateCodeError());
        if (isInvalidTargetPayloadError(error)) {
          return sendInvalidPayload(reply, [
            "Booking promo-code payload violates target constraints.",
          ]);
        }
        return sendPromoCodesError(reply, writeUnavailableError());
      }
    },
  );

  app.delete<{ Params: PromoCodeParams }>(
    "/hotels/:hotelId/promo-codes/:promoCodeId",
    async (request, reply) => {
      const { hotelId, promoCodeId } = request.params;
      const accessError = authorize(request, hotelId);
      if (accessError) return sendPromoCodesError(reply, accessError);

      try {
        const retired = await repository.retirePromoCodeByHotelId(hotelId, promoCodeId);
        if (!retired) return sendPromoCodesError(reply, writeNotFoundError());
        return reply.status(204).send();
      } catch {
        return sendPromoCodesError(reply, writeUnavailableError());
      }
    },
  );
}

export function createPgTargetBookingPromoCodesRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingPromoCodesPool;
}): BookingPromoCodesRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Target booking promo codes repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  async function resolvePropertyId(hotelId: string): Promise<string | null> {
    const result = await pool.query<{ propertyId: string }>(
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
    async listPromoCodesByHotelId(hotelId) {
      const propertyId = await resolvePropertyId(hotelId);
      if (!propertyId) return null;
      const result = await pool.query<PromoCodeRow>(
        `${promoCodeSelectSql()}
         WHERE promo_definitions.property_id = $1
           AND promo_definitions.status <> 'retired'
         ORDER BY promo_definitions.created_at, promo_definitions.id`,
        [propertyId],
      );
      return result.rows.map((row) => toPromoCode(row, hotelId));
    },
    async createPromoCodeByHotelId(hotelId, body) {
      const propertyId = await resolvePropertyId(hotelId);
      if (!propertyId) return null;
      const result = await pool.query<PromoCodeRow>(
        `WITH inserted AS (
           INSERT INTO booking.promo_definitions (
             property_id, code, discount_type, discount_value, min_booking_value,
             applicable_room_ids, valid_from, valid_until, stay_date_from, stay_date_until,
             is_active, max_uses
           )
           VALUES (
             $1, $2, $3, $4::numeric, $5::numeric, $6::uuid[], $7::date, $8::date,
             $9::date, $10::date, $11, $12
           )
           RETURNING id
         )
         ${promoCodeSelectSql()}
         JOIN inserted ON inserted.id = promo_definitions.id`,
        [
          propertyId,
          body.code,
          body.discountType,
          body.discountValue,
          body.minBookingValue,
          body.applicableRoomIds,
          body.validFrom,
          body.validUntil,
          body.stayDateFrom,
          body.stayDateUntil,
          body.isActive,
          body.maxUses,
        ],
      );
      const row = result.rows[0];
      return row ? toPromoCode(row, hotelId) : null;
    },
    async updatePromoCodeByHotelId(hotelId, promoCodeId, body) {
      const propertyId = await resolvePropertyId(hotelId);
      if (!propertyId) return null;
      const values: unknown[] = [propertyId, promoCodeId];
      const sets: string[] = [];
      addSet(sets, values, "code", body.code);
      addSet(sets, values, "discount_type", body.discountType);
      addSet(sets, values, "discount_value", body.discountValue, "::numeric");
      addSet(sets, values, "min_booking_value", body.minBookingValue, "::numeric");
      addSet(sets, values, "applicable_room_ids", body.applicableRoomIds, "::uuid[]");
      addSet(sets, values, "valid_from", body.validFrom, "::date");
      addSet(sets, values, "valid_until", body.validUntil, "::date");
      addSet(sets, values, "stay_date_from", body.stayDateFrom, "::date");
      addSet(sets, values, "stay_date_until", body.stayDateUntil, "::date");
      addSet(sets, values, "is_active", body.isActive);
      addSet(sets, values, "max_uses", body.maxUses);
      sets.push("updated_at = now()");

      const result = await pool.query<PromoCodeRow>(
        `WITH updated AS (
           UPDATE booking.promo_definitions
           SET ${sets.join(", ")}
           WHERE property_id = $1 AND id::text = $2 AND status <> 'retired'
           RETURNING id
         )
         ${promoCodeSelectSql()}
         JOIN updated ON updated.id = promo_definitions.id`,
        values,
      );
      const row = result.rows[0];
      return row ? toPromoCode(row, hotelId) : null;
    },
    async retirePromoCodeByHotelId(hotelId, promoCodeId) {
      const propertyId = await resolvePropertyId(hotelId);
      if (!propertyId) return false;
      const result = await pool.query<{ id: string }>(
        `UPDATE booking.promo_definitions
         SET status = 'retired', is_active = false, updated_at = now()
         WHERE property_id = $1 AND id::text = $2 AND status <> 'retired'
         RETURNING id::text AS id`,
        [propertyId, promoCodeId],
      );
      return result.rows.length > 0;
    },
    async close() {
      await pool.end?.();
    },
  };
}

type PromoCodeRow = {
  promoCodeId: string;
  propertyId: string;
  code: string;
  discountType: BookingPromoDiscountType;
  discountValue: string;
  minBookingValue: string | null;
  applicableRoomIds: string[] | null;
  validFrom: Date | string | null;
  validUntil: Date | string | null;
  stayDateFrom: Date | string | null;
  stayDateUntil: Date | string | null;
  isActive: boolean;
  maxUses: number;
  currentUses: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function promoCodeSelectSql(): string {
  return `SELECT
    promo_definitions.id::text AS "promoCodeId",
    promo_definitions.property_id::text AS "propertyId",
    promo_definitions.code,
    promo_definitions.discount_type AS "discountType",
    promo_definitions.discount_value::text AS "discountValue",
    promo_definitions.min_booking_value::text AS "minBookingValue",
    promo_definitions.applicable_room_ids::text[] AS "applicableRoomIds",
    promo_definitions.valid_from AS "validFrom",
    promo_definitions.valid_until AS "validUntil",
    promo_definitions.stay_date_from AS "stayDateFrom",
    promo_definitions.stay_date_until AS "stayDateUntil",
    promo_definitions.is_active AS "isActive",
    promo_definitions.max_uses AS "maxUses",
    promo_definitions.current_uses AS "currentUses",
    promo_definitions.created_at AS "createdAt",
    promo_definitions.updated_at AS "updatedAt"
   FROM booking.promo_definitions`;
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

function toPromoCode(row: PromoCodeRow, hotelId: string): BookingPromoCode {
  return {
    promoCodeId: row.promoCodeId,
    hotelId,
    propertyId: row.propertyId,
    code: row.code,
    discountType: row.discountType,
    discountValue: row.discountValue,
    minBookingValue: row.minBookingValue,
    applicableRoomIds: row.applicableRoomIds,
    validFrom: toDateString(row.validFrom),
    validUntil: toDateString(row.validUntil),
    stayDateFrom: toDateString(row.stayDateFrom),
    stayDateUntil: toDateString(row.stayDateUntil),
    isActive: row.isActive,
    maxUses: row.maxUses,
    currentUses: row.currentUses,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function parseCreateBody(body: unknown): ValidationResult<CreateBookingPromoCodeBody> {
  const parsed = expectObject(body);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const details = unknownFields(input);
  const code = requiredCode(input, details);
  const discountType = requiredEnum(input, "discountType", DISCOUNT_TYPES, details);
  const discountValue = requiredDiscountValue(input, details);
  const minBookingValue = optionalMoney(input, "minBookingValue", details);
  const applicableRoomIds = optionalRoomIds(input, details);
  const validFrom = optionalDate(input, "validFrom", details);
  const validUntil = optionalDate(input, "validUntil", details);
  const stayDateFrom = optionalDate(input, "stayDateFrom", details);
  const stayDateUntil = optionalDate(input, "stayDateUntil", details);
  const isActive = optionalBoolean(input, "isActive", details) ?? true;
  const maxUses = requiredMaxUses(input, details);
  validateDiscount(discountType, discountValue, details);
  validateDateOrder(validFrom, validUntil, details);
  validateStayDateOrder(stayDateFrom, stayDateUntil, details);
  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      code,
      discountType: discountType as BookingPromoDiscountType,
      discountValue,
      minBookingValue,
      applicableRoomIds,
      validFrom,
      validUntil,
      stayDateFrom,
      stayDateUntil,
      isActive,
      maxUses,
    },
  };
}

function parseUpdateBody(body: unknown): ValidationResult<UpdateBookingPromoCodeBody> {
  const parsed = expectObject(body);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const details = unknownFields(input);
  if (Object.keys(input).length === 0) details.push("At least one promo-code field is required.");

  const value: UpdateBookingPromoCodeBody = {};
  if ("code" in input) value.code = requiredCode(input, details);
  if ("discountType" in input) {
    value.discountType = requiredEnum(
      input,
      "discountType",
      DISCOUNT_TYPES,
      details,
    ) as BookingPromoDiscountType;
  }
  if ("discountValue" in input) value.discountValue = requiredDiscountValue(input, details);
  if ("minBookingValue" in input) {
    value.minBookingValue = optionalMoney(input, "minBookingValue", details);
  }
  if ("applicableRoomIds" in input) {
    value.applicableRoomIds = optionalRoomIds(input, details);
  }
  if ("validFrom" in input) value.validFrom = optionalDate(input, "validFrom", details);
  if ("validUntil" in input) value.validUntil = optionalDate(input, "validUntil", details);
  if ("stayDateFrom" in input) {
    value.stayDateFrom = optionalDate(input, "stayDateFrom", details);
  }
  if ("stayDateUntil" in input) {
    value.stayDateUntil = optionalDate(input, "stayDateUntil", details);
  }
  if ("isActive" in input) value.isActive = requiredBoolean(input, "isActive", details);
  if ("maxUses" in input) value.maxUses = requiredMaxUses(input, details);
  if (details.length > 0) return { ok: false, details };
  return { ok: true, value };
}

function validateEffectiveUpdate(
  existing: BookingPromoCode,
  body: UpdateBookingPromoCodeBody,
): string[] {
  const details: string[] = [];
  const discountType = body.discountType ?? existing.discountType;
  const discountValue = body.discountValue ?? existing.discountValue;
  const validFrom = "validFrom" in body ? body.validFrom : existing.validFrom;
  const validUntil = "validUntil" in body ? body.validUntil : existing.validUntil;
  const stayDateFrom = "stayDateFrom" in body ? body.stayDateFrom : existing.stayDateFrom;
  const stayDateUntil = "stayDateUntil" in body ? body.stayDateUntil : existing.stayDateUntil;
  validateDiscount(discountType, discountValue, details);
  validateDateOrder(validFrom, validUntil, details);
  validateStayDateOrder(stayDateFrom, stayDateUntil, details);
  return details;
}

const KNOWN_FIELDS = new Set([
  "code",
  "discountType",
  "discountValue",
  "minBookingValue",
  "applicableRoomIds",
  "validFrom",
  "validUntil",
  "stayDateFrom",
  "stayDateUntil",
  "isActive",
  "maxUses",
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

function requiredCode(input: Record<string, unknown>, details: string[]): string {
  const value = requiredString(input, "code", details).toUpperCase();
  if (value && !/^[A-Z0-9_-]{2,40}$/.test(value)) {
    details.push("code must be 2-40 characters using letters, numbers, underscores, or hyphens.");
  }
  return value;
}

function requiredDiscountValue(input: Record<string, unknown>, details: string[]): string {
  const value = requiredString(input, "discountValue", details);
  if (value && !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    details.push("discountValue must be a positive decimal string.");
  } else if (Number(value) <= 0) {
    details.push("discountValue must be greater than zero.");
  } else if (!fitsNumericPrecision(value, 15, 2)) {
    details.push("discountValue must fit NUMERIC(15,2).");
  }
  return value;
}

function validateDiscount(
  discountType: string | undefined,
  discountValue: string | undefined,
  details: string[],
): void {
  if (discountType === "percentage" && discountValue && Number(discountValue) > 100) {
    details.push("percentage discountValue must be less than or equal to 100.");
  }
}

function requiredString(input: Record<string, unknown>, key: string, details: string[]): string {
  const value = input[key];
  if (typeof value !== "string") {
    details.push(`${key} must be a string.`);
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) details.push(`${key} is required.`);
  return trimmed;
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

function optionalDate(
  input: Record<string, unknown>,
  key: "validFrom" | "validUntil" | "stayDateFrom" | "stayDateUntil",
  details: string[],
): string | null {
  const value = input[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    details.push(`${key} must be a YYYY-MM-DD string.`);
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    details.push(`${key} must be a YYYY-MM-DD string.`);
  } else if (!isValidDateString(trimmed)) {
    details.push(`${key} must be a valid calendar date.`);
  }
  return trimmed;
}

function validateDateOrder(
  validFrom: string | null | undefined,
  validUntil: string | null | undefined,
  details: string[],
): void {
  if (validFrom && validUntil && validUntil < validFrom) {
    details.push("validUntil must be on or after validFrom.");
  }
}

function validateStayDateOrder(
  stayDateFrom: string | null | undefined,
  stayDateUntil: string | null | undefined,
  details: string[],
): void {
  if (stayDateFrom && stayDateUntil && stayDateUntil < stayDateFrom) {
    details.push("stayDateUntil must be on or after stayDateFrom.");
  }
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

function requiredMaxUses(input: Record<string, unknown>, details: string[]): number {
  const value = input.maxUses;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_POSTGRES_INTEGER
  ) {
    details.push(`maxUses must be an integer from 1 to ${MAX_POSTGRES_INTEGER}.`);
    return 1;
  }
  return value as number;
}

function optionalMoney(
  input: Record<string, unknown>,
  key: "minBookingValue",
  details: string[],
): string | null {
  if (!(key in input) || input[key] === null || input[key] === "") return null;
  const value = requiredString(input, key, details);
  if (value && !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    details.push(`${key} must be a positive decimal string.`);
  } else if (Number(value) <= 0) {
    details.push(`${key} must be greater than zero.`);
  } else if (!fitsNumericPrecision(value, 15, 2)) {
    details.push(`${key} must fit NUMERIC(15,2).`);
  }
  return value;
}

function optionalRoomIds(input: Record<string, unknown>, details: string[]): string[] | null {
  const value = input.applicableRoomIds;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    details.push("applicableRoomIds must be null or a non-empty array of room type IDs.");
    return null;
  }
  const ids = value.filter((item): item is string => typeof item === "string");
  if (
    ids.length !== value.length ||
    ids.some((id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    details.push("applicableRoomIds must contain unique UUID room type IDs.");
  }
  return ids;
}

function authorize(request: FastifyRequest, hotelId: string): BookingPromoCodesError | null {
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
  BookingPromoCodesError["code"],
  | "unauthenticated"
  | "invalid_payload"
  | "conflict"
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

function authorizationMessage(code: BookingPromoCodesError["code"]): string {
  if (code === "missing_permission") return "Missing required booking settings permission.";
  if (code === "missing_entitlement") return "Missing active booking engine entitlement.";
  if (code === "inactive_entitlement") return "Booking engine entitlement is not active.";
  return "Missing booking hotel access.";
}

function sendInvalidPayload(reply: FastifyReply, details: string[]): FastifyReply {
  return sendPromoCodesError(reply, {
    statusCode: 422,
    code: "invalid_payload",
    category: "validation",
    message: "Booking promo-code payload is invalid.",
    details,
  });
}

function duplicateCodeError(): BookingPromoCodesError {
  return {
    statusCode: 409,
    code: "conflict",
    category: "validation",
    message: "Booking promo-code already exists for this hotel.",
  };
}

function readNotFoundError(): BookingPromoCodesError {
  return {
    statusCode: 404,
    code: "not_found",
    category: "read_model",
    message: "Booking promo-code target not found.",
  };
}

function writeNotFoundError(): BookingPromoCodesError {
  return {
    statusCode: 404,
    code: "not_found",
    category: "write_model",
    message: "Booking promo-code target not found.",
  };
}

function readUnavailableError(): BookingPromoCodesError {
  return {
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    message: "Booking promo codes could not be loaded.",
  };
}

function writeUnavailableError(): BookingPromoCodesError {
  return {
    statusCode: 500,
    code: "write_model_unavailable",
    category: "write_model",
    message: "Booking promo codes could not be saved.",
  };
}

function sendPromoCodesError(reply: FastifyReply, error: BookingPromoCodesError): FastifyReply {
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

function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "23505";
}

function isInvalidTargetPayloadError(error: unknown): boolean {
  return isRecord(error) && (error.code === "23514" || error.code === "22003");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fitsNumericPrecision(value: string, precision: number, scale: number): boolean {
  const [whole = "", fraction = ""] = value.split(".");
  const wholeDigits = whole.replace(/^0+/, "").length;
  return wholeDigits <= precision - scale && fraction.length <= scale;
}

function isValidDateString(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toDateString(value: Date | string | null): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
