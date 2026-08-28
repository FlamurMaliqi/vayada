import { hashSourceManifest, type SourceEntityRevision } from "@vayada/domain-hotels";
import {
  createFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import { bookingPublicationOwnerSnapshotProvenanceMatches } from "@vayada/domain-distribution/booking-publication-owner-snapshots";
import { describe, expect, it } from "vitest";

import { createFinanceBookingPublicationSnapshotPort } from "./domains/financeBookingPublicationSnapshot.js";

const organizationId = "123e4567-e89b-42d3-a456-426614174000";
const propertyId = "223e4567-e89b-42d3-a456-426614174000";
const source: SourceEntityRevision = {
  ownerDomain: "finance",
  entityType: "finance_payment_methods.v1",
  entityId: propertyId,
  revision: "4",
};

describe("Finance Booking publication snapshot", () => {
  it("binds ready public methods and currency to the exact accepted Finance revision", async () => {
    const request = await snapshotRequest([source]);
    const result = await port(readySnapshot()).getSnapshot(request);

    expect(result).toMatchObject({
      outcome: "snapshot",
      owner: "finance",
      organizationId,
      propertyId,
      sourceManifestHash: request.sourceManifestHash,
      resolvedSources: [source],
      content: {
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
        onlinePayment: false,
        payAtProperty: true,
        readyPaymentMethods: ["pay_at_property"],
        freshness: { status: "fresh", lastUpdatedAt: "2026-08-03T12:00:00.000Z" },
      },
    });
    expect(bookingPublicationOwnerSnapshotProvenanceMatches(result, "finance", request)).toBe(true);
  });

  it("fails closed for stale, missing, or provider-failed Finance evidence", async () => {
    const stale = await snapshotRequest([{ ...source, revision: "3" }]);
    await expect(port(readySnapshot()).getSnapshot(stale)).resolves.toEqual({
      outcome: "unavailable",
      owner: "finance",
    });
    await expect(port(null).getSnapshot(await snapshotRequest([source]))).resolves.toEqual({
      outcome: "unavailable",
      owner: "finance",
    });
    await expect(
      createFinanceBookingPublicationSnapshotPort({
        financeReadPort: {
          async getPaymentReadiness() {
            throw new Error("database unavailable");
          },
        },
      }).getSnapshot(await snapshotRequest([source])),
    ).resolves.toEqual({ outcome: "unavailable", owner: "finance" });
  });
});

function port(value: ReturnType<typeof readySnapshot> | null) {
  const financeReadPort: FinancePaymentReadinessReadPort = {
    async getPaymentReadiness() {
      return value;
    },
  };
  return createFinanceBookingPublicationSnapshotPort({ financeReadPort });
}

function readySnapshot() {
  const pricing = {
    contractVersion: "pms-pricing.v1",
    currency: "EUR",
    pricingCurrencyRevision: 7,
  };
  return createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision: 4,
    selectedMethods: ["pay_at_property", "card"],
    committedPricing: pricing,
    currentPricing: pricing,
    onlineCardReadiness: "execution_unavailable",
    updatedAt: "2026-08-03T12:00:00.000Z",
  });
}

async function snapshotRequest(sources: readonly SourceEntityRevision[]) {
  const sourceManifest = {
    contractVersion: "onboarding-source-manifest.v1" as const,
    propertyId,
    sources,
  };
  return {
    organizationId,
    propertyId,
    sourceManifest,
    sourceManifestHash: await hashSourceManifest(sourceManifest),
  };
}
