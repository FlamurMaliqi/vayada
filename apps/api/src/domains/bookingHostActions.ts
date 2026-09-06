import { hostPolicyImpact, type HostPolicyImpact } from "./bookingHostPolicyImpact.js";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { targetBookingHostActionPrimitives as bookingOwner } from "../routes/bookingWebPublic.js";
import {
  hostBookingActionConflict,
  type HostBookingAction,
  type HostBookingConflict,
} from "./bookingHostActionEligibility.js";
import type { BookingHostActionGuards } from "./bookingHostActionGuards.js";
import {
  inventoryReservationReceiptFromBookingMetadata,
  type DirectBookingInventoryReservationPort,
} from "../platform/inventoryReservation.js";
import { captureDirectNightlyRevenueEvidence } from "./stripeBookingSettlement.js";
import { enqueueBookingTransitionNotifications } from "../jobs/bookingEmails.js";

export type HostActionRequest = {
  action: HostBookingAction;
  checkIn?: string;
  checkOut?: string;
  reason: string;
  guestMessage?: string;
};
export type HostActionScope = { propertyId: string; bookingId: string; actorUserId: string };
export type HostActionImpact = {
  action: HostBookingAction;
  pricingFingerprint: string;
  checkIn: string;
  checkOut: string;
  totalAmount: string;
  newTotalAmount: string;
  currency: string;
  cancellationPolicy: HostPolicyImpact | null;
  oldPolicy: Record<string, unknown>;
  newPolicy: Record<string, unknown>;
  inventory: "release" | "replace";
  payment: "no_payment_received" | "authorization_void";
};
export type HostActionPreview = {
  previewId: string;
  expiresAt: string;
  impact: HostActionImpact;
};
export type HostActionResult = { bookingId: string; lifecycleStatus: string };
export type BookingHostActions = {
  preview(scope: HostActionScope, request: HostActionRequest): Promise<HostActionPreview>;
  findAction(scope: HostActionScope, previewId: string): Promise<HostBookingAction | null>;
  apply(
    scope: HostActionScope,
    previewId: string,
    idempotencyKey: string,
  ): Promise<HostActionResult>;
  close(): Promise<void>;
};
export class HostActionError extends Error {
  readonly statusCode = 409;
  constructor(
    readonly code: HostBookingConflict["code"],
    message: string,
  ) {
    super(message);
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (value: unknown) =>
  createHash("sha256").update(bookingOwner.stableJson(value)).digest("hex");

export function createBookingHostActions(config: {
  pool: pg.Pool;
  inventory: DirectBookingInventoryReservationPort;
  guards: BookingHostActionGuards;
  now?: () => Date;
}): BookingHostActions {
  const now = config.now ?? (() => new Date());
  const inspect = async (
    client: pg.PoolClient,
    scope: HostActionScope,
    request: HostActionRequest,
    at: Date,
  ) => {
    await config.guards.lockInventory(client, scope.propertyId);
    const booking = await bookingOwner.loadBooking(client, scope.propertyId, scope.bookingId, true);
    const metadata = object(booking.bookingMetadata);
    const offer = object(metadata["selectedOffer"]);
    const conflict = hostBookingActionConflict(request.action, {
      ...booking,
      paymentMethod:
        typeof metadata["paymentMethod"] === "string" ? metadata["paymentMethod"] : null,
      acceptanceMode:
        typeof metadata["acceptanceMode"] === "string" ? metadata["acceptanceMode"] : null,
      operationalStayStarted: await config.guards.stayStarted(
        client,
        scope.propertyId,
        scope.bookingId,
      ),
      hasPurchasedAddons:
        Array.isArray(offer["addonPurchases"]) && offer["addonPurchases"].length > 0,
    });
    if (conflict) throw new HostActionError(conflict.code, conflict.message);
    const payment = await config.guards.payment(client, {
      ...scope,
      action: request.action,
      apply: false,
      occurredAt: at,
      authorized: booking.paymentStatus === "authorized",
    });
    const property = await bookingOwner.loadProperty(client, scope.propertyId);
    const reservation = inventoryReservationReceiptFromBookingMetadata(
      booking.bookingMetadata,
      scope.propertyId,
    );
    if (!reservation)
      throw new HostActionError(
        "inventory_unavailable",
        "The booking inventory receipt is unavailable.",
      );
    const dates =
      request.action === "edit_dates"
        ? await bookingOwner.previewDates(client, config.inventory, property, booking, request, at)
        : null;
    if (dates?.blocked)
      throw new HostActionError(
        "inventory_unavailable",
        dates.blockReason ?? "These dates are unavailable.",
      );
    const newOffer = dates
      ? {
          ...object(dates.pricingSnapshot?.["selectedOffer"]),
          publicPolicy: offer["publicPolicy"],
          policySnapshot: offer["policySnapshot"],
          rateSummary: offer["rateSummary"],
        }
      : offer;
    const frozenPolicy = object(metadata["policySnapshot"]);
    const cancellationPolicy = hostPolicyImpact(
      frozenPolicy,
      {
        ...object(offer["rateSummary"]),
        rateType: offer["rateType"] ?? object(offer["rateSummary"])["rateType"],
      },
      booking.checkIn,
      dates?.requestedCheckIn ?? booking.checkIn,
      property.timezone,
    );
    if (dates && !cancellationPolicy)
      throw new HostActionError(
        "unsupported_edit",
        "The booked cancellation terms cannot be previewed for a date change.",
      );
    const impact: HostActionImpact = {
      action: request.action,
      pricingFingerprint: hash(
        dates
          ? {
              nightly: newOffer["nightlyRoomAmounts"],
              promotion: newOffer["promotion"],
              roomTotal: dates.pricingSnapshot?.["roomTotal"],
              taxesAndFees: dates.pricingSnapshot?.["taxesAndFees"],
              discounts: dates.pricingSnapshot?.["discounts"],
              promotionDiscount: dates.pricingSnapshot?.["promotionDiscount"],
            }
          : null,
      ),
      checkIn: dates?.requestedCheckIn ?? booking.checkIn,
      checkOut: dates?.requestedCheckOut ?? booking.checkOut,
      totalAmount: Number(booking.totalAmount).toFixed(2),
      newTotalAmount: dates ? dates.newTotal.toFixed(2) : Number(booking.totalAmount).toFixed(2),
      currency: booking.currency,
      cancellationPolicy,
      oldPolicy: frozenPolicy,
      newPolicy: frozenPolicy,
      inventory: dates ? "replace" : "release",
      payment,
    };
    return { booking, property, reservation, dates, newOffer, impact, revision: hash(booking) };
  };
  return {
    async findAction(scope, previewId) {
      const row = await config.pool.query<{ action: HostBookingAction }>(
        `SELECT action FROM booking.host_action_previews WHERE id=$1::uuid AND property_id=$2::uuid AND guest_booking_id=$3::uuid AND actor_user_id=$4::uuid`,
        [previewId, scope.propertyId, scope.bookingId, scope.actorUserId],
      );
      return row.rows[0]?.action ?? null;
    },
    async close() {
      await config.pool.end();
    },
    async preview(scope, request) {
      const at = now();
      return bookingOwner.transaction(config.pool, async (client) => {
        const state = await inspect(client, scope, request, at);
        const previewId = randomUUID();
        const expiresAt = new Date(at.getTime() + 600_000).toISOString();
        await client.query(
          `INSERT INTO booking.host_action_previews
           (id,property_id,guest_booking_id,actor_user_id,booking_revision,action,request,impact,created_at,expires_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8::jsonb,$9::timestamptz,$10::timestamptz)`,
          [
            previewId,
            scope.propertyId,
            scope.bookingId,
            scope.actorUserId,
            state.revision,
            request.action,
            JSON.stringify(request),
            JSON.stringify(state.impact),
            at.toISOString(),
            expiresAt,
          ],
        );
        return { previewId, expiresAt, impact: state.impact };
      });
    },
    async apply(scope, previewId, idempotencyKey) {
      const at = now();
      const context = {
        operation: "booking.host-action",
        actorUserId: scope.actorUserId,
        requestId: previewId,
        correlationId: previewId,
        idempotencyKey,
        fingerprint: hash({ ...scope, previewId }),
        occurredAt: at,
      };
      return bookingOwner.transaction(config.pool, async (client) => {
        const command = await bookingOwner.reserveCommand(client, scope.propertyId, context);
        if (command.status === "replay") return command.body as HostActionResult;
        const saved = await client.query<{
          request: HostActionRequest;
          impact: HostActionImpact;
          revision: string;
          expiresAt: Date;
        }>(
          `SELECT request,impact,booking_revision AS revision,expires_at AS "expiresAt"
           FROM booking.host_action_previews WHERE id=$1::uuid AND property_id=$2::uuid
             AND guest_booking_id=$3::uuid AND actor_user_id=$4::uuid`,
          [previewId, scope.propertyId, scope.bookingId, scope.actorUserId],
        );
        const preview = saved.rows[0];
        if (!preview || new Date(preview.expiresAt).getTime() <= at.getTime())
          throw new HostActionError(
            "stale_preview",
            "Preview expired or unavailable. Preview this action again.",
          );
        const state = await inspect(client, scope, preview.request, at);
        if (state.revision !== preview.revision || hash(state.impact) !== hash(preview.impact))
          throw new HostActionError(
            "stale_preview",
            "The booking or its impact changed. Preview this action again.",
          );
        await config.guards.payment(client, {
          ...scope,
          action: preview.request.action,
          apply: true,
          occurredAt: at,
          authorized: state.booking.paymentStatus === "authorized",
        });
        const amendment = state.dates
          ? await config.guards.prepareDateEdit(client, {
              ...scope,
              previewId,
              receipt: state.reservation,
              occurredAt: at,
            })
          : null;
        await config.inventory.release({
          transaction: client,
          propertyId: scope.propertyId,
          reservation: state.reservation,
          occurredAt: at,
        });
        let updated = state.booking;
        if (state.dates) {
          const reservation = await config.inventory.reserve({
            transaction: client,
            propertyId: scope.propertyId,
            quoteSessionId: `host-edit:${previewId}`,
            roomTypeId: String(state.newOffer["roomTypeId"]),
            publicOfferKey: String(state.newOffer["publicOfferKey"]),
            checkIn: state.dates.requestedCheckIn,
            checkOut: state.dates.requestedCheckOut,
            roomCount: state.booking.roomCount,
            currency: state.booking.currency,
            occurredAt: at,
          });
          if (!reservation)
            throw new HostActionError(
              "inventory_unavailable",
              "The requested dates are no longer available.",
            );
          updated = await bookingOwner.applyDates(client, {
            booking: state.booking,
            changeRequest: { id: previewId, hostEdit: true },
            preview: state.dates,
            selectedOffer: state.newOffer,
            inventoryReservation: { ...reservation },
            context,
          });
          await config.guards.completeDateEdit(client, {
            ...scope,
            previewId,
            previous: amendment,
            receipt: reservation,
            checkIn: state.dates.requestedCheckIn,
            checkOut: state.dates.requestedCheckOut,
            occurredAt: at,
          });
        } else {
          const status = preview.request.action === "reject" ? "declined" : "canceled";
          await client.query(
            `WITH updated AS (
              UPDATE booking.guest_bookings SET lifecycle_status=$3,balance_amount=0,payment_status=CASE WHEN payment_status='authorized' THEN 'failed' ELSE payment_status END,cancellation_reason='property_cancellation',updated_at=$4::timestamptz
              WHERE id=$1::uuid AND property_id=$2::uuid RETURNING id,payment_status
             ), event AS (
              INSERT INTO booking.booking_status_events
                (guest_booking_id,event_type,from_status,to_status,actor_type,actor_user_id,public_visible,public_message,event_payload,occurred_at)
              SELECT id,$5,$6,$3,'property_user',$7::uuid,true,'Booking updated.','{}'::jsonb,$4::timestamptz FROM updated
             ) UPDATE booking.direct_booking_summary_read_model SET lifecycle_status=$3,payment_status=(SELECT payment_status FROM updated),amount_summary=jsonb_set(amount_summary,'{balanceAmount}','0'::jsonb),projected_at=$4::timestamptz
               WHERE guest_booking_id=(SELECT id FROM updated)`,
            [
              scope.bookingId,
              scope.propertyId,
              status,
              at.toISOString(),
              `guest_booking.${status}`,
              state.booking.lifecycleStatus,
              scope.actorUserId,
            ],
          );
          updated = {
            ...state.booking,
            lifecycleStatus: status,
            balanceAmount: "0.00",
            paymentStatus:
              state.booking.paymentStatus === "authorized" ? "failed" : state.booking.paymentStatus,
          };
          await bookingOwner.reversePromo(client, scope.propertyId, scope.bookingId, at);
        }
        if (!state.dates)
          await config.guards.cancelAssignments(client, {
            ...scope,
            previewId,
            fingerprint: context.fingerprint,
            occurredAt: at,
          });
        await captureDirectNightlyRevenueEvidence(client, updated, {
          ...(state.dates ? { selectedOffer: state.newOffer } : { clear: true }),
          fingerprint: context.fingerprint,
          recognizedOn: bookingOwner.propertyDate(state.property.timezone, at),
          required: true,
        });
        await bookingOwner.handoff(
          client,
          scope.propertyId,
          updated,
          context,
          state.dates ? "update" : "cancel",
          { revision: previewId, actorType: "property_user" },
        );
        await enqueueBookingTransitionNotifications(client, {
          propertyId: scope.propertyId,
          guestBookingId: scope.bookingId,
          occurredAt: at.toISOString(),
          correlationId: previewId,
          causationId: previewId,
          actor: { type: "user", userId: scope.actorUserId },
          source: "apps/api-booking-host-actions",
          guestMessage: preview.request.guestMessage,
          transition: {
            revision: state.dates ? previewId : undefined,
            eventType: state.dates
              ? "guest_booking.host_dates_updated"
              : `guest_booking.${updated.lifecycleStatus}`,
            fromStatus: state.booking.lifecycleStatus,
            toStatus: updated.lifecycleStatus,
            reason: "property_cancellation",
          },
        });
        const body = { bookingId: scope.bookingId, lifecycleStatus: updated.lifecycleStatus };
        await bookingOwner.recordCommand(client, {
          propertyId: scope.propertyId,
          context: {
            ...context,
            privateAuditPayload: { reason: preview.request.reason, previewId },
          },
          resourceType: "guest_booking",
          resourceId: scope.bookingId,
          body,
        });
        return body;
      });
    },
  };
}
