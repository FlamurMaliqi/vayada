import { describe, expect, it, vi } from "vitest";

import { createPgPmsInboxDeliveryReceiptPort } from "./pmsInboxDeliveryReceipts.js";

describe("PMS Inbox delivery receipts", () => {
  it("deduplicates trusted receipts and projects only inserted acknowledgements", async () => {
    const query = vi.fn(async () => ({ rows: [{ recorded: true }] }));
    const port = createPgPmsInboxDeliveryReceiptPort({
      connectionString: "",
      pool: { query } as never,
    });
    const acknowledgedAt = new Date("2026-09-04T01:00:00.000Z");
    await expect(
      port.recordTrustedReceipt({
        propertyId: "property-1",
        messageId: "message-1",
        attemptNumber: 1,
        receiptType: "delivered",
        providerReceiptId: "receipt-1",
        acknowledgedAt,
      }),
    ).resolves.toEqual({ recorded: true });
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("attempt.outcome = 'accepted'");
    expect(sql).toContain("ON CONFLICT (property_id, provider_receipt_id)");
    expect(sql).toContain("latest_provider_receipt_at = GREATEST");
    expect(values).toEqual([
      "property-1",
      "message-1",
      1,
      "delivered",
      "receipt-1",
      acknowledgedAt.toISOString(),
    ]);
  });

  it("rejects an untrusted receipt without querying", async () => {
    const query = vi.fn();
    const port = createPgPmsInboxDeliveryReceiptPort({
      connectionString: "",
      pool: { query } as never,
    });
    await expect(
      port.recordTrustedReceipt({
        propertyId: "property-1",
        messageId: "message-1",
        attemptNumber: 0,
        receiptType: "read",
        providerReceiptId: "",
        acknowledgedAt: new Date("invalid"),
      }),
    ).rejects.toThrow("receipt is invalid");
    expect(query).not.toHaveBeenCalled();
  });
});
