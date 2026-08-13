import type { PmsManualBookingCreateCommand } from "@vayada/domain-pms";
import { expect, it, vi } from "vitest";

import { createPmsManualBookingTransactionalPricingPort } from "./domains/pmsManualBookingTransactionalPricing.js";

it("requires current pricing and room-publication evidence during create", async () => {
  const reads: string[] = [];
  const port = createPmsManualBookingTransactionalPricingPort({
    async getPricingSourceSnapshot({ transaction }) {
      expect(transaction).toBe(tx);
      reads.push("pricing");
      return null;
    },
    async getRoomPublicationSnapshot({ transaction, propertyId }) {
      expect(transaction).toBe(tx);
      reads.push("publication");
      return { propertyId } as never;
    },
  });
  await expect(
    port.calculate({ transaction: tx, command, acceptedAt: new Date("2026-08-12T20:00:00Z") }),
  ).rejects.toMatchObject({ status: 404 });
  expect(reads).toEqual(["pricing", "publication"]);
});

const propertyId = "81000000-0000-4000-8000-000000000001";
const tx = {
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
};
const command = {
  contractVersion: "pms-manual-booking.v1",
  propertyId,
  organizationId: "81000000-0000-4000-8000-000000000002",
  stays: [
    {
      position: 1,
      roomId: "81000000-0000-4000-8000-000000000003",
      checkIn: "2027-01-01",
      checkOut: "2027-01-02",
      adults: 1,
      children: 0,
      ratePlanId: null,
      pricing: {
        kind: "custom",
        nightlyAmount: { amountDecimal: "100.00", currency: "EUR" },
      },
    },
  ],
  addOns: [],
} as PmsManualBookingCreateCommand;
