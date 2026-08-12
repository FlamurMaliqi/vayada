import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import { roundBookingPriceDecimalToMinorUnits } from "@vayada/domain-booking";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  calculateManualBookingPreview,
  fail,
  invalid,
  PreviewError,
  type ManualBookingPreviewCommand,
  type ManualBookingPreviewResult,
  type PmsManualBookingPreviewRoutesOptions,
} from "./pmsManualBookingPreviewCalculation.js";
import { enforceRoutePolicy } from "./policy.js";

export type { ManualBookingPreviewResult, PmsManualBookingPreviewRoutesOptions };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const id = z
  .string()
  .regex(UUID)
  .transform((value) => value.toLowerCase());
const moneyInput = z.strictObject({
  amountDecimal: z.string().refine((value) => roundBookingPriceDecimalToMinorUnits(value) !== null),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const unitInput = z.strictObject({
  serviceDate: z.string().nullable(),
  guestCount: z.number().int().nullable(),
});
const stayInput = z.strictObject({
  position: z.number().int().positive(),
  roomId: id,
  checkIn: z.string(),
  checkOut: z.string(),
  adults: z.number().int(),
  children: z.number().int(),
  ratePlanId: id.nullable(),
  pricing: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("rate_plan"), manualOverride: moneyInput.nullable() }),
    z.strictObject({ kind: z.literal("custom"), nightlyAmount: moneyInput }),
  ]),
});
const selectionInput = z.strictObject({
  addonId: id,
  packageCount: z.number().int(),
  serviceUnits: z.array(unitInput),
});
const commandInput = z.strictObject({
  contractVersion: z.literal("pms-manual-booking.v1"),
  stays: z.array(stayInput).min(1).max(20),
  addOns: z.array(selectionInput),
});

export async function registerPmsManualBookingPreviewRoutes(
  app: FastifyInstance,
  ports: PmsManualBookingPreviewRoutesOptions,
): Promise<void> {
  app.post<{ Params: { propertyId: string }; Body: unknown }>(
    "/properties/:propertyId/manual-bookings/preview",
    async (request, reply) => {
      try {
        return reply.send(
          await calculateManualBookingPreview(
            authorize(request),
            parseCommand(request.body),
            ports,
          ),
        );
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
        if (error instanceof PreviewError) return reply.status(error.status).send(error.body);
        request.log.error({ err: error }, "manual booking preview failed");
        return reply
          .status(500)
          .send({ code: "manual_booking_preview_unavailable", message: "Preview is unavailable." });
      }
    },
  );
}

function parseCommand(value: unknown): ManualBookingPreviewCommand {
  const parsed = commandInput.safeParse(value);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.code === "unrecognized_keys"))
      fail(400, "unknown_field");
    invalid();
  }
  const stays = parsed.data.stays
    .map((stay) => {
      const dates = datesBetween(stay.checkIn, stay.checkOut);
      if (!dates) fail(422, "invalid_dates", "stays", stay.position);
      if (stay.adults < 1 || stay.children < 0)
        fail(422, "occupancy_exceeded", "stays", stay.position);
      if (
        (stay.pricing.kind === "custom" && stay.ratePlanId !== null) ||
        (stay.pricing.kind === "rate_plan" && stay.ratePlanId === null)
      )
        invalid();
      return { ...stay, dates };
    })
    .sort((a, b) => a.position - b.position);
  if (stays.some((stay, index) => stay.position !== index + 1)) invalid();
  const addOns = parsed.data.addOns;
  if (
    addOns.some(
      (selection) =>
        selection.packageCount < 1 ||
        selection.serviceUnits.some((unit) => unit.guestCount !== null && unit.guestCount < 1),
    )
  )
    fail(422, "invalid_addon_selection", "addOns");
  if (new Set(addOns.map((item) => item.addonId)).size !== addOns.length)
    fail(422, "invalid_addon_selection", "addOns");
  if (
    addOns.some((selection) =>
      selection.serviceUnits.some(
        (unit) => unit.serviceDate !== null && !validDate(unit.serviceDate),
      ),
    )
  )
    fail(422, "invalid_addon_selection", "serviceUnits");
  return { contractVersion: parsed.data.contractVersion, stays, addOns };
}

function authorize(request: FastifyRequest): { propertyId: string; organizationId: string } {
  const base = enforceRoutePolicy(request, { permission: "pms.operations.manage" });
  const raw = (request.params as { propertyId?: unknown }).propertyId;
  if (base.selectedOrganization.kind !== "hotel_group") fail(403, "forbidden");
  if (typeof raw !== "string" || !UUID.test(raw)) fail(400, "invalid_body", "propertyId");
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
  return { propertyId, organizationId: base.selectedOrganization.organizationId };
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value;
}
function datesBetween(from: unknown, to: unknown): string[] | null {
  if (!validDate(from) || !validDate(to)) return null;
  const start = Date.parse(`${from}T00:00:00Z`),
    count = (Date.parse(`${to}T00:00:00Z`) - start) / DAY;
  return Number.isInteger(count) && count >= 1 && count <= 370
    ? Array.from({ length: count }, (_, index) =>
        new Date(start + index * DAY).toISOString().slice(0, 10),
      )
    : null;
}
