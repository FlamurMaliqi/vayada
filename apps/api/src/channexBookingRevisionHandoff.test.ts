import { describe, expect, it, vi } from "vitest";

import type { ProviderWebhookStore } from "./routes/providerWebhooks.js";
import { promotePulledChannexBookingRevision } from "./routes/providerWebhooks.js";

describe("pulled Channex booking revision handoff", () => {
  it("reuses provider receipt promotion with booking-scoped idempotency", async () => {
    const recordReceipt = vi.fn<ProviderWebhookStore["recordReceipt"]>().mockResolvedValue({
      status: "inserted",
      receiptId: "receipt-1",
      lifecycleStatus: "observed",
    });
    const promoteReceipt = vi.fn<ProviderWebhookStore["promoteReceipt"]>().mockResolvedValue({
      status: "promoted",
      receiptId: "receipt-1",
      jobIds: ["job-1"],
    });

    await expect(
      promotePulledChannexBookingRevision({
        store: { recordReceipt, promoteReceipt },
        propertyId: "property-1",
        revision: { booking_id: "booking-1", revision: "2" },
      }),
    ).resolves.toMatchObject({ status: "promoted", jobIds: ["job-1"] });
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "mutating",
        receiptKey: "webhook:channex:booking:property-1:booking-1:2",
        normalizedPreview: expect.objectContaining({
          jobType: "channex.ingest-booking",
          queueName: "pms.channex.webhooks",
        }),
      }),
    );
    expect(promoteReceipt).toHaveBeenCalledOnce();
  });

  it("does not promote a previously terminal duplicate", async () => {
    const promoteReceipt = vi.fn<ProviderWebhookStore["promoteReceipt"]>();
    await expect(
      promotePulledChannexBookingRevision({
        store: {
          recordReceipt: vi.fn().mockResolvedValue({
            status: "duplicate",
            receiptId: "receipt-1",
            lifecycleStatus: "succeeded",
          }),
          promoteReceipt,
        },
        propertyId: "property-1",
        revision: { booking_id: "booking-1", revision: "2" },
      }),
    ).resolves.toBeNull();
    expect(promoteReceipt).not.toHaveBeenCalled();
  });
});
