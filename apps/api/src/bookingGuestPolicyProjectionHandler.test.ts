import {
  createBookingGuestPolicyPublicProjection,
  type BookingGuestPolicyProjectionReceipt,
} from "@vayada/domain-booking";
import { describe, expect, it, vi } from "vitest";

import {
  now,
  organizationId,
  outboxEventId,
  projectionMessage,
  propertyId,
  receiptId,
  revisionFixture,
  revisionId,
} from "./bookingGuestPolicyTestFixtures.js";
import { createBookingGuestPolicyProjectionHandler } from "./domains/bookingGuestPolicyProjectionHandler.js";

describe("Booking guest-policy projection handler", () => {
  it("projects only the approved public allowlist and replays the exact applied receipt", async () => {
    const projection = createBookingGuestPolicyPublicProjection(revisionFixture());
    const catalog = vi.fn(async (_input: unknown) => ({
      outcome: "applied" as const,
      catalogPolicyProjectionRevision: 9,
    }));
    let storedReceipt: BookingGuestPolicyProjectionReceipt | null = null;
    const receipts = vi.fn(async (input) => {
      storedReceipt ??= {
        outcome: "applied",
        receiptId,
        sourceOutboxEventId: input.sourceOutboxEventId,
        projectedGuestPolicyRevision: input.guestPolicyRevision,
        projectedBundleHash: input.bundleHash,
        projectedSourceFingerprint: input.sourceFingerprint,
        catalogProfileSourceRevision: input.catalogProfileSourceRevision,
        catalogPolicyProjectionRevision: 9,
        recordedAt: input.recordedAt,
      };
      return storedReceipt;
    });
    const handler = createBookingGuestPolicyProjectionHandler({
      read: {
        async getGuestPolicyPublicProjection() {
          return projection;
        },
      },
      catalog: { projectApprovedGuestPolicy: catalog },
      receipts: { recordProjectionReceipt: receipts },
    });

    await expect(handler.handleGuestPolicyProjection(projectionMessage())).resolves.toMatchObject({
      outcome: "applied",
      receipt: { catalogPolicyProjectionRevision: 9 },
    });
    expect(catalog).toHaveBeenCalledWith({ outboxEventId, projection });
    expect(JSON.stringify(catalog.mock.calls[0]?.[0])).not.toContain("phoneRequired");
    expect(receipts).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        propertyId,
        revisionId,
        sourceOutboxEventId: outboxEventId,
        result: { outcome: "applied", catalogPolicyProjectionRevision: 9 },
      }),
    );
    await expect(
      handler.handleGuestPolicyProjection({
        ...projectionMessage(),
        processedAt: "2026-08-05T08:01:00.000Z",
      }),
    ).resolves.toMatchObject({ outcome: "applied", receipt: { recordedAt: now } });
  });

  it("rejects malformed envelopes and retries unavailable Catalog projection without a receipt", async () => {
    const projection = createBookingGuestPolicyPublicProjection(revisionFixture());
    const receipts = vi.fn();
    const handler = createBookingGuestPolicyProjectionHandler({
      read: {
        async getGuestPolicyPublicProjection() {
          return projection;
        },
      },
      catalog: {
        async projectApprovedGuestPolicy() {
          return { outcome: "unavailable", errorSource: "provider" };
        },
      },
      receipts: { recordProjectionReceipt: receipts as never },
    });

    await expect(
      handler.handleGuestPolicyProjection({ ...projectionMessage(), extra: true } as never),
    ).resolves.toEqual({ outcome: "rejected", code: "malformed_message" });
    await expect(handler.handleGuestPolicyProjection(projectionMessage())).resolves.toEqual({
      outcome: "retry",
      errorSource: "provider",
    });
    expect(receipts).not.toHaveBeenCalled();
  });

  it("binds the source read to the exact organization and outbox identity before projecting", async () => {
    const projection = createBookingGuestPolicyPublicProjection(revisionFixture());
    const swappedOutboxEventId = "80000000-0000-4000-8000-000000000018";
    const read = vi.fn(async (input: { outboxEventId: string }) =>
      input.outboxEventId === outboxEventId ? projection : null,
    );
    const catalog = vi.fn();
    const handler = createBookingGuestPolicyProjectionHandler({
      read: { getGuestPolicyPublicProjection: read },
      catalog: { projectApprovedGuestPolicy: catalog as never },
      receipts: { recordProjectionReceipt: vi.fn() as never },
    });

    await expect(
      handler.handleGuestPolicyProjection({
        ...projectionMessage(),
        outboxEventId: swappedOutboxEventId,
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "projection_not_found" });
    expect(read).toHaveBeenCalledWith({
      organizationId,
      propertyId,
      revisionId,
      guestPolicyRevision: 1,
      outboxEventId: swappedOutboxEventId,
    });
    expect(catalog).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "unknown" },
    { outcome: "unavailable", errorSource: "timeout" },
    { outcome: "applied", catalogPolicyProjectionRevision: 9, extra: true },
    {
      outcome: "source_revision_conflict",
      observedCatalogProfileRevision: "profile:9",
      extra: true,
    },
  ])("rejects malformed Catalog projection result %#", async (catalogResult) => {
    const projection = createBookingGuestPolicyPublicProjection(revisionFixture());
    const receipts = vi.fn();
    const handler = createBookingGuestPolicyProjectionHandler({
      read: {
        async getGuestPolicyPublicProjection() {
          return projection;
        },
      },
      catalog: {
        async projectApprovedGuestPolicy() {
          return catalogResult as never;
        },
      },
      receipts: { recordProjectionReceipt: receipts as never },
    });

    await expect(handler.handleGuestPolicyProjection(projectionMessage())).resolves.toEqual({
      outcome: "rejected",
      code: "catalog_projection_malformed",
    });
    expect(receipts).not.toHaveBeenCalled();
  });

  it("records a Catalog source conflict without overwriting the newer profile", async () => {
    const projection = createBookingGuestPolicyPublicProjection(revisionFixture());
    const receipts = vi.fn(async (input) => ({
      outcome: "source_revision_conflict" as const,
      receiptId,
      sourceOutboxEventId: input.sourceOutboxEventId,
      projectedGuestPolicyRevision: input.guestPolicyRevision,
      projectedBundleHash: input.bundleHash,
      projectedSourceFingerprint: input.sourceFingerprint,
      catalogProfileSourceRevision: input.catalogProfileSourceRevision,
      observedCatalogProfileRevision: "profile:9",
      recordedAt: input.recordedAt,
    }));
    const handler = createBookingGuestPolicyProjectionHandler({
      read: {
        async getGuestPolicyPublicProjection() {
          return projection;
        },
      },
      catalog: {
        async projectApprovedGuestPolicy() {
          return {
            outcome: "source_revision_conflict",
            observedCatalogProfileRevision: "profile:9",
          };
        },
      },
      receipts: { recordProjectionReceipt: receipts },
    });

    await expect(handler.handleGuestPolicyProjection(projectionMessage())).resolves.toMatchObject({
      outcome: "source_revision_conflict",
      receipt: { observedCatalogProfileRevision: "profile:9" },
    });
    expect(receipts).toHaveBeenCalledOnce();
  });
});
