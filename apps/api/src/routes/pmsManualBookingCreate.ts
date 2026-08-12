import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import { roundBookingPriceDecimalToMinorUnits } from "@vayada/domain-booking";
import {
  PMS_MANUAL_BOOKING_DIRECT_SOURCES,
  PMS_MANUAL_BOOKING_PAYMENT_METHODS,
  PmsManualBookingCreateError,
  type PmsManualBookingCreateCommand,
  type PmsManualBookingCreatePort,
} from "@vayada/domain-pms";
import { FinanceManualBookingSettlementError } from "@vayada/domain-finance";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { PreviewError } from "./pmsManualBookingPreviewCalculation.js";
import { parseManualBookingPreviewCommand } from "./pmsManualBookingPreview.js";
import { enforceRoutePolicy } from "./policy.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = z
  .string()
  .regex(UUID)
  .transform((value) => value.toLowerCase());
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableText = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();
const money = z.strictObject({
  amountDecimal: z.string().refine((value) => roundBookingPriceDecimalToMinorUnits(value) !== null),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const stay = z.strictObject({
  position: z.number().int().positive(),
  roomId: id,
  checkIn: z.string(),
  checkOut: z.string(),
  adults: z.number().int(),
  children: z.number().int(),
  ratePlanId: id.nullable(),
  pricing: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("rate_plan"), manualOverride: money.nullable() }),
    z.strictObject({ kind: z.literal("custom"), nightlyAmount: money }),
  ]),
});
const addon = z.strictObject({
  addonId: id,
  packageCount: z.number().int(),
  serviceUnits: z.array(
    z.strictObject({
      serviceDate: z.string().nullable(),
      guestCount: z.number().int().nullable(),
    }),
  ),
});
const bodySchema = z.strictObject({
  contractVersion: z.literal("pms-manual-booking.v1"),
  commandId: text(200),
  idempotencyKey: text(200),
  guest: z.strictObject({
    firstName: text(200),
    lastName: text(200),
    email: z.string().trim().email().max(320),
    phoneE164: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .nullable(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    specialRequests: nullableText(5_000),
  }),
  privateNote: nullableText(10_000),
  directSource: z.enum(PMS_MANUAL_BOOKING_DIRECT_SOURCES),
  stays: z.array(stay).min(1).max(20),
  addOns: z.array(addon).max(100),
  payment: z.strictObject({
    expectedMethod: z.enum(PMS_MANUAL_BOOKING_PAYMENT_METHODS),
    settlement: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("unpaid") }),
      z.strictObject({ status: z.literal("paid"), reference: nullableText(500) }),
    ]),
  }),
});

export type PmsManualBookingCreateRoutesOptions = {
  command: PmsManualBookingCreatePort;
};

export async function registerPmsManualBookingCreateRoutes(
  app: FastifyInstance,
  options: PmsManualBookingCreateRoutesOptions,
): Promise<void> {
  app.post<{ Params: { propertyId: string }; Body: unknown }>(
    "/properties/:propertyId/manual-bookings",
    async (request, reply) => {
      try {
        const scope = authorize(request, requestsPaidSettlement(request.body));
        const command = parseCreateCommand(request.body, scope);
        const result = await options.command.createManualBooking(command);
        return reply.status(result.outcome === "created" ? 201 : 200).send(result);
      } catch (error) {
        if (error instanceof UnauthorizedError)
          return reply
            .status(401)
            .send({ code: "unauthenticated", message: "Authentication required." });
        if (error instanceof AuthorizationError) {
          const entitlement = error.message.startsWith("Missing active entitlement");
          return reply.status(403).send({
            code: entitlement ? "entitlement_required" : "forbidden",
            message: entitlement ? "Active PMS entitlement required." : "Access forbidden.",
          });
        }
        if (error instanceof PmsManualBookingCreateError)
          return reply.status(statusFor(error.code)).send(errorBody(error));
        if (error instanceof PreviewError) return reply.status(error.status).send(error.body);
        if (
          error instanceof FinanceManualBookingSettlementError &&
          error.code === "idempotency_conflict"
        )
          return reply
            .status(409)
            .send({ code: "idempotency_conflict", message: "idempotency conflict." });
        request.log.error({ err: error }, "manual booking creation failed");
        return reply.status(500).send({
          code: "manual_booking_create_unavailable",
          message: "Manual booking creation is unavailable.",
        });
      }
    },
  );
}

function parseCreateCommand(value: unknown, scope: AuthorizedScope): PmsManualBookingCreateCommand {
  const raw = record(value);
  if (
    raw &&
    ["bookingChannel", "channel", "source", "directBookingSource"].some((key) => key in raw)
  )
    throw new PmsManualBookingCreateError("invalid_source", "directSource");
  if (
    raw &&
    (typeof raw["directSource"] !== "string" ||
      !PMS_MANUAL_BOOKING_DIRECT_SOURCES.includes(raw["directSource"] as never))
  )
    throw new PmsManualBookingCreateError("invalid_source", "directSource");
  const payment = record(raw?.["payment"]);
  if (
    payment &&
    (typeof payment["expectedMethod"] !== "string" ||
      !PMS_MANUAL_BOOKING_PAYMENT_METHODS.includes(payment["expectedMethod"] as never))
  )
    throw new PmsManualBookingCreateError("invalid_payment_method", "expectedMethod");
  const parsed = bodySchema.safeParse(value);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.code === "unrecognized_keys"))
      throw new PmsManualBookingCreateError("unknown_field");
    throw new PmsManualBookingCreateError("invalid_body");
  }
  const preview = parseManualBookingPreviewCommand({
    contractVersion: parsed.data.contractVersion,
    stays: parsed.data.stays,
    addOns: parsed.data.addOns,
  });
  return {
    ...parsed.data,
    stays: preview.stays.map(({ dates: _, ...selected }) => selected),
    addOns: preview.addOns,
    propertyId: scope.propertyId,
    organizationId: scope.organizationId,
    audit: scope.audit,
  };
}

type AuthorizedScope = {
  propertyId: string;
  organizationId: string;
  audit: PmsManualBookingCreateCommand["audit"];
};

function authorize(request: FastifyRequest, paid: boolean): AuthorizedScope {
  const base = enforceRoutePolicy(request, { permission: "pms.operations.manage" });
  const raw = (request.params as { propertyId?: unknown }).propertyId;
  if (base.selectedOrganization.kind !== "hotel_group")
    throw new PmsManualBookingCreateError("forbidden");
  if (typeof raw !== "string" || !UUID.test(raw))
    throw new PmsManualBookingCreateError("invalid_body", "propertyId");
  const propertyId = raw.toLowerCase();
  const resource = {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
  } as const;
  enforceRoutePolicy(request, {
    permission: "pms.operations.manage",
    entitlement: { product: "pms", key: "property-management", resource },
    resource: { ...resource, allowedRelationships: ["owner", "operator", "front_desk"] },
  });
  if (paid) enforcePaidPolicy(request, propertyId);
  return {
    propertyId,
    organizationId: base.selectedOrganization.organizationId,
    audit: {
      actor: {
        kind: "user",
        userId: base.actor.internalUserId,
        organizationId: base.selectedOrganization.organizationId,
      },
      requestId: base.audit.requestId,
      correlationId: base.audit.correlationId ?? null,
      requestedAt: base.audit.receivedAt,
    },
  };
}

function enforcePaidPolicy(request: FastifyRequest, propertyId: string): void {
  const resource = {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
  } as const;
  try {
    enforceRoutePolicy(request, {
      permission: "pms.finance.manage",
      entitlement: { product: "booking", key: "direct-booking-finance", resource },
      resource: { ...resource, allowedRelationships: ["owner", "finance_manager"] },
    });
  } catch (error) {
    if (error instanceof AuthorizationError)
      throw new PmsManualBookingCreateError("paid_forbidden");
    throw error;
  }
}

function requestsPaidSettlement(value: unknown): boolean {
  return (
    record(record(value)?.["payment"])?.["settlement"] != null &&
    record(record(record(value)?.["payment"])?.["settlement"])?.["status"] === "paid"
  );
}

function statusFor(code: string): 400 | 403 | 404 | 409 | 422 {
  if (code === "invalid_body" || code === "unknown_field") return 400;
  if (code === "forbidden" || code === "entitlement_required" || code === "paid_forbidden")
    return 403;
  if (code.endsWith("_not_found")) return 404;
  if (code === "room_unavailable" || code === "idempotency_conflict") return 409;
  return 422;
}

function errorBody(error: PmsManualBookingCreateError) {
  return {
    code: error.code,
    message: `${error.code.replaceAll("_", " ")}.`,
    ...(error.field ? { field: error.field } : {}),
    ...(error.stayPosition ? { stayPosition: error.stayPosition } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
