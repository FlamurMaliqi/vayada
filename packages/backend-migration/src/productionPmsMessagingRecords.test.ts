import { describe, expect, it } from "vitest";

import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildPmsMessagingRecords } from "./productionPmsMessagingRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const BOOKING = "30000000-0000-4000-a000-000000000001";
const THREAD = "40000000-0000-4000-a000-000000000001";
const MESSAGE = "50000000-0000-4000-a000-000000000001";
const ATTACHMENT = "60000000-0000-4000-a000-000000000001";
const MEDIA = "70000000-0000-4000-a000-000000000001";

describe("production PMS messaging", () => {
  it("preserves private thread, message, and attachment state", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: target([MEDIA]),
    });
    const records = buildPmsMessagingRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records.map((record) => record.targetTable)).toEqual([
      "message_threads",
      "messages",
      "message_attachments",
    ]);
    expect(records.find((record) => record.targetTable === "messages")?.row).toMatchObject({
      direction: "inbound",
      senderType: "guest",
      piiRetentionUntil: "2027-09-03",
    });
    expect(records.find((record) => record.targetTable === "messages")).toMatchObject({
      mutable: true,
      sourceUpdatedAt: "2026-09-01T12:01:00.000Z",
    });
    expect(
      records.find((record) => record.targetTable === "message_attachments")?.row,
    ).toMatchObject({
      platformMediaObjectId: MEDIA,
      propertyId: PROPERTY,
      s3Key: `private/media/${MEDIA}/provider_original/sha256-file.pdf`,
      sourceUrl: null,
    });
  });

  it("blocks attachments until their Platform Media object exists", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: target([]),
    });
    buildPmsMessagingRecords(context);
    expect(context.blockers).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("VAY-1055 gate") }),
    );
  });
});

function rows(): IdentitySourceRow[] {
  return [
    row("bookings", {
      id: BOOKING,
      hotel_id: HOTEL,
      check_in: "2026-09-01",
      check_out: "2026-09-03",
      adults: 2,
      children: 0,
      number_of_rooms: 1,
      currency: "EUR",
      status: "confirmed",
      updated_at: "2026-09-01T00:00:00Z",
    }),
    row("message_threads", {
      id: THREAD,
      hotel_id: HOTEL,
      source: "channex",
      source_thread_id: "thread-ext",
      booking_id: BOOKING,
      source_booking_id: "booking-ext",
      channel: "booking.com",
      guest_name: "Guest",
      guest_email: "guest@example.test",
      status: "open",
      last_message_at: "2026-09-01T12:00:00Z",
      last_message_preview: "Hello",
      last_message_direction: "inbound",
      unread_count: 1,
      created_at: "2026-08-20T00:00:00Z",
      updated_at: "2026-09-01T12:00:00Z",
    }),
    row("messages", {
      id: MESSAGE,
      thread_id: THREAD,
      source_message_id: "message-ext",
      direction: "inbound",
      sender_name: "Guest",
      body: "Hello",
      sent_at: "2026-09-01T11:59:00Z",
      received_at: "2026-09-01T12:00:00Z",
      read_at: "2026-09-01T12:01:00Z",
      raw_payload: {},
    }),
    row("message_attachments", {
      id: ATTACHMENT,
      message_id: MESSAGE,
      platform_media_object_id: MEDIA,
      s3_key: "messages/file.pdf",
      filename: "file.pdf",
      content_type: "application/pdf",
      size_bytes: 123,
      source_attachment_id: "attachment-ext",
      created_at: "2026-09-01T12:00:00Z",
    }),
  ];
}

function target(mediaIds: string[]) {
  return {
    propertyLinks: [
      {
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "operational_input",
        status: "active",
        migrationRunId: "run",
        ownerStatus: "active",
      },
    ],
    bookings: [
      {
        id: BOOKING,
        propertyId: PROPERTY,
        checkIn: "2026-09-01",
        checkOut: "2026-09-03",
        adults: 2,
        children: 0,
        roomCount: 1,
        currency: "EUR",
        lifecycleStatus: "confirmed",
        updatedAt: "2026-09-01T00:00:00Z",
        migrationRunId: "run",
      },
    ],
    userIds: [],
    media: mediaIds.map((mediaObjectId) => ({
      mediaObjectId,
      propertyId: PROPERTY,
      sourceTable: "message_attachments",
      sourceRowId: `${ATTACHMENT}:s3_key`,
      sourceUrl: "https://legacy-media-test.s3.amazonaws.com/messages/file.pdf",
      purpose: "pms.messaging.attachment" as const,
      visibility: "private" as const,
      lifecycleStatus: "active",
      publicApproved: false,
      publicUrl: null,
      storageKey: `private/media/${mediaObjectId}/provider_original/sha256-file.pdf`,
    })),
    mediaIds,
    records: [],
    provenance: [],
  };
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
