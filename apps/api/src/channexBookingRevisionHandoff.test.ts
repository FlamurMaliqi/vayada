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
        providerPropertyId: "external-property-1",
        revision: {
          id: "revision-2",
          type: "booking_revision",
          attributes: { property_id: "external-property-1", booking_id: "booking-1", revision: 2 },
        },
      }),
    ).resolves.toMatchObject({ status: "promoted", jobIds: ["job-1"] });
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "mutating",
        receiptKey: "webhook:channex:booking:property-1:booking-1:revision-2",
        normalizedPreview: expect.objectContaining({
          jobType: "channex.ingest-booking",
          queueName: "pms.channex.webhooks",
          payload: expect.objectContaining({
            pullRequired: false,
            providerPropertyId: "external-property-1",
            revisionSource: "revision_feed",
          }),
        }),
      }),
    );
    expect(promoteReceipt).toHaveBeenCalledOnce();
  });

  it("does not promote a previously terminal duplicate", async () => {
    const recordReceipt = vi.fn().mockResolvedValue({
      status: "duplicate",
      receiptId: "receipt-1",
      lifecycleStatus: "succeeded",
    });
    const promoteReceipt = vi.fn<ProviderWebhookStore["promoteReceipt"]>();
    await expect(
      promotePulledChannexBookingRevision({
        store: {
          recordReceipt,
          promoteReceipt,
        },
        propertyId: "property-1",
        providerPropertyId: "external-property-1",
        revision: { booking_id: "booking-1", revision: 2 },
      }),
    ).resolves.toBeNull();
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ receiptKey: "webhook:channex:booking:property-1:booking-1:2" }),
    );
    expect(promoteReceipt).not.toHaveBeenCalled();
  });

  it("rejects a feed revision from another provider property", async () => {
    const recordReceipt = vi.fn<ProviderWebhookStore["recordReceipt"]>();
    const promoteReceipt = vi.fn<ProviderWebhookStore["promoteReceipt"]>();
    await expect(
      promotePulledChannexBookingRevision({
        store: { recordReceipt, promoteReceipt },
        propertyId: "property-1",
        providerPropertyId: "external-property-1",
        revision: {
          attributes: { property_id: "external-property-2", booking_id: "booking-1" },
        },
      }),
    ).rejects.toThrow("Pulled Channex revision belongs to another provider property");
    expect(recordReceipt).not.toHaveBeenCalled();
    expect(promoteReceipt).not.toHaveBeenCalled();
  });
});
