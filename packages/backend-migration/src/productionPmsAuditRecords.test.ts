import { describe, expect, it } from "vitest";

import { buildPmsAuditRecords } from "./productionPmsAuditRecords.js";
import { createProductionPmsContext } from "./productionPmsContext.js";
import { sha256 } from "./productionBookingValues.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const BOOKING = "30000000-0000-4000-a000-000000000001";
const CONNECTION = "40000000-0000-4000-a000-000000000001";
const EXTERNAL_PROPERTY = "50000000-0000-4000-a000-000000000001";
const WEBHOOK = "60000000-0000-4000-a000-000000000001";
const ACTOR = "70000000-0000-4000-a000-000000000001";

describe("production PMS audit records", () => {
  it("preserves audit receipts without creating replayable provider work", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(true),
      target: target(),
    });
    const records = buildPmsAuditRecords(context);

    expect(context.blockers).toEqual([]);
    expect(records.filter((record) => record.targetTable === "product_audit_events")).toHaveLength(
      3,
    );
    expect(
      records.find((record) => record.row["action"] === "pms.legacy_notification.delivered")?.row,
    ).toMatchObject({
      targetResourceId: BOOKING,
      privatePayload: { recipientEmail: "guest@example.test" },
      auditMetadata: { historicalReceipt: true, replayProhibited: true },
    });
    expect(
      records.find((record) => record.targetTable === "external_webhook_events")?.row,
    ).toMatchObject({
      id: WEBHOOK,
      deliveryStatus: "observed",
      normalizedDomainEventId: null,
      propertyId: PROPERTY,
      signatureVerified: false,
    });
  });

  it("retains a legacy webhook failure as failed evidence", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(false),
      target: target(),
    });
    const records = buildPmsAuditRecords(context);
    expect(
      records.find((record) => record.targetTable === "external_webhook_events")?.row,
    ).toMatchObject({ deliveryStatus: "failed", failureReason: "legacy_processor_failed" });
  });

  it.each(["scoped", "absent", "unknown", "ambiguous", "unmapped-hotel"])(
    "imports %s message receipts as bounded non-content evidence",
    (ownership) => {
      const sourceRows = rows(false);
      const receipt = sourceRows.find((entry) => entry.sourceTable === "channex_webhook_events")!;
      receipt.data["event_type"] = "message";
      receipt.data["payload"] = {
        body: "private guest message",
        email: "guest@example.test",
        attachments: [{ url: "https://provider.example/file?token=secret" }],
        authorization: "Bearer secret",
      };
      receipt.data["error"] = "provider rejected Bearer secret for guest@example.test";
      if (ownership === "absent") receipt.data["property_id"] = null;
      if (ownership === "unknown") receipt.data["property_id"] = "unmapped-property";
      const connection = sourceRows.find((entry) => entry.sourceTable === "channex_connections")!;
      if (ownership === "ambiguous")
        sourceRows.push({ ...connection, data: { ...connection.data, id: WEBHOOK } });
      if (ownership === "unmapped-hotel") connection.data["hotel_id"] = WEBHOOK;
      const original = structuredClone(sourceRows);
      const context = createProductionPmsContext({
        sourceRunId: "run",
        completedAt: "2026-08-30T00:00:00Z",
        rows: sourceRows,
        target: target(),
      });

      const records = buildPmsAuditRecords(context).filter(
        (record) => record.targetTable === "external_webhook_events",
      );

      expect(records).toHaveLength(1);
      expect(records[0]!.row).toMatchObject({
        propertyId: ownership === "scoped" ? PROPERTY : null,
        tenantScope: ownership === "scoped" ? "property" : "migration",
        eventType: "message",
        rawPayload: {},
        rawHeaders: {},
        payloadHash: sha256(receipt.data["payload"]),
        payloadRetentionUntil: "2026-09-27T03:00:00.000Z",
        normalizedDomainEventId: null,
        processedAt: null,
        signatureVerified: false,
        deliveryStatus: "failed",
        failureReason:
          ownership === "scoped"
            ? "legacy_processor_failed"
            : "legacy_message_ownership_unresolved",
      });
      expect(JSON.stringify(records)).not.toMatch(
        /private guest|guest@example|secret|provider\.example/,
      );
      expect(sourceRows).toEqual(original);
      expect(
        buildPmsAuditRecords(context).filter(
          (record) => record.targetTable === "external_webhook_events",
        ),
      ).toEqual(records);
    },
  );

  it("blocks a webhook whose external property has no canonical ownership", () => {
    const sourceRows = rows(true);
    sourceRows.find((entry) => entry.sourceTable === "channex_webhook_events")!.data[
      "property_id"
    ] = "80000000-0000-4000-a000-000000000001";
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: sourceRows,
      target: target(),
    });
    buildPmsAuditRecords(context);
    expect(context.blockers).toContainEqual(
      expect.objectContaining({
        source: "pms.channex_webhook_events",
        message: expect.stringContaining("has no target ownership"),
      }),
    );
  });

  it("versions mutable channel markup audit history", () => {
    const firstRows = rows(true);
    const secondRows = rows(true);
    secondRows.find((entry) => entry.sourceTable === "channex_channel_markups")!.data[
      "updated_at"
    ] = "2026-08-29T02:00:00Z";
    const build = (sourceRows: IdentitySourceRow[]) => {
      const context = createProductionPmsContext({
        sourceRunId: "run",
        completedAt: "2026-08-30T00:00:00Z",
        rows: sourceRows,
        target: target(),
      });
      return buildPmsAuditRecords(context).find(
        (record) => record.row["action"] === "pms.legacy_channel_markup.migrated",
      )!;
    };
    expect(build(firstRows).targetId).not.toBe(build(secondRows).targetId);
  });
});

function rows(processedOk: boolean): IdentitySourceRow[] {
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
      updated_at: "2026-08-02T00:00:00Z",
    }),
    row("booking_events", {
      id: "90000000-0000-4000-a000-000000000001",
      booking_id: BOOKING,
      hotel_id: HOTEL,
      event_type: "Room Moved",
      payload: { source: "host", guestEmail: "guest@example.test" },
      actor_user_id: ACTOR,
      created_at: "2026-08-28T00:00:00Z",
    }),
    row("booking_notification_deliveries", {
      booking_id: BOOKING,
      notification_type: "guest_confirmation",
      recipient_email: "Guest@Example.Test",
      delivered_at: "2026-08-28T01:00:00Z",
    }),
    row("channex_connections", {
      id: CONNECTION,
      hotel_id: HOTEL,
      channex_property_id: EXTERNAL_PROPERTY,
    }),
    row("channex_channel_markups", {
      id: "a0000000-0000-4000-a000-000000000001",
      hotel_id: HOTEL,
      channel: "booking.com",
      markup_pct: "10.0",
      updated_at: "2026-08-28T02:00:00Z",
    }),
    row("channex_webhook_events", {
      id: WEBHOOK,
      event_type: "booking_revision",
      property_id: EXTERNAL_PROPERTY,
      received_at: "2026-08-28T03:00:00Z",
      processed_ok: processedOk,
      error: processedOk ? null : "legacy failure",
      payload: { booking_id: "external-booking" },
    }),
  ];
}

function target() {
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
        updatedAt: "2026-08-02T00:00:00Z",
        migrationRunId: "run",
      },
    ],
    userIds: [ACTOR],
    mediaIds: [],
    records: [],
    provenance: [],
  };
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
