import { describe, expect, it, vi } from "vitest";

import { createPgPmsInboxDeliveryReceiptPort } from "./pmsInboxDeliveryReceipts.js";

describe("PMS Inbox delivery receipts", () => {
  it("deduplicates trusted receipts and projects only inserted acknowledgements", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ matched: true, recorded: true }],
    }));
    const port = createPgPmsInboxDeliveryReceiptPort({
      connectionString: "",
      pool: { query } as never,
    });
    const acknowledgedAt = new Date("2026-09-04T01:00:00.000Z");
    await expect(
      port.recordTrustedProviderReceipt({
        adapter: "resend",
        providerReference: "email-1",
        receiptType: "delivered",
        providerReceiptId: "receipt-1",
        acknowledgedAt,
      }),
    ).resolves.toEqual({ matched: true, recorded: true });
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("attempt.outcome = 'accepted'");
    expect(sql).toContain("attempt.provider_reference = $2");
    expect(sql).toContain("ON CONFLICT (property_id, provider_receipt_id)");
    expect(sql).toContain("latest_provider_receipt_at = GREATEST");
    expect(sql).toContain("EXISTS (SELECT 1 FROM accepted) AS matched");
    expect(values).toEqual([
      "resend",
      "email-1",
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
      port.recordTrustedProviderReceipt({
        adapter: "resend",
        providerReference: "",
        receiptType: "read",
        providerReceiptId: "",
        acknowledgedAt: new Date("invalid"),
      }),
    ).rejects.toThrow("receipt is invalid");
    expect(query).not.toHaveBeenCalled();
  });
});
