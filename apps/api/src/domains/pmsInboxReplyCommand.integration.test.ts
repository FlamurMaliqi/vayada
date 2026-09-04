import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { relayPmsInboxDeliveryOutbox } from "../jobs/pmsInboxDeliveryOutbox.js";
import { createPgPmsInboxDeliveryStore } from "../jobs/pmsInboxDeliveryPg.js";
import { runPmsInboxDeliveryJobs } from "../jobs/pmsInboxDeliveryWorker.js";
import { createPgPmsInboxDeliveryReceiptPort } from "../jobs/pmsInboxDeliveryReceipts.js";
import type { PmsInboxEmailReplyRouteReadPort } from "./pmsInbox.js";
import type { PmsInboxDeliveryProvider } from "./pmsInboxDelivery.js";
import {
  createPgPmsInboxEmailRoutes,
  createUnavailablePmsInboxDeliveryEmailRoutePort,
  type PmsInboxDeliveryEmailRoutePort,
} from "./pmsInboxDeliveryEmailRoutes.js";
import { createUnavailablePmsInboxEmailReplyRouteReadPort } from "./pmsInboxProductionRuntime.js";
import { createPgPmsInboxReplyPort } from "./pmsInboxReplyCommand.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13730000-0000-4000-8000-000000000001";
const OTHER_PROPERTY = "13730000-0000-4000-8000-000000000002";
const THREAD = "13730000-0000-4000-8000-000000000003";
const OTHER_THREAD = "13730000-0000-4000-8000-000000000004";
const ORGANIZATION = "13730000-0000-4000-8000-000000000005";
const ACTOR = "13730000-0000-4000-8000-000000000006";
const MEMBERSHIP = "13730000-0000-4000-8000-000000000007";
const MEDIA = "13730000-0000-4000-8000-000000000008";
const OTHER_MEDIA = "13730000-0000-4000-8000-000000000009";
const BOOKING = "13730000-0000-4000-8000-000000000010";
const BOOKING_GUEST = "13730000-0000-4000-8000-000000000011";
const OTHER_ORGANIZATION = "13730000-0000-4000-8000-000000000012";
const NOW = "2026-09-03T09:00:00.000Z";

describe.skipIf(!URL)("PostgreSQL PMS Inbox manual reply command", () => {
  const admin = new pg.Client({ connectionString: URL });
  let resolvedGuestEmails: Array<string | null> = [];
  const approvedEmailRoutes: PmsInboxEmailReplyRouteReadPort = {
    async resolveReplyRoutes({ propertyId, threads }) {
      return threads.map(({ threadId }) => ({
        propertyId,
        threadId,
        route: { state: "ready", channel: "email", providerChannel: null, reasonCode: null },
      }));
    },
  };

  it("uses the approved property sender and current direct-booking email", async () => {
    await admin.query(
      `INSERT INTO pms.inbox_email_routes
         (property_id, from_address, sender_status, policy_status, approved_at,
          approved_by_membership_id)
       VALUES ($1::uuid, 'Stay <stay@example.test>', 'approved', 'allowed', now(), $2::uuid)`,
      [PROPERTY, MEMBERSHIP],
    );
    const routes = createPgPmsInboxEmailRoutes({ connectionString: "", pool: admin as never });
    await expect(
      routes.resolveDeliveryEmailRoute({
        propertyId: PROPERTY,
        threadId: THREAD,
        guestEmail: " current@example.test ",
      }),
    ).resolves.toEqual({
      state: "ready",
      recipientEmail: "current@example.test",
      senderEmail: "Stay <stay@example.test>",
    });
    await admin.query(
      "UPDATE pms.inbox_email_routes SET policy_status = 'disallowed' WHERE property_id = $1::uuid",
      [PROPERTY],
    );
    await expect(
      routes.resolveDeliveryEmailRoute({
        propertyId: PROPERTY,
        threadId: THREAD,
        guestEmail: "current@example.test",
      }),
    ).resolves.toEqual({ state: "held", reasonCode: "email_policy_disallowed" });
  });
  const approvedDeliveryEmailRoutes: PmsInboxDeliveryEmailRoutePort = {
    async resolveDeliveryEmailRoute({ guestEmail }) {
      if (!guestEmail) return { state: "held", reasonCode: "guest_email_unavailable" };
      return {
        state: "ready",
        recipientEmail: guestEmail.trim(),
        senderEmail: "Stay <stay@example.test>",
      };
    },
  };
  const reply = createPgPmsInboxReplyPort({
    connectionString: URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date(NOW),
    emailReplyRoutes: {
      async resolveReplyRoutes({ propertyId, threads }) {
        resolvedGuestEmails.push(...threads.map(({ guestEmail }) => guestEmail));
        return threads.map(({ threadId, guestEmail }) => ({
          propertyId,
          threadId,
          route: guestEmail
            ? { state: "ready", channel: "email", providerChannel: null, reasonCode: null }
            : {
                state: "held",
                channel: null,
                providerChannel: null,
                reasonCode: "guest_email_unavailable",
              },
        }));
      },
    },
  });

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    resolvedGuestEmails = [];
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await reply.close();
    await cleanup();
    await admin.end();
  });

  it("persists and replays one queued OTA reply with an exactly claimed attachment", async () => {
    const input = command("ready-once", { attachmentMediaIds: [MEDIA] });
    const accepted = await reply.reply(input);
    await expect(reply.reply(input)).resolves.toEqual(accepted);
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        threadVersion: 5,
        delivery: { state: "queued", channel: "ota", providerAcknowledgedAt: null },
        acceptedAt: NOW,
      },
    });
    const messageId = accepted.ok ? accepted.value.messageId : "";
    const persisted = await state(messageId);
    expect(persisted.counts).toEqual({
      messages: 1,
      attachments: 1,
      idempotency: 1,
      events: 1,
      outbox: 1,
      attempts: 0,
      audits: 2,
    });
    expect(persisted.thread).toMatchObject({
      version: "5",
      attentionState: "needs_attention",
      followUpAt: null,
      doneAt: null,
      lastDirection: "outbound",
    });
    expect(persisted.message).toMatchObject({
      direction: "outbound",
      senderType: "property_user",
      senderUserId: ACTOR,
      body: "Your room is ready.",
      deliveryState: "queued",
      deliveryChannel: "ota",
      deliveryReasonCode: null,
    });
    expect(persisted.media).toEqual({
      lifecycleStatus: "active",
      retainedUntil: null,
      attachmentState: "claimed",
      claimedByMessageId: messageId,
    });
    expect(persisted.outbox).toEqual({
      outboxKey: `pms.guest-message.deliver:message:${messageId}:manual-send:v1`,
      eventType: "pms.guest-message.deliver",
      destination: "pms.guest-message.deliver",
      payload: { propertyId: PROPERTY, threadId: THREAD, messageId, channel: "ota" },
    });
    const evidence = JSON.stringify([persisted.event, persisted.outbox, persisted.audits]);
    expect(evidence).not.toContain("Your room is ready");
    expect(evidence).not.toContain("guest-document.pdf");
    expect(evidence).not.toContain("guest@example.test");
    expect(evidence).not.toContain("ready-once");

    await expect(relayPmsInboxDeliveryOutbox(URL!, { now: new Date(NOW) })).resolves.toEqual({
      published: 1,
    });
    await expect(relayPmsInboxDeliveryOutbox(URL!, { now: new Date(NOW) })).resolves.toEqual({
      published: 0,
    });
    await expect(
      admin.query(
        `SELECT job_key AS "jobKey", job_type AS "jobType", queue_name AS "queueName",
                property_id::text AS "propertyId", resource_id AS "resourceId",
                payload, source_outbox_event_id IS NOT NULL AS "hasOutboxSource"
         FROM platform.jobs WHERE property_id = $1::uuid`,
        [PROPERTY],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          jobKey: `pms.guest-message.deliver:message:${messageId}:manual-send:v1`,
          jobType: "pms.guest-message.deliver",
          queueName: "pms.guest-message.delivery",
          propertyId: PROPERTY,
          resourceId: messageId,
          payload: { propertyId: PROPERTY, threadId: THREAD, messageId, channel: "ota" },
          hasOutboxSource: true,
        },
      ],
    });
    await admin.query(
      "UPDATE platform.media_objects SET checksum_sha256 = repeat('a', 64) WHERE id = $1::uuid",
      [MEDIA],
    );
    const send = vi.fn<PmsInboxDeliveryProvider["send"]>(async () => ({
      ok: true,
      providerReference: "ota-message-1",
    }));
    await expect(deliver(send)).resolves.toMatchObject({ processed: 1, sent: 1 });
    await expect(deliver(send)).resolves.toMatchObject({ processed: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ channel: "ota", recipientEmail: null });
    expect(send.mock.calls[0]?.[0].attachments).toHaveLength(1);
    expect((await state(messageId)).message).toMatchObject({ deliveryState: "sent" });
    expect(
      (
        await admin.query(
          `SELECT outcome, provider_reference FROM pms.message_delivery_attempts WHERE message_id = $1::uuid`,
          [messageId],
        )
      ).rows,
    ).toEqual([{ outcome: "accepted", provider_reference: "ota-message-1" }]);
    const receipts = createPgPmsInboxDeliveryReceiptPort({
      connectionString: "",
      pool: admin as never,
    });
    const acknowledgedAt = new Date("2026-09-03T09:01:00.000Z");
    await expect(
      receipts.recordTrustedReceipt({
        propertyId: PROPERTY,
        messageId,
        attemptNumber: 1,
        receiptType: "delivered",
        providerReceiptId: "ota-receipt-1",
        acknowledgedAt,
      }),
    ).resolves.toEqual({ recorded: true });
    await expect(
      receipts.recordTrustedReceipt({
        propertyId: PROPERTY,
        messageId,
        attemptNumber: 1,
        receiptType: "delivered",
        providerReceiptId: "ota-receipt-1",
        acknowledgedAt,
      }),
    ).resolves.toEqual({ recorded: false });
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS count, max(acknowledged_at) AS "acknowledgedAt"
           FROM pms.message_delivery_receipts WHERE message_id = $1::uuid`,
          [messageId],
        )
      ).rows,
    ).toEqual([{ count: 1, acknowledgedAt }]);
    expect(
      (
        await admin.query(
          `SELECT latest_provider_receipt_at AS "acknowledgedAt"
           FROM pms.messages WHERE id = $1::uuid`,
          [messageId],
        )
      ).rows,
    ).toEqual([{ acknowledgedAt }]);
  });

  it.each([
    "connection",
    "entitlement",
    "attachment-thread",
    "attachment-claim",
    "attachment-size",
  ])("revalidates %s at execution without an external send", async (changed) => {
    const accepted = await reply.reply(
      command(`delivery-${changed}`, { attachmentMediaIds: [MEDIA] }),
    );
    expect(accepted.ok).toBe(true);
    if (changed === "connection")
      await admin.query(
        "UPDATE pms.channel_connections SET messaging_app_installed = FALSE WHERE property_id = $1::uuid",
        [PROPERTY],
      );
    else if (changed === "entitlement")
      await admin.query(
        "UPDATE identity.product_entitlements SET status = 'suspended' WHERE organization_id = $1::uuid",
        [ORGANIZATION],
      );
    else if (changed === "attachment-thread")
      await admin.query("UPDATE platform.media_objects SET resource_id = $2 WHERE id = $1::uuid", [
        MEDIA,
        OTHER_THREAD,
      ]);
    else if (changed === "attachment-claim")
      await admin.query(
        "UPDATE platform.media_objects SET source_metadata = '{}'::jsonb WHERE id = $1::uuid",
        [MEDIA],
      );
    else
      await admin.query("UPDATE platform.media_objects SET size_bytes = 2048 WHERE id = $1::uuid", [
        MEDIA,
      ]);
    const send = vi.fn<PmsInboxDeliveryProvider["send"]>();
    await deliver(send);
    expect(send).not.toHaveBeenCalled();
    const messageId = accepted.ok ? accepted.value.messageId : "";
    expect((await state(messageId)).message).toMatchObject({
      deliveryState: changed.startsWith("attachment") ? "failed" : "held",
      deliveryReasonCode: changed.startsWith("attachment")
        ? "invalid_delivery_payload"
        : changed === "entitlement"
          ? "access_unavailable"
          : "provider_configuration_unavailable",
    });
  });

  it("retries a known provider failure with stable identity and persists only one acceptance", async () => {
    const accepted = await reply.reply(command("provider-retry"));
    const send = vi
      .fn<PmsInboxDeliveryProvider["send"]>()
      .mockResolvedValueOnce({ ok: false, failure: "transient_provider_failure" })
      .mockResolvedValueOnce({ ok: true, providerReference: "retry-accepted" });
    await expect(deliver(send)).resolves.toMatchObject({ retrying: 1 });
    await admin.query("UPDATE platform.jobs SET run_after = now() WHERE property_id = $1::uuid", [
      PROPERTY,
    ]);
    await expect(deliver(send)).resolves.toMatchObject({ sent: 1 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
    await expect(deliver(send)).resolves.toMatchObject({ processed: 0 });
    const messageId = accepted.ok ? accepted.value.messageId : "";
    expect(
      (
        await admin.query(
          `SELECT outcome, provider_reference FROM pms.message_delivery_attempts WHERE message_id = $1::uuid ORDER BY attempt_number`,
          [messageId],
        )
      ).rows,
    ).toEqual([
      { outcome: "transient_failure", provider_reference: null },
      { outcome: "accepted", provider_reference: "retry-accepted" },
    ]);
  });

  it.each(["organization", "membership", "assignment", "permission"])(
    "holds revoked originating %s despite another active property owner",
    async (revoked) => {
      const accepted = await reply.reply(command(`revoked-${revoked}`));
      expect(accepted.ok).toBe(true);
      if (revoked === "organization")
        await admin.query(
          "UPDATE identity.organizations SET status = 'suspended' WHERE id = $1::uuid",
          [ORGANIZATION],
        );
      else if (revoked === "membership")
        await admin.query(
          "UPDATE identity.organization_memberships SET status = 'suspended' WHERE id = $1::uuid",
          [MEMBERSHIP],
        );
      else if (revoked === "assignment")
        await admin.query(
          "UPDATE identity.organization_memberships SET property_access_mode = 'assigned' WHERE id = $1::uuid",
          [MEMBERSHIP],
        );
      else
        await admin.query(
          `UPDATE identity.organization_memberships SET permission_overrides = '{"grant":[],"deny":["pms.inbox.reply"]}'::jsonb WHERE id = $1::uuid`,
          [MEMBERSHIP],
        );
      const send = vi.fn<PmsInboxDeliveryProvider["send"]>();
      await expect(deliver(send)).resolves.toMatchObject({ held: 1 });
      expect(send).not.toHaveBeenCalled();
      const messageId = accepted.ok ? accepted.value.messageId : "";
      expect((await state(messageId)).message).toMatchObject({
        deliveryReasonCode: "access_unavailable",
      });
      expect(
        (
          await admin.query(
            `SELECT causation_id = domain_event_id::text AS linked FROM platform.product_audit_events WHERE job_id IS NOT NULL AND property_id = $1::uuid`,
            [PROPERTY],
          )
        ).rows,
      ).toEqual([{ linked: true }]);
    },
  );

  it.each([false, true])(
    "recovers a crashed final lease without a sixth attempt (provider started=%s)",
    async (started) => {
      await reply.reply(command(`crashed-final-${started}`));
      await relayPmsInboxDeliveryOutbox(URL!, { now: new Date(NOW) });
      await admin.query(
        "UPDATE platform.jobs SET attempts_count = 4 WHERE property_id = $1::uuid",
        [PROPERTY],
      );
      const store = createPgPmsInboxDeliveryStore({
        connectionString: URL!,
        emailReplyRoutes: approvedEmailRoutes,
        emailDeliveryRoutes: approvedDeliveryEmailRoutes,
        media: { read: async () => new Uint8Array() },
      });
      try {
        const original = await store.claim("crashed-worker");
        expect(original?.attemptNumber).toBe(5);
        if (!original) throw new Error("Expected a claimed job");
        if (started) expect((await store.prepare(original)).state).toBe("ready");
        await admin.query(
          "UPDATE platform.jobs SET locked_at = now() - interval '6 minutes' WHERE id = $1::uuid",
          [original.id],
        );
        const recovered = await store.claim("recovery-worker");
        expect(recovered?.attemptNumber).toBe(5);
        if (!recovered) throw new Error("Expected a recovered job");
        await expect(
          store.complete(original, {
            outcome: "accepted",
            attemptId: MEDIA,
            providerReference: "stale",
          }),
        ).resolves.toBe(false);
        const send = vi.fn<PmsInboxDeliveryProvider["send"]>(async () => ({
          ok: true,
          providerReference: "recovered",
        }));
        let returned = false;
        const totals = await runPmsInboxDeliveryJobs(
          { ...store, claim: async () => (returned ? null : ((returned = true), recovered)) },
          { channex: { send } },
        );
        expect(totals).toMatchObject(started ? { held: 1 } : { sent: 1 });
        expect(send).toHaveBeenCalledTimes(started ? 0 : 1);
        expect(
          (
            await admin.query(
              `SELECT attempts_count, status FROM platform.jobs WHERE id = $1::uuid`,
              [original.id],
            )
          ).rows,
        ).toEqual([{ attempts_count: 5, status: started ? "failed" : "succeeded" }]);
        expect(
          (
            await admin.query(
              `SELECT attempt_number FROM platform.job_attempts WHERE job_id = $1::uuid`,
              [original.id],
            )
          ).rows,
        ).toEqual([{ attempt_number: 5 }]);
      } finally {
        await store.close();
      }
    },
  );

  it("persists a held reply without creating delivery work", async () => {
    await admin.query(
      `UPDATE pms.channel_connections SET connection_status = 'disconnected'
       WHERE property_id = $1::uuid AND provider = 'channex'`,
      [PROPERTY],
    );
    const accepted = await reply.reply(command("held", { attachmentMediaIds: [] }));
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        delivery: {
          state: "held",
          channel: null,
          reasonCode: "channel_connection_inactive",
        },
      },
    });
    const messageId = accepted.ok ? accepted.value.messageId : "";
    const persisted = await state(messageId);
    expect(persisted.counts.outbox).toBe(0);
    expect(persisted.counts.attempts).toBe(0);
    expect(persisted.counts.audits).toBe(2);
    expect(persisted.message).toMatchObject({
      deliveryState: "held",
      deliveryChannel: null,
      deliveryReasonCode: "channel_connection_inactive",
    });
    expect(persisted.audits).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "pms.inbox.reply.held" })]),
    );
  });

  it("holds an inquiry reply at acceptance because inquiry sending is out of scope", async () => {
    await admin.query(
      `UPDATE pms.message_threads SET conversation_context_state = 'inquiry',
         inquiry_arrival_date = '2026-09-04', inquiry_departure_date = '2026-09-05',
         inquiry_adults = 2, inquiry_children = 0
       WHERE property_id = $1::uuid AND id = $2::uuid`,
      [PROPERTY, THREAD],
    );
    const accepted = await reply.reply(command("inquiry-held"));
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        delivery: {
          state: "held",
          channel: null,
          reasonCode: "provider_conversation_unavailable",
        },
      },
    });
    const messageId = accepted.ok ? accepted.value.messageId : "";
    expect((await state(messageId)).counts.outbox).toBe(0);
  });

  it("rejects stale versions and cross-property attachments without side effects", async () => {
    await expect(
      reply.reply(command("stale", { expectedThreadVersion: 3, attachmentMediaIds: [] })),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "thread_version_conflict",
        message: "The conversation changed. Refresh and try again.",
        currentVersion: 4,
      },
    });
    await expect(
      reply.reply(command("cross-property", { attachmentMediaIds: [OTHER_MEDIA] })),
    ).resolves.toMatchObject({ ok: false, error: { code: "validation_failed" } });
    const counts = await admin.query<{ messages: number; outbox: number; attachmentState: string }>(
      `SELECT
         (SELECT count(*)::int FROM pms.messages WHERE property_id = $1::uuid) AS messages,
         (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid) AS outbox,
         (SELECT source_metadata ->> 'attachmentState' FROM platform.media_objects
          WHERE id = $2::uuid) AS "attachmentState"`,
      [PROPERTY, OTHER_MEDIA],
    );
    expect(counts.rows[0]).toEqual({ messages: 0, outbox: 0, attachmentState: "orphan" });
  });

  it("holds an unlinked email reply even when the thread has a cached guest email", async () => {
    await admin.query(
      `UPDATE pms.message_threads
       SET source = 'manual', source_thread_id = 'unlinked-email-thread',
           provider_channel = NULL, guest_email = 'stale-guest@example.test',
           delivery_channel = 'email'
       WHERE property_id = $1::uuid AND id = $2::uuid`,
      [PROPERTY, THREAD],
    );

    const accepted = await reply.reply(command("unlinked-email", { attachmentMediaIds: [] }));
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        delivery: { state: "held", channel: null, reasonCode: "guest_email_unavailable" },
      },
    });
    expect(resolvedGuestEmails).toEqual([null]);
    const messageId = accepted.ok ? accepted.value.messageId : "";
    const persisted = await state(messageId);
    expect(persisted.counts.outbox).toBe(0);
    expect(persisted.message).toMatchObject({
      deliveryState: "held",
      deliveryChannel: null,
      deliveryReasonCode: "guest_email_unavailable",
    });
  });

  it.each([true, false])(
    "rechecks current Booking email and sender policy (approved=%s)",
    async (approved) => {
      await admin.query(
        `INSERT INTO booking.guest_bookings
         (id, property_id, public_reference, lifecycle_status, check_in, check_out, currency, booking_channel, direct_booking_source)
       VALUES ($1::uuid, $2::uuid, 'INBOX-EMAIL-BOOKING', 'confirmed',
               '2026-09-04', '2026-09-05', 'EUR', 'direct', 'booking_engine')`,
        [BOOKING, PROPERTY],
      );
      await admin.query(
        `INSERT INTO booking.booking_guests
         (id, guest_booking_id, guest_role, first_name, last_name, email)
       VALUES ($1::uuid, $2::uuid, 'booker', 'Current', 'Guest',
               '  current-guest@example.test  ')`,
        [BOOKING_GUEST, BOOKING],
      );
      await admin.query(
        `UPDATE pms.message_threads
       SET source = 'manual', source_thread_id = 'email-thread', provider_channel = NULL,
           guest_email = 'stale-guest@example.test', guest_booking_id = $1::uuid,
           delivery_channel = 'email', conversation_context_state = 'linked'
       WHERE property_id = $2::uuid AND id = $3::uuid`,
        [BOOKING, PROPERTY, THREAD],
      );

      await expect(
        reply.reply(command("current-booking-email", { attachmentMediaIds: [] })),
      ).resolves.toMatchObject({
        ok: true,
        value: { delivery: { state: "queued", channel: "email" } },
      });
      expect(resolvedGuestEmails).toEqual(["current-guest@example.test"]);
      const send = vi.fn<PmsInboxDeliveryProvider["send"]>(async () => ({
        ok: true,
        providerReference: "email-accepted",
      }));
      await deliver(
        send,
        approved ? approvedEmailRoutes : createUnavailablePmsInboxEmailReplyRouteReadPort(),
        approved ? approvedDeliveryEmailRoutes : createUnavailablePmsInboxDeliveryEmailRoutePort(),
      );
      if (approved) {
        expect(send).toHaveBeenCalledOnce();
        expect(send.mock.calls[0]?.[0]).toMatchObject({
          channel: "email",
          recipientEmail: "current-guest@example.test",
        });
      } else expect(send).not.toHaveBeenCalled();
    },
  );

  it("replays concurrent commands with the same key and payload exactly once", async () => {
    const input = command("same-key-same-payload", { attachmentMediaIds: [] });
    const [first, second] = await Promise.all([reply.reply(input), reply.reply(input)]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ ok: true, value: { threadVersion: 5 } });
    const counts = await admin.query<{
      messages: number;
      idempotency: number;
      outbox: number;
      version: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM pms.messages WHERE property_id = $1::uuid) AS messages,
         (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid) AS idempotency,
         (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid) AS outbox,
         (SELECT version::text FROM pms.message_threads
          WHERE property_id = $1::uuid AND id = $2::uuid) AS version`,
      [PROPERTY, THREAD],
    );
    expect(counts.rows[0]).toEqual({ messages: 1, idempotency: 1, outbox: 1, version: "5" });
  });

  it("rejects one concurrent payload when the same key is reused", async () => {
    const [first, second] = await Promise.all([
      reply.reply(command("same-key-different-payload", { text: "First", attachmentMediaIds: [] })),
      reply.reply(
        command("same-key-different-payload", { text: "Second", attachmentMediaIds: [] }),
      ),
    ]);

    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: {
          code: "idempotency_conflict",
          message: "Idempotency key was already used for a different reply.",
        },
      },
    ]);
    const counts = await admin.query<{ messages: number; idempotency: number; outbox: number }>(
      `SELECT
         (SELECT count(*)::int FROM pms.messages WHERE property_id = $1::uuid) AS messages,
         (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid) AS idempotency,
         (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid) AS outbox`,
      [PROPERTY],
    );
    expect(counts.rows[0]).toEqual({ messages: 1, idempotency: 1, outbox: 1 });
  });

  it("serializes concurrent replies so only one expected version is accepted", async () => {
    const [first, second] = await Promise.all([
      reply.reply(command("concurrent-a", { text: "First", attachmentMediaIds: [] })),
      reply.reply(command("concurrent-b", { text: "Second", attachmentMediaIds: [] })),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: {
          code: "thread_version_conflict",
          message: "The conversation changed. Refresh and try again.",
          currentVersion: 5,
        },
      },
    ]);
    const counts = await admin.query<{ messages: number; outbox: number; version: string }>(
      `SELECT
         (SELECT count(*)::int FROM pms.messages WHERE property_id = $1::uuid) AS messages,
         (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid) AS outbox,
         (SELECT version::text FROM pms.message_threads
          WHERE property_id = $1::uuid AND id = $2::uuid) AS version`,
      [PROPERTY, THREAD],
    );
    expect(counts.rows[0]).toEqual({ messages: 1, outbox: 1, version: "5" });
  });

  function command(key: string, overrides: Record<string, unknown> = {}) {
    return {
      propertyId: PROPERTY,
      threadId: THREAD,
      organizationId: ORGANIZATION,
      actorUserId: ACTOR,
      actorMembershipId: MEMBERSHIP,
      idempotencyKey: key,
      expectedThreadVersion: 4,
      text: "Your room is ready.",
      attachmentMediaIds: [] as string[],
      audit: { requestId: `request-${key}`, correlationId: "inbox-integration", requestedAt: NOW },
      ...overrides,
    };
  }

  async function deliver(
    send: PmsInboxDeliveryProvider["send"],
    emailReplyRoutes = approvedEmailRoutes,
    emailDeliveryRoutes = approvedDeliveryEmailRoutes,
  ) {
    await relayPmsInboxDeliveryOutbox(URL!, { now: new Date(NOW) });
    const store = createPgPmsInboxDeliveryStore({
      connectionString: URL!,
      emailReplyRoutes,
      emailDeliveryRoutes,
      media: { read: async ({ expectedSizeBytes }) => new Uint8Array(expectedSizeBytes) },
    });
    try {
      return await runPmsInboxDeliveryJobs(store, { channex: { send }, resend: { send } });
    } finally {
      await store.close();
    }
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'staff@example.test', 'Front Desk', 'active')`,
      [ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Inbox Test', 'inbox-test', 'active'),
              ($2::uuid, 'hotel_group', 'Other Owner', 'inbox-other-owner', 'active')`,
      [ORGANIZATION, OTHER_ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name, lifecycle_status)
       VALUES ($1::uuid, 'inbox-test', 'Inbox Test', 'active'),
              ($2::uuid, 'inbox-other', 'Inbox Other', 'active')`,
      [PROPERTY, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key, property_access_mode, access_origin)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', 'owner', 'all', 'agency')`,
      [MEMBERSHIP, ORGANIZATION, ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active'),
              ($3::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [ORGANIZATION, PROPERTY, OTHER_ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text),
              ($3::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [ORGANIZATION, PROPERTY, OTHER_ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO pms.message_threads
         (id, property_id, source, source_thread_id, provider_channel, guest_email,
          attention_state, delivery_channel, conversation_context_state, done_at, done_reason,
          version)
       VALUES
         ($1::uuid, $2::uuid, 'channex', 'provider-thread', 'booking.com',
          'guest@example.test', 'done', 'ota', 'unlinked', $5::timestamptz, 'handled', 4),
         ($3::uuid, $4::uuid, 'channex', 'other-thread', 'airbnb',
          'other@example.test', 'needs_attention', 'ota', 'unlinked', NULL, NULL, 4)`,
      [THREAD, PROPERTY, OTHER_THREAD, OTHER_PROPERTY, NOW],
    );
    await admin.query(
      `INSERT INTO pms.channel_connections
         (property_id, provider, connection_status, capabilities, messaging_app_installed)
       VALUES ($1::uuid, 'channex', 'connected', ARRAY['message'], TRUE)`,
      [PROPERTY],
    );
    await admin.query(
      `INSERT INTO platform.media_objects
         (id, bucket, storage_key, storage_kind, visibility, purpose,
          owner_organization_id, property_id, resource_product, resource_type,
          resource_id, lifecycle_status, content_type, size_bytes, original_filename,
          source_metadata, retained_until, created_by_user_id)
       VALUES
         ($1::uuid, 'test-private', 'private/inbox/document.pdf', 'vayada_managed',
          'private', 'pms.messaging.attachment', $2::uuid, $3::uuid, 'pms',
          'message_thread', $4::uuid::text, 'staged', 'application/pdf', 1024,
          'guest-document.pdf', '{"attachmentState":"orphan"}'::jsonb,
          $5::timestamptz + interval '1 hour', $6::uuid),
         ($7::uuid, 'test-private', 'private/inbox/other.pdf', 'vayada_managed',
          'private', 'pms.messaging.attachment', $2::uuid, $8::uuid, 'pms',
          'message_thread', $9::uuid::text, 'staged', 'application/pdf', 1024,
          'other-document.pdf', '{"attachmentState":"orphan"}'::jsonb,
          $5::timestamptz + interval '1 hour', $6::uuid)`,
      [
        MEDIA,
        ORGANIZATION,
        PROPERTY,
        THREAD,
        NOW,
        ACTOR,
        OTHER_MEDIA,
        OTHER_PROPERTY,
        OTHER_THREAD,
      ],
    );
  }

  async function state(messageId: string) {
    const result = await admin.query(
      `SELECT
         jsonb_build_object(
           'messages', (SELECT count(*)::int FROM pms.messages WHERE property_id = $1::uuid),
           'attachments', (SELECT count(*)::int FROM pms.message_attachments WHERE property_id = $1::uuid),
           'idempotency', (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid),
           'events', (SELECT count(*)::int FROM platform.domain_events WHERE property_id = $1::uuid),
           'outbox', (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid),
           'attempts', (SELECT count(*)::int FROM pms.message_delivery_attempts WHERE property_id = $1::uuid),
           'audits', (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id = $1::uuid)
         ) AS counts,
         (SELECT jsonb_build_object(
           'version', version::text, 'attentionState', attention_state,
           'followUpAt', follow_up_at, 'doneAt', done_at,
           'lastDirection', last_message_direction)
          FROM pms.message_threads WHERE property_id = $1::uuid AND id = $2::uuid) AS thread,
         (SELECT jsonb_build_object(
           'direction', direction, 'senderType', sender_type,
           'senderUserId', sender_user_id::text, 'body', body,
           'deliveryState', delivery_state, 'deliveryChannel', delivery_channel,
           'deliveryReasonCode', delivery_reason_code)
          FROM pms.messages WHERE property_id = $1::uuid AND id = $3::uuid) AS message,
         (SELECT jsonb_build_object(
           'lifecycleStatus', lifecycle_status, 'retainedUntil', retained_until,
           'attachmentState', source_metadata ->> 'attachmentState',
           'claimedByMessageId', source_metadata ->> 'claimedByMessageId')
          FROM platform.media_objects WHERE id = $4::uuid) AS media,
         (SELECT jsonb_build_object(
           'eventType', event_type, 'payload', payload, 'metadata', event_metadata)
          FROM platform.domain_events WHERE property_id = $1::uuid LIMIT 1) AS event,
         (SELECT jsonb_build_object(
           'outboxKey', outbox_key, 'eventType', event_type,
           'destination', destination, 'payload', payload)
          FROM platform.outbox_events WHERE property_id = $1::uuid LIMIT 1) AS outbox,
         (SELECT jsonb_agg(jsonb_build_object(
           'action', action, 'redactedPayload', redacted_payload,
           'metadata', audit_metadata) ORDER BY action)
          FROM platform.product_audit_events WHERE property_id = $1::uuid) AS audits`,
      [PROPERTY, THREAD, messageId, MEDIA],
    );
    return result.rows[0] as {
      counts: Record<string, number>;
      thread: Record<string, unknown>;
      message: Record<string, unknown>;
      media: Record<string, unknown>;
      event: Record<string, unknown>;
      outbox: Record<string, unknown> | null;
      audits: Record<string, unknown>[];
    };
  }

  async function cleanup(): Promise<void> {
    if (!admin.database) return;
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      const properties = [PROPERTY, OTHER_PROPERTY];
      for (const statement of [
        "DELETE FROM pms.message_delivery_receipts WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.inbox_email_routes WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_delivery_attempts WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id = ANY($1::uuid[]))",
        "DELETE FROM platform.jobs WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.product_audit_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_attachments WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.messages WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.media_objects WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.channel_connections WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])",
      ])
        await admin.query(statement, [properties]);
      await admin.query("DELETE FROM booking.booking_guests WHERE guest_booking_id = $1::uuid", [
        BOOKING,
      ]);
      await admin.query("DELETE FROM booking.guest_bookings WHERE id = $1::uuid", [BOOKING]);
      for (const statement of [
        "DELETE FROM identity.product_entitlements WHERE organization_id = ANY($1::uuid[])",
        "DELETE FROM identity.organization_resource_links WHERE organization_id = ANY($1::uuid[])",
        "DELETE FROM identity.organization_memberships WHERE organization_id = ANY($1::uuid[])",
      ])
        await admin.query(statement, [[ORGANIZATION, OTHER_ORGANIZATION]]);
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        properties,
      ]);
      await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
        [ORGANIZATION, OTHER_ORGANIZATION],
      ]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [ACTOR]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(connectionString).pathname))
    throw new Error("Refusing to run Inbox reply integration tests outside a test database");
}
