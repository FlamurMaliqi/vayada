import { createProductReadinessResult } from "@vayada/domain-hotels";
import type {
  ReadyBookingPublicationEvidence,
  RequestBookingPublicationCommand,
} from "@vayada/domain-booking";
import { describe, expect, it } from "vitest";

import {
  bookingPublicationRequestFingerprint,
  hasValidBookingReadinessEvidence,
  parseBookingPublicationIdempotencyMetadata,
  parseStoredBookingPublicationResult,
} from "./bookingPublicationCommandEnvelope.js";

describe("Booking publication command envelope", () => {
  it("fingerprints expected active revision and complete readiness identity", async () => {
    const base = await command();
    expect(bookingPublicationRequestFingerprint(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      bookingPublicationRequestFingerprint({
        ...base,
        audit: { requestId: "retry", correlationId: "another", source: "retry" },
      }),
    ).toBe(bookingPublicationRequestFingerprint(base));
    expect(
      bookingPublicationRequestFingerprint({
        ...base,
        expectedActiveContentRevisionId: "33333333-3333-4333-8333-333333333333",
      }),
    ).not.toBe(bookingPublicationRequestFingerprint(base));
  });

  it("rejects tampered readiness hashes", async () => {
    const base = await command();
    await expect(hasValidBookingReadinessEvidence(base)).resolves.toBe(true);
    await expect(
      hasValidBookingReadinessEvidence({
        ...base,
        readiness: {
          ...base.readiness,
          readinessHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      }),
    ).resolves.toBe(false);
  });

  it("keeps canonically equivalent source order out of retry identity", async () => {
    const ordered = await command(false);
    const reordered = await command(true);
    expect(ordered.readiness.sourceManifestHash).toBe(reordered.readiness.sourceManifestHash);
    expect(ordered.readiness.readinessHash).toBe(reordered.readiness.readinessHash);
    expect(bookingPublicationRequestFingerprint(ordered)).toBe(
      bookingPublicationRequestFingerprint(reordered),
    );
  });

  it("fails closed on malformed stored replay metadata", () => {
    expect(
      parseStoredBookingPublicationResult({ ok: true, operation: { status: "pending" } }),
    ).toBe(null);
    expect(
      parseStoredBookingPublicationResult({
        ok: false,
        error: { code: "idempotency_key_conflict", unexpected: "ignored" },
      }),
    ).toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    expect(
      parseStoredBookingPublicationResult({
        ok: true,
        operation: {
          operationId: "55555555-5555-4555-8555-555555555555",
          propertyId: "22222222-2222-4222-8222-222222222222",
          status: "succeeded",
          expectedActiveContentRevisionId: null,
          resultContentRevisionId: null,
          failureCode: null,
          requestedAt: "2026-08-02T12:00:00.000Z",
          updatedAt: "2026-08-02T12:00:00.000Z",
          completedAt: null,
        },
      }),
    ).toBe(null);
  });

  it("binds accepted replay metadata to the stored operation and property", () => {
    const operation = {
      operationId: "55555555-5555-4555-8555-555555555555",
      propertyId: "22222222-2222-4222-8222-222222222222",
      status: "pending",
      expectedActiveContentRevisionId: null,
      resultContentRevisionId: null,
      failureCode: null,
      requestedAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
      completedAt: null,
    } as const;
    const metadata = { result: { ok: true, operation } };
    expect(
      parseBookingPublicationIdempotencyMetadata(metadata, {
        propertyId: operation.propertyId,
        operationId: operation.operationId,
      }),
    ).toEqual({ ok: true, operation });
    expect(
      parseBookingPublicationIdempotencyMetadata(metadata, {
        propertyId: "66666666-6666-4666-8666-666666666666",
        operationId: operation.operationId,
      }),
    ).toBe(null);
    expect(
      parseBookingPublicationIdempotencyMetadata(metadata, {
        propertyId: operation.propertyId,
        operationId: null,
      }),
    ).toBe(null);
  });
});

async function command(reverseSources = false): Promise<RequestBookingPublicationCommand> {
  const propertyId = "22222222-2222-4222-8222-222222222222";
  const sources = [
    {
      ownerDomain: "booking" as const,
      entityType: "booking_settings",
      entityId: propertyId,
      revision: "booking-settings:4",
    },
    {
      ownerDomain: "hotel_catalog" as const,
      entityType: "property_profile",
      entityId: propertyId,
      revision: "property-profile:7",
    },
  ];
  if (reverseSources) sources.reverse();
  const readiness = await createProductReadinessResult({
    contractVersion: "onboarding-product-readiness.v1",
    propertyId,
    product: "booking",
    status: "ready",
    sourceManifest: {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources,
    },
    groups: [
      {
        groupId: "booking.guest_experience",
        status: "ready",
        steps: [
          {
            owningStepId: "guest_experience",
            status: "ready",
            entities: [
              {
                source: {
                  ownerDomain: "booking",
                  entityType: "booking_settings",
                  entityId: propertyId,
                  revision: "booking-settings:4",
                },
                status: "ready",
                blockers: [],
              },
              {
                source: {
                  ownerDomain: "hotel_catalog",
                  entityType: "property_profile",
                  entityId: propertyId,
                  revision: "property-profile:7",
                },
                status: "ready",
                blockers: [],
              },
            ],
          },
        ],
      },
    ],
    evaluatedAt: "2026-08-02T12:00:00.000Z",
  });
  return {
    organizationId: "11111111-1111-4111-8111-111111111111",
    propertyId,
    actorUserId: "44444444-4444-4444-8444-444444444444",
    idempotencyKey: "booking-publication",
    expectedActiveContentRevisionId: null,
    readiness: readiness as ReadyBookingPublicationEvidence,
    audit: { requestId: "request", correlationId: "correlation", source: "marketplace-web" },
  };
}
