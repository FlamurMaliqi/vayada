import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PlatformMediaInboundAttachmentWriter } from "../platform/platformMediaS3.js";
import { createPgProviderWebhookStore } from "../platform/providerWebhooks.js";
import { runChannexMessageJobs } from "./channexMessages.js";

const URL = process.env["TEST_DATABASE_URL"];
const P = "13720000-0000-4000-8000-000000000001";
const OTHER_P = "13720000-0000-4000-8000-000000000002";
const CONNECTION = "13720000-0000-4000-8000-000000000003";
const OTHER_CONNECTION = "13720000-0000-4000-8000-000000000004";
const BOOKING = "13720000-0000-4000-8000-000000000005";
const USER = "13720000-0000-4000-8000-000000000006";
const ORGANIZATION = "13720000-0000-4000-8000-000000000007";
const MEMBERSHIP = "13720000-0000-4000-8000-000000000008";
const DONE_THREAD = "13720000-0000-4000-8000-000000000009";
const FOLLOW_THREAD = "13720000-0000-4000-8000-000000000010";
const FOLLOW_JOB = "13720000-0000-4000-8000-000000000011";

if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

describe.skipIf(!URL)("Channex message worker (PostgreSQL)", () => {
  const db = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 4 });
  const providerThreads = new Map<string, Record<string, unknown>>();
  const importedAttachmentKeys: string[] = [];
  const deletedAttachmentKeys: string[] = [];
  const storedAttachmentKeys = new Set<string>();
  let sequence = 0;
  let owns = true;

  beforeAll(async () => {
    await cleanup();
    await db.query(
      `INSERT INTO identity.users(id, email, name, status)
       VALUES($1::uuid, 'vay-1372@example.test', 'Inbox Operator', 'active')`,
      [USER],
    );
    await db.query(
      `INSERT INTO identity.organizations(id, kind, name, slug, status)
       VALUES($1::uuid, 'hotel_group', 'VAY 1372', 'vay-1372', 'active')`,
      [ORGANIZATION],
    );
    await db.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key, property_access_mode, access_origin)
       VALUES($1::uuid, $2::uuid, $3::uuid, 'active', 'owner', 'all', 'agency')`,
      [MEMBERSHIP, ORGANIZATION, USER],
    );
    await db.query(
      `INSERT INTO hotel_catalog.properties(id, public_id, display_name, lifecycle_status)
       VALUES($1::uuid, 'vay-1372', 'VAY 1372', 'active'),
             ($2::uuid, 'vay-1372-other', 'VAY 1372 Other', 'active')`,
      [P, OTHER_P],
    );
    await db.query(
      `INSERT INTO pms.channel_binding_claims
         (property_id, provider, external_property_id, claim_state, claim_source)
       VALUES($1::uuid, 'channex', 'chx-vay-1372', 'active', 'repair'),
             ($2::uuid, 'channex', 'chx-vay-1372-other', 'active', 'repair')`,
      [P, OTHER_P],
    );
    await db.query(
      `INSERT INTO pms.channel_connections
         (id, property_id, provider, connection_status, external_property_id,
          capabilities, messaging_app_installed)
       VALUES($1::uuid, $2::uuid, 'channex', 'connected', 'chx-vay-1372',
              ARRAY['message'], TRUE),
             ($3::uuid, $4::uuid, 'channex', 'connected', 'chx-vay-1372-other',
              ARRAY['message'], TRUE)`,
      [CONNECTION, P, OTHER_CONNECTION, OTHER_P],
    );
    await db.query(
      `INSERT INTO booking.guest_bookings
         (id, property_id, public_reference, lifecycle_status, check_in, check_out, currency)
       VALUES($1::uuid, $2::uuid, 'BOOK-VAY-1372', 'confirmed', '2026-09-10',
              '2026-09-13', 'EUR')`,
      [BOOKING, P],
    );
    await db.query(
      `INSERT INTO pms.channel_booking_mappings
         (property_id, connection_id, guest_booking_id, external_booking_id, channel,
          channel_room_index, sync_status)
       VALUES($1::uuid, $2::uuid, $3::uuid, 'booking-vay-1372', 'channex', 0, 'active')`,
      [P, CONNECTION, BOOKING],
    );
    await db.query(
      `INSERT INTO platform.jobs
         (id, job_key, queue_name, job_type, status, tenant_scope, property_id,
          resource_product, resource_type, resource_id, payload, job_metadata)
       VALUES($1::uuid, 'pms.inbox.follow-up.release:vay-1372', 'pms.inbox.follow-up',
              'pms.inbox.follow-up.release', 'pending', 'property', $2::uuid,
              'pms', 'message_thread', $3,
              jsonb_build_object('propertyId', $2::text, 'threadId', $3::text,
                'followUpAt', '2026-10-01T12:00:00.000Z'),
              '{"contractVersion":"native-guest-inbox.v2","action":"release_follow_up"}')`,
      [FOLLOW_JOB, P, FOLLOW_THREAD],
    );
    await db.query(
      `INSERT INTO pms.message_threads
         (id, property_id, guest_booking_id, source, source_thread_id, source_booking_id,
          provider_channel, attention_state, delivery_channel, conversation_context_state,
          unread_count, version, done_at, done_reason)
       VALUES($1::uuid, $2::uuid, $3::uuid, 'channex', 'thread-done', 'booking-vay-1372',
              'booking.com', 'done', 'ota', 'linked', 2, 7, now(), 'handled')`,
      [DONE_THREAD, P, BOOKING],
    );
    await db.query(
      `INSERT INTO pms.message_threads
         (id, property_id, source, source_thread_id, provider_channel, attention_state,
          delivery_channel, conversation_context_state, unread_count, version, follow_up_at,
          follow_up_by_membership_id, follow_up_job_id)
       VALUES($1::uuid, $2::uuid, 'channex', 'thread-follow', 'booking.com', 'follow_up',
              'ota', 'unlinked', 0, 4, '2026-10-01T12:00:00.000Z', $3::uuid, $4::uuid)`,
      [FOLLOW_THREAD, P, MEMBERSHIP, FOLLOW_JOB],
    );
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("projects, deduplicates, orders, links, retries, isolates, and audits messages", async () => {
    const newestJob = await job(
      message({
        threadId: "thread-done",
        messageId: "message-newest",
        bookingId: "booking-vay-1372",
        body: "Newest guest message",
        createdAt: "2026-09-04T12:00:00.000Z",
        attachments: [
          {
            id: "attachment-1",
            links: { url: "attachments/guest-document.pdf" },
            file_name: "guest-document.pdf",
            file_type: "application/pdf",
          },
        ],
      }),
    );
    expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(await thread(DONE_THREAD)).toMatchObject({
      guestBookingId: BOOKING,
      attentionState: "needs_attention",
      conversationContextState: "linked",
      unreadCount: 3,
      version: "8",
      lastMessagePreview: "Newest guest message",
    });
    expect(
      (
        await db.query(
          `SELECT attachment.source_attachment_id AS "sourceAttachmentId",
                  media.visibility, media.purpose, media.storage_kind AS "storageKind",
                  media.lifecycle_status AS "lifecycleStatus", media.source_url AS "sourceUrl",
                  media.storage_key LIKE 'private/%' AS "privateStorage"
           FROM pms.message_attachments attachment
           JOIN platform.media_objects media ON media.id = attachment.platform_media_object_id
           WHERE attachment.property_id = $1::uuid`,
          [P],
        )
      ).rows[0],
    ).toEqual({
      sourceAttachmentId: "attachment-1",
      visibility: "private",
      purpose: "pms.messaging.attachment",
      storageKind: "vayada_managed",
      lifecycleStatus: "active",
      sourceUrl: null,
      privateStorage: true,
    });

    await job(
      message({
        threadId: "thread-attachment-only",
        messageId: "message-attachment-only",
        body: "",
        attachments: ["/api/v1/attachments/attachment-only.pdf"],
      }),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await messageCount("thread-attachment-only")).toBe(1);
    expect(
      (
        await db.query(
          `SELECT raw_payload AS "providerEvidence",
                  pii_retention_until > current_date AS "retentionBounded"
           FROM pms.messages WHERE property_id = $1::uuid AND source_message_id = 'message-newest'`,
          [P],
        )
      ).rows[0],
    ).toMatchObject({
      providerEvidence: {
        provider: "channex",
        providerPropertyId: "chx-vay-1372",
        threadId: "thread-done",
        sourceMessageId: "message-newest",
        sourceBookingId: "booking-vay-1372",
        providerChannel: "booking.com",
        attachmentIds: ["attachment-1"],
      },
      retentionBounded: true,
    });
    expect(await auditCount("pms.inbox.thread.attention_restored_by_inbound")).toBe(1);

    await db.query(
      `UPDATE platform.jobs SET status = 'pending', finished_at = NULL, run_after = now()
       WHERE id = $1::uuid`,
      [newestJob],
    );
    expect((await run()).succeeded).toBe(1);
    expect(await thread(DONE_THREAD)).toMatchObject({ unreadCount: 3, version: "8" });
    expect(await messageCount("thread-done")).toBe(1);
    expect(await auditCount("pms.inbox.thread.attention_restored_by_inbound")).toBe(1);

    await job(
      message({
        threadId: "thread-done",
        messageId: "message-older",
        bookingId: "booking-vay-1372",
        body: "Older guest message",
        createdAt: "2026-09-03T12:00:00.123456",
      }),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await thread(DONE_THREAD)).toMatchObject({
      unreadCount: 4,
      version: "9",
      lastMessagePreview: "Newest guest message",
    });

    owns = false;
    const retryJob = await job(
      message({
        threadId: "thread-unlinked",
        messageId: "message-unlinked",
        bookingId: "booking-not-mapped",
        body: "Unlinked booking message",
      }),
    );
    expect((await run()).retryScheduled).toBe(1);
    owns = true;
    await db.query(`UPDATE platform.jobs SET run_after = now() WHERE id = $1::uuid`, [retryJob]);
    expect((await run()).succeeded).toBe(1);
    expect(await sourceThread("thread-unlinked")).toMatchObject({
      guestBookingId: null,
      sourceBookingId: "booking-not-mapped",
      conversationContextState: "unlinked",
    });

    await job(
      message({
        threadId: "thread-hydrated",
        messageId: "message-hydrated",
        channel: null,
        body: "Metadata omitted by webhook",
      }),
    );
    const hydrate: typeof fetch = async (input) => {
      expect(String(input)).toContain("/api/v1/message_threads/thread-hydrated");
      return Response.json({
        data: {
          id: "thread-hydrated",
          attributes: {
            property_id: "chx-vay-1372",
            provider: "BookingCom",
            title: "Hydrated Guest",
            guest_email: "hydrated@example.test",
          },
          relationships: { booking: { data: { id: "booking-vay-1372" } } },
        },
      });
    };
    expect((await run(hydrate)).succeeded).toBe(1);
    expect(await sourceThread("thread-hydrated")).toMatchObject({
      guestBookingId: BOOKING,
      sourceBookingId: "booking-vay-1372",
      conversationContextState: "linked",
    });

    const foreignHydration = await job(
      message({
        threadId: "thread-hydrated-foreign",
        messageId: "message-hydrated-foreign",
        bookingId: "booking-vay-1372",
        body: "Must not cross the property boundary",
      }),
      1,
    );
    expect(
      (
        await run(async () =>
          Response.json({
            data: {
              id: "thread-hydrated-foreign",
              attributes: {
                property_id: "chx-vay-1372-other",
                provider: "BookingCom",
              },
            },
          }),
        )
      ).deadLettered,
    ).toBe(1);
    expect(await failureCode(foreignHydration)).toBe("provider_thread_property_mismatch");
    expect(await receiptEvidence(foreignHydration)).toEqual({
      failureReason: "provider_thread_property_mismatch",
      payloadPurged: true,
      rawPayload: {},
    });

    await db.query(
      `UPDATE pms.channel_connections SET connection_status = 'degraded' WHERE id = $1::uuid`,
      [CONNECTION],
    );
    await job(
      message({
        threadId: "thread-degraded",
        messageId: "message-degraded",
        bookingId: "booking-not-mapped",
        body: "Delivery continues while health is degraded",
      }),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await sourceThread("thread-degraded")).toBeDefined();
    await db.query(
      `UPDATE pms.channel_connections SET connection_status = 'connected' WHERE id = $1::uuid`,
      [CONNECTION],
    );

    await job(
      message({
        threadId: "thread-inquiry",
        messageId: "message-inquiry",
        channel: "airbnb",
        body: "Is this available?",
        inquiry: {
          id: "inquiry-1",
          arrival_date: "2026-10-10",
          departure_date: "2026-10-12",
          adults: 2,
          children: 1,
        },
      }),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await sourceThread("thread-inquiry")).toMatchObject({
      guestBookingId: null,
      sourceBookingId: "inquiry-1",
      conversationContextState: "inquiry",
      inquiryArrivalDate: "2026-10-10",
      inquiryDepartureDate: "2026-10-12",
      inquiryAdults: 2,
      inquiryChildren: 1,
    });

    const documentedInquiry = await job({
      event: "message",
      property_id: "chx-vay-1372",
      payload: {
        data: {
          id: "message-documented-inquiry",
          type: "message",
          attributes: {
            message: "inquiry",
            sender: "system",
            inserted_at: "2026-09-04T12:00:00.000000",
            attachments: [],
            meta: {
              live_feed_event_id: "live-feed-inquiry-1",
              booking_details: {
                property_id: "chx-vay-1372",
                guest_name: "Stale Andrew",
                checkin_date: "2026-11-02",
                checkout_date: "2026-11-05",
                number_of_adults: 3,
                number_of_children: 0,
              },
            },
          },
          relationships: {
            message_thread: { data: { id: "thread-documented-inquiry" } },
          },
        },
      },
    });
    providerThreads.set("thread-documented-inquiry", {
      data: {
        id: "thread-documented-inquiry",
        attributes: {
          property_id: "chx-vay-1372",
          provider: "AirBNB",
          title: "Andrew",
        },
        relationships: { booking: { data: null } },
      },
    });
    expect((await run()).succeeded).toBe(1);
    expect(await sourceThread("thread-documented-inquiry")).toMatchObject({
      guestBookingId: null,
      guestDisplayName: "Andrew",
      unreadCount: 1,
      sourceBookingId: "live-feed-inquiry-1",
      conversationContextState: "inquiry",
      inquiryArrivalDate: "2026-11-02",
      inquiryDepartureDate: "2026-11-05",
      inquiryAdults: 3,
      inquiryChildren: 0,
    });
    expect(await failureCode(documentedInquiry)).toBeNull();
    expect(
      (
        await db.query(
          `SELECT count(*)::int AS count FROM booking.guest_bookings WHERE property_id = $1`,
          [P],
        )
      ).rows[0].count,
    ).toBe(1);

    await job(
      message({
        threadId: "thread-inquiry",
        messageId: "message-inquiry-converted",
        channel: "airbnb",
        bookingId: "booking-vay-1372",
        body: "The inquiry is now a booking",
      }),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await sourceThread("thread-inquiry")).toMatchObject({
      guestBookingId: BOOKING,
      sourceBookingId: "booking-vay-1372",
      conversationContextState: "linked",
      inquiryArrivalDate: null,
      inquiryDepartureDate: null,
      inquiryAdults: null,
      inquiryChildren: null,
    });

    await job(
      message({
        threadId: "thread-booking-before-inquiry",
        messageId: "message-booking-first",
        channel: "airbnb",
        bookingId: "booking-vay-1372",
        body: "Booking already exists",
      }),
    );
    expect((await run()).succeeded).toBe(1);
    await job(
      message({
        threadId: "thread-booking-before-inquiry",
        messageId: "message-older-inquiry",
        channel: "airbnb",
        body: "Older inquiry",
        createdAt: "2026-09-01T12:00:00.000Z",
        inquiry: {
          id: "inquiry-before-booking",
          arrival_date: "2026-10-15",
          departure_date: "2026-10-17",
          adults: 2,
          children: 0,
        },
      }),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await sourceThread("thread-booking-before-inquiry")).toMatchObject({
      guestBookingId: BOOKING,
      sourceBookingId: "booking-vay-1372",
      conversationContextState: "linked",
      inquiryArrivalDate: null,
      inquiryDepartureDate: null,
    });

    const echoThread = (
      await db.query<{ id: string }>(
        `INSERT INTO pms.message_threads
           (property_id, source, source_thread_id, provider_channel, attention_state,
            delivery_channel, conversation_context_state, unread_count, version)
         VALUES($1::uuid, 'channex', 'thread-outbound-echo', 'booking.com',
                'needs_attention', 'ota', 'unlinked', 0, 1)
         RETURNING id::text`,
        [P],
      )
    ).rows[0]!.id;
    const echoMessage = (
      await db.query<{ id: string }>(
        `INSERT INTO pms.messages
           (property_id, thread_id, source_message_id, direction, sender_type, body, sent_at,
            delivery_state, delivery_channel, pii_retention_until)
         VALUES($1::uuid, $2::uuid, 'manual-reply:echo', 'outbound', 'property_user',
                'Already shown once', now(), 'sent', 'ota', current_date + 365)
         RETURNING id::text`,
        [P, echoThread],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO pms.message_delivery_attempts
         (property_id, message_id, attempt_number, resolved_channel, adapter, outcome,
          scheduled_at, started_at, completed_at, provider_reference)
       VALUES($1::uuid, $2::uuid, 1, 'ota', 'channex', 'accepted', now(), now(), now(),
              'provider-echo-1,provider-echo-2')`,
      [P, echoMessage],
    );
    await job(
      message({
        threadId: "thread-outbound-echo",
        messageId: "provider-echo-2",
        bookingId: "booking-not-mapped",
        body: "Already shown once",
        senderType: "property",
      }),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await messageCount("thread-outbound-echo")).toBe(1);
    expect(await thread(echoThread)).toMatchObject({ unreadCount: 0, version: "1" });

    const raceThread = (
      await db.query<{ id: string }>(
        `INSERT INTO pms.message_threads
           (property_id, source, source_thread_id, provider_channel, attention_state,
            delivery_channel, conversation_context_state, unread_count, version)
         VALUES($1::uuid, 'channex', 'thread-outbound-race', 'booking.com',
                'needs_attention', 'ota', 'unlinked', 0, 1)
         RETURNING id::text`,
        [P],
      )
    ).rows[0]!.id;
    const raceMessage = (
      await db.query<{ id: string }>(
        `INSERT INTO pms.messages
           (property_id, thread_id, source_message_id, direction, sender_type, body, sent_at,
            delivery_state, delivery_channel, pii_retention_until)
         VALUES($1::uuid, $2::uuid, 'manual-reply:race', 'outbound', 'property_user',
                'Sending now', now(), 'queued', 'ota', current_date + 365)
         RETURNING id::text`,
        [P, raceThread],
      )
    ).rows[0]!.id;
    const raceAttempt = (
      await db.query<{ id: string }>(
        `INSERT INTO pms.message_delivery_attempts
           (property_id, message_id, attempt_number, resolved_channel, adapter, outcome,
            scheduled_at, started_at)
         VALUES($1::uuid, $2::uuid, 1, 'ota', 'channex', 'running', now(), now())
         RETURNING id::text`,
        [P, raceMessage],
      )
    ).rows[0]!.id;
    const raceJob = await job(
      message({
        threadId: "thread-outbound-race",
        messageId: "provider-race-echo",
        bookingId: "booking-not-mapped",
        body: "Sending now",
        senderType: "property",
      }),
    );
    expect((await run()).retryScheduled).toBe(1);
    expect(await failureCode(raceJob)).toBe("outbound_delivery_in_flight");
    expect(await messageCount("thread-outbound-race")).toBe(1);
    await db.query(
      `UPDATE pms.message_delivery_attempts
       SET outcome = 'accepted', completed_at = now(), provider_reference = 'provider-race-echo'
       WHERE id = $1::uuid`,
      [raceAttempt],
    );
    await db.query(`UPDATE platform.jobs SET run_after = now() WHERE id = $1::uuid`, [raceJob]);
    expect((await run()).succeeded).toBe(1);
    expect(await messageCount("thread-outbound-race")).toBe(1);

    await job(
      message({
        threadId: "thread-follow",
        messageId: "message-follow",
        bookingId: "booking-follow-unmapped",
        body: "I have another question",
      }),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await thread(FOLLOW_THREAD)).toMatchObject({
      attentionState: "needs_attention",
      unreadCount: 1,
      version: "5",
      followUpJobId: null,
    });
    expect(
      (await db.query(`SELECT status FROM platform.jobs WHERE id = $1::uuid`, [FOLLOW_JOB])).rows[0]
        .status,
    ).toBe("canceled");

    const foreign = await job(
      message({
        threadId: "thread-foreign",
        messageId: "message-foreign",
        bookingId: "booking-foreign",
        body: "Wrong property",
        providerPropertyId: "chx-vay-1372-other",
      }),
      1,
    );
    expect((await run()).deadLettered).toBe(1);
    expect(
      (
        await db.query(
          `SELECT job.status,
                  job.job_metadata->>'lastErrorCode' AS "failureCode",
                  (SELECT count(*)::int FROM platform.dead_letter_events dead
                   WHERE dead.job_id = job.id) AS dead_letters
           FROM platform.jobs job WHERE job.id = $1::uuid`,
          [foreign],
        )
      ).rows[0],
    ).toEqual({ status: "dead_lettered", failureCode: "cross_property_message", dead_letters: 1 });
    expect(await sourceThread("thread-foreign")).toBeUndefined();

    const mismatchedEnvelope = message({
      threadId: "thread-mismatched-envelope",
      messageId: "message-mismatched-envelope",
      bookingId: "booking-not-mapped",
      body: "Conflicting property identifiers",
    });
    (mismatchedEnvelope["payload"] as Record<string, unknown>)["property_id"] =
      "chx-vay-1372-other";
    const mismatchedEnvelopeJob = await job(mismatchedEnvelope, 1);
    expect((await run()).deadLettered).toBe(1);
    expect(await failureCode(mismatchedEnvelopeJob)).toBe("invalid_job_payload");
    expect(await sourceThread("thread-mismatched-envelope")).toBeUndefined();

    const mismatchedScopeJob = await job(
      message({
        threadId: "thread-mismatched-scope",
        messageId: "message-mismatched-scope",
        bookingId: "booking-not-mapped",
        body: "Wrong job scope",
      }),
      1,
      P,
      OTHER_P,
    );
    expect((await run()).deadLettered).toBe(1);
    expect(await failureCode(mismatchedScopeJob)).toBe("invalid_job_payload");
    expect(await sourceThread("thread-mismatched-scope")).toBeUndefined();

    const poisonJob = (
      await db.query<{ id: string }>(
        `INSERT INTO platform.jobs
           (job_key, queue_name, job_type, status, tenant_scope, priority,
            resource_product, resource_type, resource_id, max_attempts, payload)
         VALUES($1, 'pms.channex.webhooks', 'channex.ingest-message', 'pending', 'platform', 100,
                'pms', 'channel_message', 'message-invalid-scope', 1,
                jsonb_build_object('provider', 'channex', 'propertyId', $2::text,
                  'providerPropertyId', 'chx-vay-1372', 'threadId', 'thread-invalid-scope',
                  'sourceMessageId', 'message-invalid-scope',
                  'receiptId', '13720000-0000-4000-8000-000000000099'))
         RETURNING id::text`,
        [`vay-1372:${++sequence}:invalid-scope`, P],
      )
    ).rows[0]!.id;
    await job(
      message({
        threadId: "thread-after-poison",
        messageId: "message-after-poison",
        body: "The queue continues after malformed scope",
      }),
    );
    expect((await run()).deadLettered).toBe(1);
    expect(await failureCode(poisonJob)).toBe("invalid_job_payload");
    expect((await run()).succeeded).toBe(1);
    expect(await sourceThread("thread-after-poison")).toBeDefined();

    let offOriginRequest = false;
    const redirectJob = await job(
      message({
        threadId: "thread-attachment-redirect",
        messageId: "message-attachment-redirect",
        body: "Redirected attachment",
        attachments: [{ id: "redirect", url: "attachments/redirect.pdf" }],
      }),
      1,
    );
    const redirectFetch: typeof fetch = async (input, init) => {
      const requestUrl = new globalThis.URL(input instanceof Request ? input.url : String(input));
      if (requestUrl.hostname === "attacker.example") {
        offOriginRequest = true;
        return new Response("leaked");
      }
      if (requestUrl.pathname.includes("/api/v1/attachments/")) {
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("user-api-key")).toBe("secret");
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/private.pdf" },
        });
      }
      return fetchProviderThread(input, init);
    };
    expect((await run(redirectFetch)).deadLettered).toBe(1);
    expect(await failureCode(redirectJob)).toBe("invalid_message_attachment_url");
    expect(offOriginRequest).toBe(false);

    const stagedKeys = new Set<string>();
    let stagedImport = 0;
    const partialImportJob = await job(
      message({
        threadId: "thread-partial-attachment-import",
        messageId: "message-partial-attachment-import",
        body: "Two attachments",
        attachments: [
          { id: "valid-first", url: "attachments/valid-first.pdf" },
          { id: "invalid-second", url: "attachments/invalid-second.pdf" },
        ],
      }),
      1,
    );
    const partialAttachmentMedia = {
      async preparePrivateAttachment(input: {
        mediaId: string;
        bytes: Uint8Array;
        contentType: string;
      }) {
        stagedImport += 1;
        if (stagedImport === 2) return { ok: false as const, code: "media_type_mismatch" as const };
        const storageKey = `private/media/${input.mediaId}/provider_original/valid-first.pdf`;
        return {
          ok: true as const,
          bucketName: "vayada-media-test",
          storageKey,
          contentType: input.contentType,
          sizeBytes: input.bytes.length,
          checksumSha256: "b".repeat(64),
          widthPx: null,
          heightPx: null,
        };
      },
      async uploadPrivateAttachment(input: {
        prepared: { storageKey: string };
        bytes: Uint8Array;
      }) {
        expect(input.bytes.length).toBeGreaterThan(0);
        stagedKeys.add(input.prepared.storageKey);
      },
      async deleteObject(input: { bucket: string; storageKey: string }) {
        expect(input.bucket).toBe("vayada-media-test");
        stagedKeys.delete(input.storageKey);
      },
    };
    expect((await run(fetchProviderThread, partialAttachmentMedia)).deadLettered).toBe(1);
    expect(await failureCode(partialImportJob)).toBe("invalid_message_attachment");
    expect(stagedKeys.size).toBe(0);

    await db.query(
      `UPDATE platform.media_objects SET retained_until = now() - interval '1 minute'
       WHERE property_id = $1::uuid
         AND source_metadata->>'sourceMessageId' = 'message-partial-attachment-import'`,
      [P],
    );
    const expiredStagedMedia = {
      async preparePrivateAttachment(input: {
        mediaId: string;
        bytes: Uint8Array;
        contentType: string;
      }) {
        return {
          ok: true as const,
          bucketName: "vayada-media-test",
          storageKey: `private/media/${input.mediaId}/provider_original/valid-first.pdf`,
          contentType: input.contentType,
          sizeBytes: input.bytes.length,
          checksumSha256: "b".repeat(64),
          widthPx: null,
          heightPx: null,
        };
      },
      async uploadPrivateAttachment() {},
      async deleteObject() {},
    };
    await job(
      message({
        threadId: "thread-partial-attachment-import",
        messageId: "message-partial-attachment-import",
        body: "Replay the expired staged attachment",
        attachments: [{ id: "valid-first", url: "attachments/valid-first.pdf" }],
      }),
    );
    expect((await run(fetchProviderThread, expiredStagedMedia)).succeeded).toBe(1);
    expect(
      (
        await db.query(
          `SELECT lifecycle_status AS "lifecycleStatus", retained_until > now() AS "retentionRenewed"
           FROM platform.media_objects
           WHERE property_id = $1::uuid
             AND source_metadata->>'sourceMessageId' = 'message-partial-attachment-import'`,
          [P],
        )
      ).rows[0],
    ).toEqual({ lifecycleStatus: "active", retentionRenewed: true });

    let cleanupFailurePrepare = 0;
    const cleanupFailureMedia = {
      async preparePrivateAttachment(input: {
        mediaId: string;
        bytes: Uint8Array;
        contentType: string;
      }) {
        cleanupFailurePrepare += 1;
        if (cleanupFailurePrepare % 2 === 0)
          return { ok: false as const, code: "media_type_mismatch" as const };
        return {
          ok: true as const,
          bucketName: "vayada-media-test",
          storageKey: `private/media/${input.mediaId}/provider_original/cleanup-failure.pdf`,
          contentType: input.contentType,
          sizeBytes: input.bytes.length,
          checksumSha256: "c".repeat(64),
          widthPx: null,
          heightPx: null,
        };
      },
      async uploadPrivateAttachment() {},
      async deleteObject() {
        throw new Error("storage unavailable");
      },
    };
    const cleanupFailureJob = await job(
      message({
        threadId: "thread-attachment-cleanup-failure",
        messageId: "message-attachment-cleanup-failure",
        body: "Cleanup must remain discoverable",
        attachments: [
          { id: "cleanup-first", url: "attachments/cleanup-first.pdf" },
          { id: "cleanup-second", url: "attachments/cleanup-second.pdf" },
        ],
      }),
      2,
    );
    expect((await run(fetchProviderThread, cleanupFailureMedia)).retryScheduled).toBe(1);
    await db.query(`UPDATE platform.jobs SET run_after = now() WHERE id = $1::uuid`, [
      cleanupFailureJob,
    ]);
    expect((await run(fetchProviderThread, cleanupFailureMedia)).deadLettered).toBe(1);
    expect(await failureCode(cleanupFailureJob)).toBe("attachment_cleanup_unavailable");
    expect(
      (
        await db.query(
          `SELECT lifecycle_status AS "lifecycleStatus", bucket,
                  storage_key AS "storageKey", retained_until > now() AS "cleanupScheduled"
           FROM platform.media_objects
           WHERE property_id = $1::uuid
             AND source_metadata->>'sourceMessageId' = 'message-attachment-cleanup-failure'`,
          [P],
        )
      ).rows[0],
    ).toMatchObject({
      lifecycleStatus: "staged",
      bucket: "vayada-media-test",
      storageKey: expect.stringContaining("cleanup-failure.pdf"),
      cleanupScheduled: true,
    });

    await db.query(
      `INSERT INTO pms.message_threads
         (property_id, source, source_thread_id, provider_channel, attention_state,
          delivery_channel, conversation_context_state, unread_count, version)
       VALUES($1::uuid, 'channex', 'thread-attachment-db-failure', 'airbnb',
              'needs_attention', 'ota', 'unlinked', 0, 1)`,
      [P],
    );
    const importedBeforeFailure = importedAttachmentKeys.length;
    const deletedBeforeFailure = deletedAttachmentKeys.length;
    const attachmentDbFailureJob = await job(
      message({
        threadId: "thread-attachment-db-failure",
        messageId: "message-attachment-db-failure",
        channel: "booking_com",
        body: "Conflicting thread after attachment import",
        attachments: [{ id: "db-failure", url: "attachments/db-failure.pdf" }],
      }),
      1,
    );
    expect((await run()).deadLettered).toBe(1);
    expect(await failureCode(attachmentDbFailureJob)).toBe("thread_channel_conflict");
    const failedImportKey = importedAttachmentKeys[importedBeforeFailure];
    expect(failedImportKey).toBeDefined();
    expect(deletedAttachmentKeys.slice(deletedBeforeFailure)).toContain(failedImportKey);
    expect(storedAttachmentKeys.has(failedImportKey!)).toBe(false);

    await db.query(
      `UPDATE platform.media_objects
       SET lifecycle_status = 'deleted', retained_until = now() - interval '1 day',
           deletion_requested_at = now(), deleted_at = now()
       WHERE property_id = $1::uuid
         AND source_metadata->>'sourceMessageId' = 'message-attachment-db-failure'`,
      [P],
    );
    await db.query(
      `DELETE FROM pms.message_threads
       WHERE property_id = $1::uuid AND source_thread_id = 'thread-attachment-db-failure'`,
      [P],
    );
    await job(
      message({
        threadId: "thread-attachment-db-failure",
        messageId: "message-attachment-db-failure",
        channel: "booking_com",
        body: "Replay after staged attachment cleanup",
        attachments: [{ id: "db-failure", url: "attachments/db-failure.pdf" }],
      }),
    );
    expect((await run()).succeeded).toBe(1);
    expect(
      (
        await db.query(
          `SELECT lifecycle_status AS "lifecycleStatus", deleted_at AS "deletedAt",
                  source_metadata->>'attachmentState' AS "attachmentState"
           FROM platform.media_objects
           WHERE property_id = $1::uuid
             AND source_metadata->>'sourceMessageId' = 'message-attachment-db-failure'`,
          [P],
        )
      ).rows[0],
    ).toMatchObject({ lifecycleStatus: "active", deletedAt: null, attachmentState: "claimed" });

    await job(
      message({
        threadId: "thread-other-property",
        messageId: "message-newest",
        bookingId: "booking-other-unmapped",
        body: "Same provider ID at another hotel",
        providerPropertyId: "chx-vay-1372-other",
      }),
      5,
      OTHER_P,
    );
    expect((await run()).succeeded).toBe(1);
    expect(
      (
        await db.query(
          `SELECT count(*)::int AS count, count(DISTINCT property_id)::int AS properties
           FROM pms.messages WHERE source_message_id = 'message-newest'`,
        )
      ).rows[0],
    ).toEqual({ count: 2, properties: 2 });

    const retainedReceipt = (
      await db.query<{ id: string }>(
        `INSERT INTO platform.external_webhook_events
           (provider, provider_event_id, event_type, delivery_status, signature_verified,
            payload_hash, raw_headers, raw_payload, payload_retention_until)
         VALUES('channex', 'vay-1372:retention', 'message', 'observed', TRUE,
                'sha256:vay-1372', '{"signature":"private"}', '{"body":"private"}',
                now() - interval '1 minute')
         RETURNING id::text`,
      )
    ).rows[0]!.id;
    const retainedEvent = (
      await db.query<{ id: string }>(
        `INSERT INTO platform.domain_events
           (source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
            resource_product, resource_type, resource_id, actor_type, causation_id, payload)
         VALUES('external', 'vay-1372:retention', 'channex.message.ingest', now(),
                'property', $1::uuid, 'pms', 'channel_message', 'retention', 'provider', $2,
                '{"sourceMessageId":"retention"}')
         RETURNING id::text`,
        [P, retainedReceipt],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO platform.jobs
         (job_key, queue_name, job_type, source_domain_event_id, tenant_scope, property_id,
          resource_product, resource_type, resource_id, payload)
       VALUES('vay-1372:retention', 'pms.channex.webhooks', 'channex.ingest-message',
              $1::uuid, 'property', $2::uuid, 'pms', 'channel_message', 'retention',
              '{"propertyId":"13720000-0000-4000-8000-000000000001",
                "rawPayload":{"body":"private"}}')`,
      [retainedEvent, P],
    );
    expect(
      (
        await db.query<{ count: number }>(
          `SELECT platform.purge_expired_channex_message_webhook_receipts() AS count`,
        )
      ).rows[0]!.count,
    ).toBe(1);
    expect(
      (
        await db.query(
          `SELECT receipt.raw_payload = '{}'::jsonb AS "receiptPurged",
                  NOT (job.payload ? 'rawPayload') AS "jobPurged"
           FROM platform.external_webhook_events receipt
           JOIN platform.domain_events event ON event.causation_id = receipt.id::text
           JOIN platform.jobs job ON job.source_domain_event_id = event.id
           WHERE receipt.id = $1::uuid`,
          [retainedReceipt],
        )
      ).rows[0],
    ).toEqual({ receiptPurged: true, jobPurged: true });

    const promotionPreview = {
      domainEventKey: "vay-1372:promotion",
      domainEventType: "channex.message.ingest",
      resourceProduct: "pms" as const,
      resourceType: "channel_message",
      resourceId: "vay-1372-promoted-message",
      jobKey: "vay-1372:promotion",
      queueName: "pms.channex.webhooks",
      jobType: "channex.ingest-message",
      payload: {
        provider: "channex",
        propertyId: P,
        providerPropertyId: "chx-vay-1372",
        propertyOwnerResolved: true,
        threadId: "vay-1372-promoted-thread",
        sourceMessageId: "vay-1372-promoted-message",
        rawPayload: { body: "private" },
      },
    };
    const webhookStore = createPgProviderWebhookStore({ connectionString: URL! });
    const promotionReceipt = await webhookStore.recordReceipt({
      provider: "channex",
      providerEventId: "vay-1372:promotion",
      receiptKey: "webhook:channex:vay-1372:promotion",
      receiptKeyHash: "sha256:vay-1372-receipt-key",
      eventType: "message",
      payloadHash: "sha256:vay-1372-promotion",
      rawHeaders: {},
      rawPayload: { property_id: "chx-vay-1372", payload: { body: "private" } },
      mode: "mutating",
      normalizedPreview: promotionPreview,
    });
    expect(promotionReceipt).toMatchObject({ status: "inserted", lifecycleStatus: "observed" });
    await expect(
      webhookStore.promoteReceipt({
        provider: "channex",
        receiptId: promotionReceipt.receiptId,
        receiptKey: "webhook:channex:vay-1372:promotion",
        receiptKeyHash: "sha256:vay-1372-receipt-key",
        payloadHash: "sha256:vay-1372-promotion",
        rawPayload: { property_id: "chx-vay-1372", payload: { body: "private" } },
        normalizedPreview: promotionPreview,
      }),
    ).resolves.toMatchObject({ status: "promoted" });

    const unknownProviderPropertyId = "13720000-0000-4000-8000-000000009999";
    const unresolvedPreview = {
      ...promotionPreview,
      domainEventKey: "vay-1372:unresolved-uuid-property",
      resourceId: "vay-1372-unresolved-message",
      jobKey: "vay-1372:unresolved-uuid-property",
      payload: {
        ...promotionPreview.payload,
        propertyId: unknownProviderPropertyId,
        providerPropertyId: unknownProviderPropertyId,
        propertyOwnerResolved: false,
        sourceMessageId: "vay-1372-unresolved-message",
      },
    };
    const unresolvedReceipt = await webhookStore.recordReceipt({
      provider: "channex",
      providerEventId: "vay-1372:unresolved-uuid-property",
      receiptKey: "webhook:channex:vay-1372:unresolved-uuid-property",
      receiptKeyHash: "sha256:vay-1372-unresolved-receipt-key",
      eventType: "message",
      payloadHash: "sha256:vay-1372-unresolved-promotion",
      rawHeaders: {},
      rawPayload: { property_id: unknownProviderPropertyId },
      mode: "observe_only",
      normalizedPreview: unresolvedPreview,
    });
    expect(
      (
        await db.query(
          `SELECT tenant_scope AS "tenantScope", property_id::text AS "propertyId"
           FROM platform.external_webhook_events WHERE id = $1::uuid`,
          [unresolvedReceipt.receiptId],
        )
      ).rows[0],
    ).toEqual({ tenantScope: "external", propertyId: null });
    await webhookStore.close?.();
    expect(
      (
        await db.query(
          `SELECT event.tenant_scope AS "eventScope", event.property_id::text AS "eventPropertyId",
                  event.payload ? 'rawPayload' AS "eventHasRawPayload",
                  job.tenant_scope AS "jobScope", job.property_id::text AS "jobPropertyId",
                  job.payload ? 'rawPayload' AS "jobHasRawPayload"
           FROM platform.domain_events event
           JOIN platform.jobs job ON job.source_domain_event_id = event.id
           WHERE event.event_key = 'vay-1372:promotion'`,
        )
      ).rows[0],
    ).toEqual({
      eventScope: "property",
      eventPropertyId: P,
      eventHasRawPayload: false,
      jobScope: "property",
      jobPropertyId: P,
      jobHasRawPayload: false,
    });

    const leaked = (
      await db.query<{ leaked: boolean }>(
        `SELECT COALESCE(bool_or(redacted_payload::text LIKE '%Newest guest message%'
                    OR redacted_payload::text LIKE '%guest-document.pdf%'), FALSE) AS leaked
         FROM platform.product_audit_events
         WHERE redacted_payload->>'propertyId' = $1 OR property_id = $1::uuid`,
        [P],
      )
    ).rows[0]!.leaked;
    expect(leaked).toBe(false);
  }, 20_000);

  const attachmentMedia = {
    async preparePrivateAttachment(input: {
      mediaId: string;
      bytes: Uint8Array;
      contentType: string;
    }) {
      const storageKey = `private/media/${input.mediaId}/provider_original/test.pdf`;
      return {
        ok: true as const,
        bucketName: "vayada-media-test",
        storageKey,
        contentType: input.contentType,
        sizeBytes: input.bytes.length,
        checksumSha256: "a".repeat(64),
        widthPx: null,
        heightPx: null,
      };
    },
    async uploadPrivateAttachment(input: { prepared: { storageKey: string }; bytes: Uint8Array }) {
      expect(input.bytes.length).toBeGreaterThan(0);
      importedAttachmentKeys.push(input.prepared.storageKey);
      storedAttachmentKeys.add(input.prepared.storageKey);
    },
    async deleteObject(input: { bucket: string; storageKey: string }) {
      expect(input.bucket).toBe("vayada-media-test");
      deletedAttachmentKeys.push(input.storageKey);
      storedAttachmentKeys.delete(input.storageKey);
    },
  };

  function run(
    request: typeof fetch = fetchProviderThread,
    media: PlatformMediaInboundAttachmentWriter = attachmentMedia,
  ) {
    return runChannexMessageJobs(URL!, {
      apiBaseUrl: "https://app.channex.io",
      apiKey: "secret",
      ownsMutation: () => owns,
      fetch: request,
      attachmentMedia: media,
      workerId: "vay-1372",
      limit: 1,
    });
  }

  async function job(
    rawPayload: Record<string, unknown>,
    maxAttempts = 5,
    propertyId = P,
    scopePropertyId = propertyId,
  ): Promise<string> {
    const payload = rawPayload["payload"] as Record<string, unknown>;
    const data = (payload["data"] as Record<string, unknown> | undefined) ?? payload;
    const attributes = (data["attributes"] as Record<string, unknown> | undefined) ?? data;
    const relationships = (data["relationships"] as Record<string, unknown> | undefined) ?? {};
    const messageThreadRelationship = relationships["message_thread"] as
      | Record<string, unknown>
      | undefined;
    const messageThread =
      (messageThreadRelationship?.["data"] as Record<string, unknown> | undefined) ?? {};
    const messageId = String(payload["message_id"] ?? data["id"]);
    const threadId = String(payload["thread_id"] ?? messageThread["id"]);
    const providerPropertyId = String(rawPayload["property_id"]);
    const jobSequence = ++sequence;
    const inquiry = (payload["inquiry"] ?? attributes["inquiry"]) as
      | Record<string, unknown>
      | undefined;
    providerThreads.set(threadId, {
      data: {
        id: threadId,
        attributes: {
          property_id: providerPropertyId,
          provider: payload["channel"] ?? attributes["channel"] ?? "booking_com",
          title: "Ada Guest",
          ...(inquiry ? { inquiry } : {}),
        },
        relationships: {
          booking: {
            data: payload["channel_booking_id"] ? { id: payload["channel_booking_id"] } : null,
          },
        },
      },
    });
    const receipt = await db.query<{ id: string }>(
      `INSERT INTO platform.external_webhook_events
         (provider, provider_event_id, webhook_key_hash, event_type, delivery_status,
          signature_verified, payload_hash, raw_headers, raw_payload, tenant_scope, property_id,
          payload_retention_until)
       VALUES('channex', $1, $2, 'message', 'observed', TRUE, $3, '{}'::jsonb, $4::jsonb,
              'property', $5::uuid, now() + interval '30 days')
       RETURNING id::text`,
      [
        `vay-1372:job-receipt:${jobSequence}`,
        `sha256:vay-1372-job-receipt:${jobSequence}`,
        `sha256:vay-1372-job-payload:${jobSequence}`,
        JSON.stringify(rawPayload),
        scopePropertyId,
      ],
    );
    const result = await db.query<{ id: string }>(
      `INSERT INTO platform.jobs
         (job_key, queue_name, job_type, tenant_scope, property_id, resource_product, resource_type,
          resource_id, correlation_id, max_attempts, payload)
       VALUES($1, 'pms.channex.webhooks', 'channex.ingest-message', 'property', $4::uuid, 'pms',
              'channel_message', $2, 'vay-1372', $3, $5::jsonb)
       RETURNING id::text`,
      [
        `vay-1372:${jobSequence}`,
        messageId,
        maxAttempts,
        scopePropertyId,
        JSON.stringify({
          provider: "channex",
          propertyId,
          providerPropertyId,
          propertyOwnerResolved: true,
          threadId,
          sourceMessageId: messageId,
          receiptId: receipt.rows[0]!.id,
          receiptKey: `webhook:channex:vay-1372:${jobSequence}`,
        }),
      ],
    );
    return result.rows[0]!.id;
  }

  const fetchProviderThread: typeof fetch = async (input) => {
    const url = new globalThis.URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes("/api/v1/attachments/")) {
      return new Response("%PDF-1.7\nVayada attachment", {
        headers: { "content-type": "application/pdf" },
      });
    }
    const threadId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    const response = providerThreads.get(threadId);
    return response ? Response.json(response) : new Response(null, { status: 404 });
  };

  function message(input: {
    threadId: string;
    messageId: string;
    body: string;
    providerPropertyId?: string;
    channel?: string | null;
    bookingId?: string;
    createdAt?: string;
    attachments?: Array<Record<string, unknown> | string>;
    inquiry?: Record<string, unknown>;
    senderType?: string;
  }): Record<string, unknown> {
    const providerPropertyId = input.providerPropertyId ?? "chx-vay-1372";
    return {
      event: "message",
      property_id: providerPropertyId,
      payload: {
        property_id: providerPropertyId,
        thread_id: input.threadId,
        message_id: input.messageId,
        ...(input.channel === null ? {} : { channel: input.channel ?? "booking_com" }),
        ...(input.bookingId ? { channel_booking_id: input.bookingId } : {}),
        sender: { type: input.senderType ?? "guest", name: "Ada Guest" },
        body: input.body,
        created_at: input.createdAt ?? "2026-09-04T12:00:00.000Z",
        attachments: input.attachments ?? [],
        ...(input.inquiry ? { inquiry: input.inquiry, message_type: "inquiry" } : {}),
      },
    };
  }

  async function thread(threadId: string) {
    return (
      await db.query(
        `SELECT guest_booking_id::text AS "guestBookingId", attention_state AS "attentionState",
                conversation_context_state AS "conversationContextState", unread_count AS "unreadCount",
                version::text, last_message_preview AS "lastMessagePreview",
                follow_up_job_id::text AS "followUpJobId"
         FROM pms.message_threads WHERE id = $1::uuid`,
        [threadId],
      )
    ).rows[0];
  }

  async function sourceThread(sourceThreadId: string) {
    return (
      await db.query(
        `SELECT guest_booking_id::text AS "guestBookingId", source_booking_id AS "sourceBookingId",
                guest_display_name AS "guestDisplayName",
                conversation_context_state AS "conversationContextState",
                unread_count AS "unreadCount",
                inquiry_arrival_date::text AS "inquiryArrivalDate",
                inquiry_departure_date::text AS "inquiryDepartureDate",
                inquiry_adults AS "inquiryAdults", inquiry_children AS "inquiryChildren"
         FROM pms.message_threads WHERE property_id = $1::uuid AND source_thread_id = $2`,
        [P, sourceThreadId],
      )
    ).rows[0];
  }

  async function messageCount(sourceThreadId: string): Promise<number> {
    return (
      await db.query(
        `SELECT count(*)::int AS count FROM pms.messages message
         JOIN pms.message_threads thread ON thread.id = message.thread_id
         WHERE thread.property_id = $1::uuid AND thread.source_thread_id = $2`,
        [P, sourceThreadId],
      )
    ).rows[0].count;
  }

  async function auditCount(action: string): Promise<number> {
    return (
      await db.query(
        `SELECT count(*)::int AS count FROM platform.product_audit_events
         WHERE property_id = $1::uuid AND action = $2`,
        [P, action],
      )
    ).rows[0].count;
  }

  async function failureCode(jobId: string): Promise<string | null> {
    return (
      (
        await db.query<{ failureCode: string | null }>(
          `SELECT job_metadata ->> 'lastErrorCode' AS "failureCode"
         FROM platform.jobs WHERE id = $1::uuid`,
          [jobId],
        )
      ).rows[0]?.failureCode ?? null
    );
  }

  async function receiptEvidence(jobId: string) {
    return (
      await db.query(
        `SELECT receipt.failure_reason AS "failureReason",
                receipt.payload_purged_at IS NOT NULL AS "payloadPurged",
                receipt.raw_payload AS "rawPayload"
         FROM platform.jobs job
         JOIN platform.external_webhook_events receipt
           ON receipt.id = (job.payload ->> 'receiptId')::uuid
         WHERE job.id = $1::uuid`,
        [jobId],
      )
    ).rows[0];
  }

  async function cleanup(): Promise<void> {
    providerThreads.clear();
    await db.query(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       DELETE FROM platform.product_audit_events
       WHERE property_id IN ('${P}', '${OTHER_P}')
          OR job_id IN (SELECT id FROM platform.jobs WHERE job_key LIKE 'vay-1372:%'
                         OR id = '${FOLLOW_JOB}');
       DELETE FROM platform.dead_letter_events
       WHERE job_id IN (SELECT id FROM platform.jobs WHERE job_key LIKE 'vay-1372:%'
                         OR id = '${FOLLOW_JOB}');
       DELETE FROM platform.job_attempts
       WHERE job_id IN (SELECT id FROM platform.jobs WHERE job_key LIKE 'vay-1372:%'
                         OR id = '${FOLLOW_JOB}');
       DELETE FROM pms.message_attachments WHERE property_id IN ('${P}', '${OTHER_P}');
       DELETE FROM platform.media_variants
       WHERE media_object_id IN (
         SELECT id FROM platform.media_objects
         WHERE property_id IN ('${P}', '${OTHER_P}') AND source_table = 'message_attachments'
       ) OR storage_key LIKE 'private/media/%/provider_original/test.pdf';
       DELETE FROM platform.media_objects
       WHERE property_id IN ('${P}', '${OTHER_P}') AND source_table = 'message_attachments';
       DELETE FROM pms.messages WHERE property_id IN ('${P}', '${OTHER_P}');
       DELETE FROM pms.message_threads WHERE property_id IN ('${P}', '${OTHER_P}');
       DELETE FROM platform.jobs WHERE job_key LIKE 'vay-1372:%' OR id = '${FOLLOW_JOB}';
       DELETE FROM platform.domain_events WHERE event_key LIKE 'vay-1372:%';
       DELETE FROM platform.external_webhook_events WHERE provider_event_id LIKE 'vay-1372:%';
       DELETE FROM platform.idempotency_keys
       WHERE response_resource_id = 'vay-1372-promoted-message';
       DELETE FROM pms.channel_booking_mappings WHERE property_id IN ('${P}', '${OTHER_P}');
       DELETE FROM booking.booking_guests WHERE guest_booking_id = '${BOOKING}';
       DELETE FROM booking.guest_bookings WHERE id = '${BOOKING}';
       DELETE FROM pms.channel_connections WHERE property_id IN ('${P}', '${OTHER_P}');
       DELETE FROM pms.channel_binding_claims WHERE property_id IN ('${P}', '${OTHER_P}');
       DELETE FROM identity.organization_memberships WHERE id = '${MEMBERSHIP}';
       DELETE FROM identity.organizations WHERE id = '${ORGANIZATION}';
       DELETE FROM identity.users WHERE id = '${USER}';
       DELETE FROM hotel_catalog.properties WHERE id IN ('${P}', '${OTHER_P}');
       COMMIT`,
    );
  }
});
