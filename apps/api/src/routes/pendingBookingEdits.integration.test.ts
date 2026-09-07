import { describe, expect, it } from "vitest";
import { createPgBookingLifecycleStore } from "../jobs/bookingLifecycle.js";
import { loadBookingNotificationSnapshot } from "../jobs/bookingEmails.js";
import { createTargetBookingReservationsReadRepository } from "../platform/bookingReservations.js";
import { authorizeStripeBookingPayment } from "../domains/stripeBookingSettlement.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import { releaseAbandonedBookingEdits } from "../jobs/pendingBookingEditCleanup.js";
import { enableCard, propertyId, roomTypeId } from "./pendingBookingEdits.fixtures.js";
import { pendingEditFixture } from "./pendingBookingEdits.testFixture.js";
describe.skipIf(!process.env["TEST_DATABASE_URL"])(
  "pending request edits through target checkout",
  () => {
    const fixture = pendingEditFixture();
    const { pool, now, adapter, command, edit, url, intents, stripe } = fixture;
    it("rejects missing credentials and invalid occupancy", async () => {
      await expect(
        adapter.editRequest!("vay-959-hotel", fixture.created.booking.id, "details", {}, command()),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        edit("quote", { revision: 0, roomTypeId, adults: -1, children: 0, numberOfRooms: 1 }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects a pending edit when Finance disables its payment method", async () => {
      const details = await edit("details", {});
      const input = { ...details.input, revision: details.revision };
      const quote = await edit("quote", input);
      await pool.query(
        "UPDATE finance.payment_settings SET payments_enabled=FALSE WHERE property_id=$1",
        [propertyId],
      );
      try {
        await expect(
          edit("prepare", {
            ...input,
            quoteId: quote.quoteId,
            expectedTotalAmount: quote.totalAmount,
          }),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: "Selected payment method is no longer available. Please refresh.",
        });
      } finally {
        await pool.query(
          "UPDATE finance.payment_settings SET payments_enabled=TRUE WHERE property_id=$1",
          [propertyId],
        );
      }
    });

    it("updates the same pending request, preserves evidence, and replays one hotel email", async () => {
      const details = await edit("details", {});
      expect(details.revision).toBe(0);
      expect(details.input.addonIds).toEqual(["spa_partner"]);
      const input = {
        ...details.input,
        revision: 0,
        adults: 1,
        numberOfRooms: 2,
        checkOut: "2027-02-04",
        addonQuantities: { spa_partner: 1 },
        specialRequests: "Quiet room, please.",
      };
      const quote = await edit("quote", input);
      const prepared = await edit("prepare", {
        ...input,
        quoteId: quote.quoteId,
        expectedTotalAmount: quote.totalAmount,
      });
      const context = command();
      const saveInput = { revision: 0, attemptId: prepared.attemptId };
      const saved = await edit("save", saveInput, context);
      expect(saved.booking.id).toBe(fixture.created.booking.id);
      expect(saved.booking.bookingReference).toBe(fixture.created.booking.bookingReference);
      expect(saved.booking.status).toBe("pending");
      expect(saved.booking).toMatchObject({ adults: 1, numberOfRooms: 2, checkOut: "2027-02-04" });
      expect(await edit("save", saveInput, context)).toEqual(saved);
      expect(
        (
          await pool.query(`SELECT edit_revision FROM booking.guest_bookings WHERE id=$1`, [
            fixture.created.booking.id,
          ])
        ).rows[0],
      ).toEqual({ edit_revision: 1 });
      expect(
        (
          await pool.query(
            `SELECT special_requests FROM booking.booking_guests WHERE guest_booking_id=$1 AND guest_role='booker'`,
            [fixture.created.booking.id],
          )
        ).rows[0].special_requests,
      ).toBe("Quiet room, please.");
      expect(
        (
          await pool.query(
            `SELECT * FROM booking.finance_addon_purchase_evidence WHERE guest_booking_id=$1`,
            [fixture.created.booking.id],
          )
        ).rows,
      ).toHaveLength(2);
      expect(
        (
          await pool.query(
            `SELECT quantity FROM booking.active_booking_addon_selections WHERE guest_booking_id=$1`,
            [fixture.created.booking.id],
          )
        ).rows,
      ).toEqual([{ quantity: 1 }]);
      expect(
        (
          await pool.query(
            `SELECT * FROM platform.jobs WHERE property_id=$1 AND job_type='email.booking-host-request-updated'`,
            [propertyId],
          )
        ).rows,
      ).toHaveLength(1);
      await expect(edit("quote", input)).rejects.toMatchObject({ statusCode: 409 });
    });

    it("isolates replacement card attempts and releases only superseded or abandoned holds", async () => {
      await enableCard(pool);
      const details = await edit("details", {});
      const input = { ...details.input, revision: details.revision, paymentMethod: "card" };
      const quote = await edit("quote", input);
      const prepared = await edit("prepare", {
        ...input,
        quoteId: quote.quoteId,
        expectedTotalAmount: quote.totalAmount,
      });
      expect(
        (
          await pool.query("SELECT id FROM finance.payments WHERE guest_booking_id=$1", [
            fixture.created.booking.id,
          ])
        ).rows,
      ).toHaveLength(0);
      await expect(
        edit("save", { revision: 1, attemptId: prepared.attemptId }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const intent = [...intents.values()].at(-1)!;
      intent.status = "requires_capture";
      const saved = await edit("save", { revision: 1, attemptId: prepared.attemptId });
      expect(saved.booking.status).toBe("pending");
      expect(
        (
          await pool.query(
            "SELECT payment_status,active_card_payment_id FROM booking.guest_bookings WHERE id=$1",
            [fixture.created.booking.id],
          )
        ).rows[0],
      ).toMatchObject({ payment_status: "authorized", active_card_payment_id: expect.any(String) });
      const second = await edit("details", {});
      const abandonInput = { ...second.input, revision: second.revision };
      const abandonQuote = await edit("quote", abandonInput);
      const abandoned = await edit("prepare", {
        ...abandonInput,
        quoteId: abandonQuote.quoteId,
        expectedTotalAmount: abandonQuote.totalAmount,
      });
      const replacement = [...intents.values()].at(-1)!;
      replacement.status = "requires_capture";
      // Move only the attempt's fixture timestamps, preserving the original booking deadline.
      await pool.query(
        "UPDATE booking.pending_booking_edit_attempts SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1",
        [abandoned.attemptId],
      );
      await releaseAbandonedBookingEdits(pool, {
        connectionString: url!,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        stripePaymentProvider: stripe,
      });
      expect(replacement.status).toBe("canceled");
      expect(intent.status).toBe("requires_capture");
      const away = {
        ...second.input,
        revision: second.revision,
        paymentMethod: "pay_at_property",
        addonIds: [],
        addonQuantities: {},
      };
      const awayQuote = await edit("quote", away);
      const awayPrepared = await edit("prepare", {
        ...away,
        quoteId: awayQuote.quoteId,
        expectedTotalAmount: awayQuote.totalAmount,
      });
      await edit("save", { revision: second.revision, attemptId: awayPrepared.attemptId });
      await releaseAbandonedBookingEdits(pool, {
        connectionString: url!,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        stripePaymentProvider: stripe,
      });
      expect(intent.status).toBe("canceled");
      expect(
        (
          await pool.query(
            "SELECT payment_status,active_card_payment_id FROM booking.guest_bookings WHERE id=$1",
            [fixture.created.booking.id],
          )
        ).rows[0],
      ).toEqual({ payment_status: "unpaid", active_card_payment_id: null });
      expect(
        (
          await pool.query(
            "SELECT id FROM booking.active_booking_addon_selections WHERE guest_booking_id=$1",
            [fixture.created.booking.id],
          )
        ).rows,
      ).toHaveLength(0);
    });

    it("projects current requests and payment method into PMS, notifications, and delayed create", async () => {
      const repository = createTargetBookingReservationsReadRepository({
        connectionString: url!,
        pool,
      });
      const result = await repository.listReservationsByPropertyId(propertyId, {
        limit: 10,
        offset: 0,
        canReadGuestContact: true,
      });
      expect(result.reservations[0]).toMatchObject({
        paymentMethod: "pay_at_property",
        specialRequests: "Quiet room, please.",
      });
      const snapshot = await loadBookingNotificationSnapshot(pool, {
        propertyId,
        guestBookingId: fixture.created.booking.id,
      });
      expect(snapshot?.addons).toBeNull();
      const jobs = (
        await pool.query(
          "SELECT payload FROM platform.jobs WHERE property_id=$1 AND job_type='pms.reservation.create'",
          [propertyId],
        )
      ).rows;
      expect(jobs[0].payload).toMatchObject({
        bookingEditRevision: 3,
        specialRequests: "Quiet room, please.",
        stay: { numberOfRooms: 2 },
        bookedOffer: { addonRequest: { addonIds: [] } },
      });
      const superseded = [...intents.values()][0];
      expect(
        await authorizeStripeBookingPayment(pool, {
          paymentIntentId: superseded.paymentIntentId,
          providerAccountRef: superseded.providerAccountRef,
          amountMinor: superseded.amountMinor,
          currency: superseded.currency,
          occurredAt: now,
        }),
      ).toBe("not_found");
      const lifecycle = createPgBookingLifecycleStore({ connectionString: url!, pool });
      await expect(lifecycle.findPendingBookingExpiryCandidates(now, 10)).resolves.toEqual([]);
      await expect(lifecycle.findExpiredDraftCandidates(now, 10)).resolves.toEqual([]);
    });

    it("rolls back a lost-inventory save without changing the old request", async () => {
      const details = await edit("details", {});
      const input = {
        ...details.input,
        revision: details.revision,
        checkIn: "2027-02-04",
        checkOut: "2027-02-05",
      };
      const quote = await edit("quote", input);
      const attempt = await edit("prepare", {
        ...input,
        quoteId: quote.quoteId,
        expectedTotalAmount: quote.totalAmount,
      });
      await pool.query(
        "UPDATE pms.inventory_days SET assigned_count=2,available_count=0,inventory_revision=inventory_revision+1,booking_source_revision=booking_source_revision+1 WHERE property_id=$1 AND stay_date='2027-02-04'",
        [propertyId],
      );
      try {
        await expect(
          edit("save", { revision: details.revision, attemptId: attempt.attemptId }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const unchanged = await edit("details", {});
        expect(unchanged.revision).toBe(details.revision);
        expect(unchanged.input.checkIn).toBe(details.input.checkIn);
        expect(
          (
            await pool.query(
              "SELECT assigned_count FROM pms.inventory_days WHERE property_id=$1 AND stay_date='2027-02-01'",
              [propertyId],
            )
          ).rows[0].assigned_count,
        ).toBe(2);
      } finally {
        await pool.query(
          "UPDATE pms.inventory_days SET assigned_count=0,available_count=2,inventory_revision=inventory_revision+1,booking_source_revision=booking_source_revision+1 WHERE property_id=$1 AND stay_date='2027-02-04'",
          [propertyId],
        );
      }
    });

    it("rejects closed lifecycle states and expired credentials", async () => {
      for (const status of ["confirmed", "declined", "canceled", "expired"]) {
        await pool.query("UPDATE booking.guest_bookings SET lifecycle_status=$2 WHERE id=$1", [
          fixture.created.booking.id,
          status,
        ]);
        await expect(edit("details", {})).rejects.toMatchObject({ statusCode: 409 });
      }
      await pool.query(
        "UPDATE booking.guest_bookings SET lifecycle_status='pending_payment' WHERE id=$1",
        [fixture.created.booking.id],
      );
      await expect(
        adapter.editRequest!(
          "vay-959-hotel",
          fixture.created.booking.id,
          "details",
          { confirmationToken: "x".repeat(43) },
          command(),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      await pool.query(
        "UPDATE booking.guest_bookings SET booking_metadata=booking_metadata || jsonb_build_object('acceptedPaymentDeadlineAt','2027-01-02T10:00:00Z') WHERE id=$1",
        [fixture.created.booking.id],
      );
      await expect(edit("details", {})).rejects.toMatchObject({ statusCode: 409 });
      await pool.query(
        "UPDATE booking.guest_bookings SET booking_metadata=booking_metadata-'acceptedPaymentDeadlineAt' WHERE id=$1",
        [fixture.created.booking.id],
      );
    });

    it("rejects operational handoffs that have already started", async () => {
      await pool.query(
        "UPDATE platform.jobs SET status='running',locked_by='test',locked_at=now() WHERE property_id=$1 AND job_type='pms.reservation.create'",
        [propertyId],
      );
      await expect(edit("details", {})).rejects.toMatchObject({ statusCode: 409 });
      await pool.query(
        "UPDATE platform.jobs SET status='pending',locked_by=NULL,locked_at=NULL WHERE property_id=$1 AND job_type='pms.reservation.create'",
        [propertyId],
      );
    });

    it("refuses strict replacement of an already handed-off inventory receipt", async () => {
      const client = await pool.connect();
      await client.query("BEGIN");
      try {
        const booking = (
          await client.query("SELECT booking_metadata FROM booking.guest_bookings WHERE id=$1", [
            fixture.created.booking.id,
          ])
        ).rows[0];
        const receipt = booking.booking_metadata.inventoryReservation;
        await client.query("SET LOCAL session_replication_role=replica");
        await client.query(
          "UPDATE pms.inventory_reservation_statuses SET lifecycle_state='handed_off',lifecycle_revision=2,handed_off_at=now() WHERE receipt_id=$1",
          [receipt.receiptId],
        );
        await expect(
          createTargetPmsInventoryReservationPort().release({
            transaction: client,
            propertyId,
            reservation: receipt,
            occurredAt: now,
            requireReserved: true,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("drains releases even when another account's recovery fails", async () => {
      const source = [...intents.values()][0];
      const recovery = await stripe.createPaymentIntent({
        propertyId,
        bookingReference: fixture.created.booking.bookingReference,
        providerAccountRef: "acct_vay959",
        amountMinor: 100,
        currency: "EUR",
        applicationFeeAmountMinor: 5,
        captureMethod: "manual",
        idempotencyKey: "durable-release",
      });
      recovery.status = "requires_capture";
      await pool.query(
        `INSERT INTO booking.edit_authorization_releases(provider_payment_intent_id,provider_account_ref,property_id) VALUES($1,'acct_vay959',$2)`,
        [recovery.paymentIntentId, propertyId],
      );
      await pool.query(`INSERT INTO booking.pending_booking_edit_attempts
      (property_id,guest_booking_id,expected_revision,idempotency_key,request_fingerprint,quote_session_id,provider_account_id,payment_method,provider_request,created_at,expires_at,updated_at)
      SELECT property_id,guest_booking_id,expected_revision,'poison-recovery',request_fingerprint,quote_session_id,provider_account_id,'card',
      provider_request || '{"idempotencyKey":"poison"}'::jsonb,now()-interval '2 hours',now()-interval '1 hour',now()-interval '2 hours'
      FROM booking.pending_booking_edit_attempts WHERE payment_method='card' LIMIT 1`);
      await releaseAbandonedBookingEdits(pool, {
        connectionString: url!,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        stripePaymentProvider: {
          ...stripe,
          async createPaymentIntent(input) {
            if (input.idempotencyKey === "poison") throw new Error("Disconnected account");
            return stripe.createPaymentIntent(input);
          },
        },
      });
      expect(recovery.status).toBe("canceled");
      expect(source.status).toBe("canceled");
      expect(
        (
          await pool.query(
            "SELECT status FROM booking.pending_booking_edit_attempts WHERE idempotency_key='poison-recovery'",
          )
        ).rows[0].status,
      ).toBe("prepared");
    });

    it("rejects a prepared save when acceptance wins the booking lock", async () => {
      const details = await edit("details", {});
      const input = {
        ...details.input,
        revision: details.revision,
        specialRequests: "This must not replace the accepted request.",
      };
      const quote = await edit("quote", input);
      const prepared = await edit("prepare", { ...input, quoteId: quote.quoteId });
      const hotel = await pool.connect();
      await hotel.query("BEGIN");
      await hotel.query("SELECT id FROM booking.guest_bookings WHERE id=$1 FOR UPDATE", [
        fixture.created.booking.id,
      ]);
      const saving = edit("save", { revision: details.revision, attemptId: prepared.attemptId });
      const rejected = expect(saving).rejects.toMatchObject({ statusCode: 409 });
      await hotel.query(
        "UPDATE booking.guest_bookings SET lifecycle_status='confirmed' WHERE id=$1",
        [fixture.created.booking.id],
      );
      await hotel.query("COMMIT");
      hotel.release();
      await rejected;
      expect(
        (
          await pool.query("SELECT edit_revision FROM booking.guest_bookings WHERE id=$1", [
            fixture.created.booking.id,
          ])
        ).rows[0].edit_revision,
      ).toBe(details.revision);
    });
  },
);
