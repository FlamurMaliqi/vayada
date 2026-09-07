import { createTargetMixedCheckoutQuote } from "./bookingWebMixedSnapshot.js";
import { authorize, editable, requireRevision, guestInput } from "./pendingBookingEditAccess.js";
import {
  preparePendingEditAttempt,
  authorizePendingEditAttempt,
  type PendingBookingEditAttempt as Attempt,
} from "./pendingBookingEditAttempts.js";
import {
  verifyPendingEditPayment,
  commitPendingEditPayment,
} from "./pendingBookingEditPayments.js";
import {
  lockPendingPmsHandoff,
  applyPendingPmsRevision,
} from "../domains/pmsPendingBookingRevision.js";
import type pg from "pg";
import { enqueueBookingTransitionNotifications } from "../jobs/bookingEmails.js";
import { inventoryReservationReceiptFromBookingMetadata } from "../platform/inventoryReservation.js";
import {
  assertTargetCheckoutConfigMatchesQuote,
  createHttpError,
  createTargetCheckoutQuote,
  createTargetGuestBooking,
  enqueuePmsReservationHandoff,
  issueTargetBookingConfirmationToken,
  loadTargetBooking,
  loadTargetCheckoutConfig,
  loadTargetCheckoutQuoteSnapshot,
  objectValue,
  recordTargetCheckoutCommand,
  reserveTargetCheckoutCommand,
  redeemTargetPromo,
  reverseTargetPromoRedemption,
  resolveTargetGuestPhone,
  serializeTargetBooking,
  serializeTargetCheckoutQuote,
  stringValue,
  sha256Hex,
  targetInventoryAvailabilityCredit,
  withTargetCheckoutTransaction,
  type BookingWebCheckoutCommandContext,
  type BookingWebCheckoutRequest,
  type PgTargetBookingWebCheckoutAdapterConfig,
} from "./bookingWebPublic.js";

export async function pendingBookingEdit(
  pool: pg.Pool,
  config: PgTargetBookingWebCheckoutAdapterConfig,
  slug: string,
  bookingId: string,
  action: string,
  request: BookingWebCheckoutRequest,
  context: BookingWebCheckoutCommandContext,
): Promise<unknown> {
  const assertSelectionEnabled = (input: Record<string, unknown>) => {
    if (!config.mixedRoomSelectionsEnabled && input["roomSelection"] !== undefined)
      throw createHttpError(409, "Mixed room booking edits are not available yet.");
  };
  const result = await withTargetCheckoutTransaction(pool, async (client) => {
    let now = config.now?.() ?? new Date();
    const { property, booking: canonical } = await authorize(
      client,
      slug,
      bookingId,
      request,
      () => config.now?.() ?? new Date(),
    );
    now = config.now?.() ?? new Date();
    // A committed save remains replayable after hotel acceptance, but still requires the credential.
    if (action === "save") {
      const replay = await reserveTargetCheckoutCommand(client, property.propertyId, context);
      if (replay.status === "replay") return replay.body;
    }
    const booking = await editable(client, canonical, now);
    await lockPendingPmsHandoff(client, property.propertyId, booking.guestBookingId);
    const selected = objectValue(objectValue(booking.bookingMetadata)["selectedOffer"]);
    assertSelectionEnabled(selected);
    assertSelectionEnabled(request);
    if (action === "details") {
      const guest = (
        await client.query(
          `SELECT special_requests,arrival_time FROM booking.booking_guests
        WHERE guest_booking_id=$1::uuid AND guest_role='booker'`,
          [booking.guestBookingId],
        )
      ).rows[0];
      return {
        booking: serializeTargetBooking(booking),
        revision: booking.editRevision,
        input: await guestInput(client, booking, {
          roomTypeId: selected["roomTypeId"],
          ...(selected["roomSelection"] ? { roomSelection: selected["roomSelection"] } : {}),
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          adults: booking.adults,
          children: booking.children,
          numberOfRooms: booking.roomCount,
          rateType: selected["rateType"],
          currency: booking.currency,
          paymentMethod: objectValue(booking.bookingMetadata)["paymentMethod"],
          promoCode: objectValue(selected["promo"])["code"],
          ...objectValue(selected["addonRequest"]),
          specialRequests: guest?.special_requests ?? "",
          estimatedArrivalTime: guest?.arrival_time ?? "",
        }),
      };
    }
    requireRevision(booking, request["revision"]);
    const input = await guestInput(client, booking, request);
    if (action === "quote" || action === "prepare") {
      for (const [key, minimum] of [
        ["adults", 1],
        ["children", 0],
        ["numberOfRooms", 1],
      ] as const) {
        const value = input[key] ?? (key === "numberOfRooms" ? 1 : undefined);
        if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > 100)
          throw createHttpError(400, `Invalid ${key}.`);
      }
      if (typeof input["specialRequests"] === "string" && input["specialRequests"].length > 2000)
        throw createHttpError(400, "Special requests must be 2000 characters or fewer.");
    }
    if (action === "quote") {
      const credits = await config.inventoryReservationPort.selectionAvailabilityCredits?.({
        transaction: client,
        propertyId: property.propertyId,
        guestBookingId: booking.guestBookingId,
      });
      const credit =
        credits?.get(String(input["roomTypeId"])) ??
        (input["roomTypeId"] === selected["roomTypeId"]
          ? await targetInventoryAvailabilityCredit(
              config.inventoryReservationPort,
              client,
              booking,
              property.propertyId,
              String(selected["roomTypeId"]),
              String(selected["publicOfferKey"]),
            )
          : undefined);
      const edit = {
        bookingId: booking.guestBookingId,
        revision: booking.editRevision,
        availabilityCredit: credit,
      };
      const quote =
        input["roomSelection"] !== undefined
          ? await createTargetMixedCheckoutQuote(client, property, input, now, edit, credits)
          : await createTargetCheckoutQuote(client, property, input, now, edit);
      return serializeTargetCheckoutQuote(quote);
    }
    if (action === "prepare")
      return preparePendingEditAttempt(client, config, property, booking, input, context, now);
    if (action !== "save") throw createHttpError(404, "Booking action not found.");
    const attempt = (
      await client.query<Attempt>(
        `SELECT * FROM booking.pending_booking_edit_attempts
      WHERE id::text=$1 AND guest_booking_id=$2::uuid AND property_id=$3::uuid FOR UPDATE`,
        [request["attemptId"], booking.guestBookingId, property.propertyId],
      )
    ).rows[0];
    if (!attempt || attempt.status !== "prepared" || attempt.expires_at.getTime() <= now.getTime())
      throw createHttpError(409, "The edit expired. Review the request and try again.");
    requireRevision(booking, attempt.expected_revision);
    const savedInput = attempt.request_snapshot;
    assertSelectionEnabled(savedInput);
    const quote = await loadTargetCheckoutQuoteSnapshot(
      client,
      property.propertyId,
      savedInput,
      now,
    );
    const settings = await loadTargetCheckoutConfig(client, property.propertyId);
    assertTargetCheckoutConfigMatchesQuote(settings, quote);
    const authorizedIntent = await verifyPendingEditPayment(
      client,
      config,
      property,
      booking,
      attempt,
      quote,
    );
    now = config.now?.() ?? new Date();
    await editable(client, booking, now);
    const receipt = inventoryReservationReceiptFromBookingMetadata(
      booking.bookingMetadata,
      property.propertyId,
    );
    if (!receipt) throw createHttpError(409, "This request's inventory cannot be edited online.");
    await config.inventoryReservationPort.release({
      transaction: client,
      propertyId: property.propertyId,
      reservation: receipt,
      occurredAt: now,
      requireReserved: true,
    });
    const billing = await config
      .billingConfigReadPortFactory?.(client)
      .getBillingConfig(property.propertyId);
    const updated = await createTargetGuestBooking(
      client,
      config.inventoryReservationPort,
      property,
      savedInput,
      { ...context, occurredAt: now },
      quote,
      await resolveTargetGuestPhone(client, property.propertyId, savedInput),
      billing ?? null,
      settings,
      booking,
    );
    await reverseTargetPromoRedemption(client, property.propertyId, booking.guestBookingId, now);
    await redeemTargetPromo(client, property, updated, quote, now);
    await client.query(
      `UPDATE booking.booking_guests SET special_requests=$2,arrival_time=$3,updated_at=$4
      WHERE guest_booking_id=$1::uuid AND guest_role='booker'`,
      [
        booking.guestBookingId,
        stringValue(savedInput["specialRequests"]),
        stringValue(savedInput["estimatedArrivalTime"]),
        now,
      ],
    );
    const paymentId = await commitPendingEditPayment(
      client,
      property,
      booking,
      attempt,
      quote,
      authorizedIntent,
      now,
    );
    updated.paymentStatus = authorizedIntent ? "authorized" : "unpaid";
    await client.query(
      `UPDATE booking.guest_bookings SET active_card_payment_id=$2,payment_status=$3,
        booking_metadata=booking_metadata || jsonb_build_object('providerPaymentIntentId',$4::text)
      WHERE id=$1::uuid`,
      [
        booking.guestBookingId,
        paymentId,
        updated.paymentStatus,
        authorizedIntent?.paymentIntentId ?? null,
      ],
    );
    await client.query(
      `UPDATE booking.direct_booking_summary_read_model SET payment_status=$2 WHERE guest_booking_id=$1::uuid`,
      [booking.guestBookingId, updated.paymentStatus],
    );
    await client.query(
      "DELETE FROM finance.bank_transfer_bookings WHERE guest_booking_id=$1::uuid",
      [booking.guestBookingId],
    );
    if (attempt.payment_method === "bank_transfer") {
      if (!config.bankTransfers) throw createHttpError(503, "Bank transfer is unavailable.");
      await config.bankTransfers.bind(client, property.propertyId, booking.guestBookingId);
    }
    await client.query(
      `UPDATE booking.pending_booking_edit_attempts SET status='committed',committed_at=$2,
      updated_at=$2,request_snapshot='{}'::jsonb WHERE id=$1`,
      [attempt.id, now],
    );
    await enqueuePmsReservationHandoff(client, property.propertyId, updated, context, "update", {
      revision: String(booking.editRevision + 1),
    });
    await applyPendingPmsRevision(
      client,
      property.propertyId,
      booking.guestBookingId,
      booking.editRevision + 1,
      now,
    );
    await enqueueBookingTransitionNotifications(client, {
      propertyId: property.propertyId,
      guestBookingId: booking.guestBookingId,
      occurredAt: now.toISOString(),
      correlationId: context.correlationId,
      causationId: context.requestId,
      transition: {
        eventType: "guest_booking.request_updated",
        fromStatus: "pending_payment",
        toStatus: "pending_payment",
        reason: String(booking.editRevision + 1),
      },
    });
    const confirmation = await issueTargetBookingConfirmationToken(client, updated, now);
    const body = {
      booking: serializeTargetBooking(
        await loadTargetBooking(
          client,
          property.propertyId,
          booking.guestBookingId,
          null,
          sha256Hex(String(request["confirmationToken"])),
        ),
      ),
      confirmationToken: confirmation.token,
      bookingReference: booking.publicReference,
      paymentMethod: attempt.payment_method,
    };
    await recordTargetCheckoutCommand(client, {
      propertyId: property.propertyId,
      context,
      resourceType: "guest_booking",
      resourceId: booking.guestBookingId,
      body,
    });
    return body;
  });
  if (action !== "prepare" || !result || typeof result !== "object" || !("attempt" in result))
    return result;
  return authorizePendingEditAttempt(pool, config, result.attempt as Attempt);
}
