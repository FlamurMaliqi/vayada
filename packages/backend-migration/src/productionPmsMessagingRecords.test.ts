import { describe, expect, it } from "vitest";

import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildPmsMessagingRecords } from "./productionPmsMessagingRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { sha256 } from "./productionBookingValues.js";
import type { PmsMediaQuarantine, ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const BOOKING = "30000000-0000-4000-a000-000000000001";
const THREAD = "40000000-0000-4000-a000-000000000001";
const MESSAGE = "50000000-0000-4000-a000-000000000001";
const ATTACHMENT = "60000000-0000-4000-a000-000000000001";
const MEDIA = "70000000-0000-4000-a000-000000000001";

describe("production PMS messaging", () => {
  it.each(["open", "closed", "no_reply_needed"])(
    "counts unknown system-inquiry read history as unread without changing %s attention",
    (status) => {
      const source = systemInquiryRows();
      source.find((entry) => entry.sourceTable === "message_threads")!.data["status"] = status;
      const checksum = sha256(source);
      const context = contextFor(source);
      const records = buildPmsMessagingRecords(context);
      expect(context.blockers).toEqual([]);
      expect(records.find((entry) => entry.targetTable === "messages")?.row).toMatchObject({
        direction: "inbound",
        senderType: "system",
        readAt: null,
        rawPayload: {},
      });
      expect(records.find((entry) => entry.targetTable === "message_threads")?.row).toMatchObject({
        unreadCount: 1,
        lastMessageDirection: "inbound",
        attentionState: status === "open" ? "needs_attention" : "done",
        doneReason: status === "open" ? null : `legacy_${status}`,
        guestBookingId: null,
      });
      expect(sha256(source)).toBe(checksum);
      expect(buildPmsMessagingRecords(contextFor(source))).toEqual(records);
      expect(JSON.stringify(records)).not.toContain("private-token");
    },
  );

  it("preserves explicit inquiry read timestamps and a later reply's summary", () => {
    const source = systemInquiryRows();
    const message = source.find((entry) => entry.sourceTable === "messages")!;
    message.data["read_at"] = "2026-09-01T12:01:00Z";
    source.push(
      row("messages", {
        ...message.data,
        id: MEDIA,
        source_message_id: "reply-ext",
        body: "Later reply",
        sent_at: "2026-09-01T12:02:00Z",
        read_at: null,
        raw_payload: {},
      }),
    );
    Object.assign(source.find((entry) => entry.sourceTable === "message_threads")!.data, {
      last_message_at: "2026-09-01T12:02:00Z",
      last_message_preview: "Later reply",
    });
    const context = contextFor(source);
    const records = buildPmsMessagingRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records.find((entry) => entry.targetId === MESSAGE)?.row).toMatchObject({
      readAt: "2026-09-01T12:01:00.000Z",
      direction: "inbound",
      senderType: "system",
    });
    expect(records.find((entry) => entry.targetId === THREAD)?.row).toMatchObject({
      unreadCount: 0,
      lastMessageDirection: "outbound",
      lastMessagePreview: "Later reply",
    });
  });

  it("does not double-count an already inbound inquiry or unlink its later booking", () => {
    const source = systemInquiryRows();
    source.find((entry) => entry.sourceTable === "messages")!.data["direction"] = "inbound";
    Object.assign(source.find((entry) => entry.sourceTable === "message_threads")!.data, {
      unread_count: 1,
      last_message_direction: "inbound",
      booking_id: BOOKING,
    });
    const context = contextFor(source);
    const records = buildPmsMessagingRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records.find((entry) => entry.targetId === THREAD)?.row).toMatchObject({
      unreadCount: 1,
      guestBookingId: BOOKING,
      conversationContextState: "linked",
    });
  });

  it.each(["property", "binding", "message", "thread", "identity", "channel", "booking", "body"])(
    "blocks conflicting/incomplete inquiry %s evidence without guest content",
    (conflict) => {
      const source = systemInquiryRows();
      const message = source.find((entry) => entry.sourceTable === "messages")!.data;
      const raw = message["raw_payload"] as Record<string, unknown>;
      if (conflict === "body") {
        message["body"] = "changed body";
        source.find((entry) => entry.sourceTable === "message_threads")!.data[
          "last_message_preview"
        ] = "changed body";
      }
      if (conflict === "property") raw["property_id"] = HOTEL;
      if (conflict === "binding")
        source.find((entry) => entry.sourceTable === "channex_connections")!.data[
          "channex_property_id"
        ] = HOTEL;
      if (conflict === "message") raw["id"] = "private-token";
      if (conflict === "thread") raw["message_thread_id"] = "private-token";
      if (conflict === "identity") raw["meta"] = {};
      if (conflict === "channel")
        source.find((entry) => entry.sourceTable === "message_threads")!.data["channel"] =
          "booking.com";
      if (conflict === "booking") raw["booking_id"] = "private-token";
      const context = contextFor(source);
      buildPmsMessagingRecords(context);
      expect(context.blockers).toContainEqual(
        expect.objectContaining({
          code: "INBOX_SYSTEM_INQUIRY_REQUIRES_REVIEW",
          sourceId: MESSAGE,
          message: expect.stringContaining(PROPERTY),
        }),
      );
      expect(JSON.stringify(context.blockers)).not.toContain("private-token");
    },
  );

  it.each(["guest", { toString: "private-token" }])(
    "does not classify ordinary text or malformed sender metadata as a system inquiry",
    (sender) => {
      const source = systemInquiryRows();
      const raw = source.find((entry) => entry.sourceTable === "messages")!.data[
        "raw_payload"
      ] as Record<string, unknown>;
      raw["sender"] = sender;
      const context = contextFor(source);
      const records = buildPmsMessagingRecords(context);
      expect(context.blockers).toEqual([]);
      expect(records.find((entry) => entry.targetId === MESSAGE)?.row).toMatchObject({
        direction: "outbound",
        senderType: "property_user",
      });
    },
  );

  it("does not disguise inconsistent source unread counts as inquiry normalization", () => {
    const source = systemInquiryRows();
    source.find((entry) => entry.sourceTable === "message_threads")!.data["unread_count"] = 10;
    const context = contextFor(source);
    buildPmsMessagingRecords(context);
    expect(context.blockers).toContainEqual(
      expect.objectContaining({ code: "INBOX_THREAD_SUMMARY_MISMATCH" }),
    );
  });

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
    expect(records.find((record) => record.targetTable === "message_threads")?.row).toMatchObject({
      attentionState: "needs_attention",
      conversationContextState: "linked",
      deliveryChannel: "ota",
      providerChannel: "booking.com",
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

  it.each([null, undefined, "", "   "])(
    "preserves a missing attachment source (%j) as unavailable history",
    (sourceUrl) => {
      const context = attachmentContext(sourceUrl, target([]));
      context.rowsByTable.get("message_attachments")![0]!.data["s3_key"] = sourceUrl;
      const record = buildPmsMessagingRecords(context).find(
        (entry) => entry.targetTable === "message_attachments",
      )!;
      expect(context.blockers).toEqual([]);
      expect(record.row).toMatchObject({
        id: ATTACHMENT,
        propertyId: PROPERTY,
        messageId: MESSAGE,
        platformMediaObjectId: null,
        s3Key: null,
        sourceUrl: null,
        filename: "file.pdf",
        sourceAttachmentId: "attachment-ext",
      });
    },
  );

  it.each(["http://provider.example/file?token=secret", { stale: "private-token" }])(
    "accepts an exact media quarantine without copying its raw value",
    (sourceUrl) => {
      const context = attachmentContext(sourceUrl, {
        ...target([]),
        mediaQuarantines: [quarantine(sourceUrl)],
      });
      const record = buildPmsMessagingRecords(context).find(
        (entry) => entry.targetTable === "message_attachments",
      )!;
      expect(context.blockers).toEqual([]);
      expect(record.row).toMatchObject({
        platformMediaObjectId: null,
        s3Key: null,
        sourceUrl: null,
      });
      expect(JSON.stringify(record)).not.toMatch(/secret|private-token|provider\.example/);
    },
  );

  it.each<Partial<PmsMediaQuarantine>>([
    { sourceTable: "room_types" },
    { sourceRowId: `${MEDIA}:source_url` },
    { sourceField: "s3_key" },
    { purpose: "pms.room_type.media" },
    { reasonCode: "INVALID_STRING_ARRAY" },
    { sourceValueSha256: sha256({ value: "an earlier value" }) },
  ])("blocks a non-matching quarantine (%j)", (mismatch) => {
    const sourceUrl = "http://provider.example/file?token=secret";
    const context = attachmentContext(sourceUrl, {
      ...target([]),
      mediaQuarantines: [{ ...quarantine(sourceUrl), ...mismatch }],
    });
    const records = buildPmsMessagingRecords(context);
    expect(context.blockers).not.toEqual([]);
    expect(records.some((entry) => entry.targetTable === "message_attachments")).toBe(false);
    expect(JSON.stringify(context.blockers)).not.toMatch(/secret|provider\.example/);
  });

  it.each([null, "http://provider.example/file?token=secret"])(
    "blocks unavailable history when any media binding already exists",
    (sourceUrl) => {
      const mediaTarget = target([MEDIA]);
      mediaTarget.media[0]!.propertyId = HOTEL;
      const context = attachmentContext(sourceUrl, {
        ...mediaTarget,
        mediaQuarantines: [quarantine(sourceUrl)],
      });
      buildPmsMessagingRecords(context);
      expect(context.blockers).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("conflicts with") }),
      );
    },
  );

  it.each([
    { propertyId: HOTEL },
    { publicApproved: true },
    { lifecycleStatus: "quarantined" },
    { storageKey: "public/file.pdf" },
  ])("keeps the private media gate for valid sources (%j)", (mismatch) => {
    const mediaTarget = target([MEDIA]);
    Object.assign(mediaTarget.media[0]!, mismatch);
    const context = contextFor(rows(), mediaTarget);
    buildPmsMessagingRecords(context);
    expect(context.blockers).not.toEqual([]);
  });

  it.each([null, "http://provider.example/private"])(
    "does not hide prior-run media bindings behind unavailable history",
    (sourceUrl) => {
      const context = attachmentContext(sourceUrl, {
        ...target([]),
        attachmentMediaSourceIds: [`${ATTACHMENT}:source_url`],
        mediaQuarantines: [quarantine(sourceUrl)],
      });
      buildPmsMessagingRecords(context);
      expect(context.blockers).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("conflicts with") }),
      );
    },
  );

  it("does not use a quarantine to bypass unresolved property ownership", () => {
    const sourceUrl = "http://provider.example/private";
    const context = attachmentContext(sourceUrl, {
      ...target([]),
      propertyLinks: [],
      mediaQuarantines: [quarantine(sourceUrl)],
    });
    const records = buildPmsMessagingRecords(context);
    expect(context.blockers).not.toEqual([]);
    expect(records.some((entry) => entry.targetTable === "message_attachments")).toBe(false);
  });

  it("prefers migrated S3 media without parsing an unused malformed source URL", () => {
    const sourceRows = rows();
    sourceRows.find((entry) => entry.sourceTable === "message_attachments")!.data["source_url"] = {
      stale: "private-token",
    };
    const context = contextFor(sourceRows);
    const records = buildPmsMessagingRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records.find((entry) => entry.targetTable === "message_attachments")?.row).toMatchObject(
      {
        platformMediaObjectId: MEDIA,
        sourceUrl: null,
      },
    );
  });

  it("uses migrated URL media when the S3 key is only whitespace", () => {
    const mediaTarget = target([MEDIA]);
    mediaTarget.media[0]!.sourceRowId = `${ATTACHMENT}:source_url`;
    const context = attachmentContext(mediaTarget.media[0]!.sourceUrl, mediaTarget);
    context.rowsByTable.get("message_attachments")![0]!.data["s3_key"] = " \t ";
    const records = buildPmsMessagingRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records.find((entry) => entry.targetTable === "message_attachments")?.row).toMatchObject(
      {
        platformMediaObjectId: MEDIA,
        sourceUrl: null,
      },
    );
  });

  it("keeps typed message history without copying arbitrary provider payloads", () => {
    const sourceRows = rows();
    sourceRows.find((entry) => entry.sourceTable === "messages")!.data["raw_payload"] = {
      body: "duplicated private content",
      authorization: "Bearer secret",
      nested: { attachments: [{ url: "https://provider.example/file?token=secret" }] },
    };
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: sourceRows,
      target: target([MEDIA]),
    });
    const record = buildPmsMessagingRecords(context).find(
      (entry) => entry.targetTable === "messages",
    )!;
    expect(context.blockers).toEqual([]);
    expect(record.row).toMatchObject({
      sourceMessageId: "message-ext",
      body: "Hello",
      rawPayload: {},
    });
    expect(JSON.stringify(record)).not.toMatch(/duplicated private|secret|provider\.example/);
  });

  it("retains legacy direct email as a non-provider manual thread", () => {
    const sourceRows = rows();
    sourceRows.find((row) => row.sourceTable === "message_threads")!.data["source"] = "direct";
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: sourceRows,
      target: target([MEDIA]),
    });

    const records = buildPmsMessagingRecords(context);

    expect(context.blockers).toEqual([]);
    expect(records.find((record) => record.targetTable === "message_threads")?.row).toMatchObject({
      source: "manual",
      sourceThreadId: "thread-ext",
      providerChannel: null,
      deliveryChannel: "email",
    });
  });

  it.each([
    ["unread_count", 1],
    ["last_message_at", "2026-09-01T12:00:00Z"],
    ["last_message_preview", "private stale preview"],
    ["last_message_direction", "outbound"],
  ])("blocks inconsistent %s without reporting guest content", (field, value) => {
    const sourceRows = rows();
    sourceRows.find((entry) => entry.sourceTable === "message_threads")!.data[field as string] =
      value;
    const context = contextFor(sourceRows);
    buildPmsMessagingRecords(context);
    expect(context.blockers).toContainEqual(
      expect.objectContaining({
        code: "INBOX_THREAD_SUMMARY_MISMATCH",
        source: "pms.message_threads",
        sourceId: THREAD,
        message: expect.stringContaining(PROPERTY),
      }),
    );
    expect(JSON.stringify(context.blockers)).not.toMatch(
      /private stale|Hello|guest@example|thread-ext/,
    );
  });

  it.each(["message_threads", "messages"])(
    "blocks duplicate provider identities in %s",
    (table) => {
      const sourceRows = rows();
      const original = sourceRows.find((entry) => entry.sourceTable === table)!;
      const duplicateId = "80000000-0000-4000-a000-000000000001";
      sourceRows.push(row(table, { ...original.data, id: duplicateId }));
      const context = contextFor(sourceRows);
      buildPmsMessagingRecords(context);
      expect(
        context.blockers
          .filter((blocker) => blocker.code === "INBOX_DUPLICATE_PROVIDER_ID")
          .map((blocker) => blocker.sourceId)
          .sort(),
      ).toEqual([String(original.data["id"]), duplicateId].sort());
      expect(JSON.stringify(context.blockers)).not.toMatch(/thread-ext|message-ext|Hello/);
    },
  );

  it("keeps identical provider IDs isolated by their property and thread scope", () => {
    const sourceRows = rows();
    const otherHotel = "10000000-0000-4000-a000-000000000002";
    const otherProperty = "20000000-0000-4000-a000-000000000002";
    const otherThread = "40000000-0000-4000-a000-000000000002";
    sourceRows.push(
      row("message_threads", {
        ...sourceRows.find((entry) => entry.sourceTable === "message_threads")!.data,
        id: otherThread,
        hotel_id: otherHotel,
        booking_id: null,
      }),
    );
    sourceRows.push(
      row("messages", {
        ...sourceRows.find((entry) => entry.sourceTable === "messages")!.data,
        id: "50000000-0000-4000-a000-000000000002",
        thread_id: otherThread,
      }),
    );
    const prerequisites = target([MEDIA]);
    prerequisites.propertyLinks.push({
      ...prerequisites.propertyLinks[0]!,
      sourceId: otherHotel,
      propertyId: otherProperty,
    });
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: sourceRows,
      target: prerequisites,
    });
    const records = buildPmsMessagingRecords(context);
    expect(context.blockers).toEqual([]);
    expect(
      records
        .filter((entry) => entry.targetTable === "message_threads")
        .map((entry) => entry.row["propertyId"]),
    ).toEqual([PROPERTY, otherProperty]);
  });

  it("uses sent time and UUID ties, preserves Unicode previews, and ignores arrival order", () => {
    const sourceRows = rows();
    const original = sourceRows.find((entry) => entry.sourceTable === "messages")!;
    const body = " 🏨".repeat(150);
    sourceRows.push(
      row("messages", {
        ...original.data,
        id: "50000000-0000-4000-a000-000000000002",
        source_message_id: "outbound-ext",
        direction: "outbound",
        body,
        read_at: null,
      }),
    );
    sourceRows.push(
      row("messages", {
        ...original.data,
        id: "50000000-0000-4000-a000-000000000003",
        source_message_id: "older-ext",
        body: "older message",
        sent_at: "2026-09-01T10:00:00Z",
        received_at: "2026-09-01T13:00:00Z",
        read_at: null,
      }),
    );
    Object.assign(sourceRows.find((entry) => entry.sourceTable === "message_threads")!.data, {
      last_message_direction: "outbound",
      last_message_preview: [...body].slice(0, 280).join(""),
      unread_count: 1,
    });
    const first = contextFor(sourceRows);
    buildPmsMessagingRecords(first);
    expect(first.blockers).toEqual([]);
    const reordered = contextFor([...sourceRows].reverse());
    buildPmsMessagingRecords(reordered);
    expect(reordered.blockers).toEqual([]);
  });

  it("accepts empty threads only with empty summary metadata and zero unread", () => {
    const sourceRows = rows().filter(
      (entry) => !["messages", "message_attachments"].includes(entry.sourceTable),
    );
    const thread = sourceRows.find((entry) => entry.sourceTable === "message_threads")!;
    Object.assign(thread.data, {
      last_message_at: null,
      last_message_preview: null,
      last_message_direction: null,
      unread_count: 0,
    });
    const valid = contextFor(sourceRows);
    buildPmsMessagingRecords(valid);
    expect(valid.blockers).toEqual([]);
    thread.data["unread_count"] = 1;
    const invalid = contextFor(sourceRows);
    buildPmsMessagingRecords(invalid);
    expect(invalid.blockers).toContainEqual(
      expect.objectContaining({ code: "INBOX_THREAD_SUMMARY_MISMATCH" }),
    );
  });
});

function contextFor(
  sourceRows: IdentitySourceRow[],
  targetState: ProductionPmsTargetState = target([MEDIA]),
) {
  return createProductionPmsContext({
    sourceRunId: "run",
    completedAt: "2026-08-30T00:00:00Z",
    rows: sourceRows,
    target: targetState,
  });
}

function attachmentContext(sourceUrl: unknown, targetState: ProductionPmsTargetState) {
  const sourceRows = rows();
  Object.assign(sourceRows.find((entry) => entry.sourceTable === "message_attachments")!.data, {
    s3_key: null,
    source_url: sourceUrl,
  });
  return contextFor(sourceRows, targetState);
}

function quarantine(value: unknown): PmsMediaQuarantine {
  return {
    sourceTable: "message_attachments",
    sourceRowId: `${ATTACHMENT}:source_url`,
    sourceField: "source_url",
    purpose: "pms.messaging.attachment",
    reasonCode: "INVALID_HTTPS_URL",
    sourceValueSha256: sha256({ value }),
  };
}

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
      last_message_at: "2026-09-01T11:59:00Z",
      last_message_preview: "Hello",
      last_message_direction: "inbound",
      unread_count: 0,
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

function systemInquiryRows() {
  const source = rows();
  Object.assign(source.find((entry) => entry.sourceTable === "message_threads")!.data, {
    channel: "airbnb",
    booking_id: null,
    source_booking_id: null,
    last_message_preview: "inquiry",
    last_message_direction: "outbound",
  });
  Object.assign(source.find((entry) => entry.sourceTable === "messages")!.data, {
    body: "inquiry",
    direction: "outbound",
    read_at: null,
    raw_payload: {
      sender: "system",
      message: "inquiry",
      token: "private-token",
      meta: {
        live_feed_event_id: "inquiry-ext",
        booking_details: { property_id: MEDIA },
      },
    },
  });
  source.push(
    row("channex_connections", { id: MEDIA, hotel_id: HOTEL, channex_property_id: MEDIA }),
  );
  return source;
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
