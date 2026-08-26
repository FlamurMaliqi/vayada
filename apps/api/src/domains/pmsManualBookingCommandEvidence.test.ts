import { createHash } from "node:crypto";

import type { PmsManualBookingCreateCommand } from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import type { PmsManualBookingTransaction } from "./pmsManualBookingTransactionPorts.js";
import {
  findManualBookingReplay,
  manualBookingRequestFingerprint,
} from "./pmsManualBookingCommandEvidence.js";

const propertyId = "83000000-0000-4000-8000-000000000001";
const bookingId = "83000000-0000-4000-8000-000000000002";

describe("manual booking command replay", () => {
  it("normalizes a valid pre-feedback v1 result to zero rearranged bookings", async () => {
    const command = manualCommand();
    const legacyResult = {
      contractVersion: "pms-manual-booking.v1",
      outcome: "created",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      guestBookingId: bookingId,
      bookingReference: "PMS-LEGACY",
      bookingChannel: "direct",
      directSource: "email",
      stayCount: 1,
      checkIn: "2027-01-01",
      checkOut: "2027-01-03",
      total: { amountDecimal: "200.00", currency: "EUR" },
      balance: { amountDecimal: "200.00", currency: "EUR" },
      paymentStatus: "unpaid",
      paymentEvidenceId: null,
      sideEffects: ["calendar_refresh", "ari_changed", "guest_confirmation", "audit_event"],
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "83000000-0000-4000-8000-000000000003",
            status: "completed",
            requestFingerprint: manualBookingRequestFingerprint(command),
            responseBodyHash: sha256(stableJson(legacyResult)),
            responseResourceId: bookingId,
            metadata: { result: legacyResult },
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 });

    await expect(
      findManualBookingReplay({ query } as unknown as PmsManualBookingTransaction, command),
    ).resolves.toMatchObject({ outcome: "replayed", rearrangedBookingCount: 0 });
  });
});

function manualCommand(): PmsManualBookingCreateCommand {
  return {
    contractVersion: "pms-manual-booking.v1",
    commandId: "manual-command-1",
    idempotencyKey: "manual-key-1",
    propertyId,
    organizationId: "83000000-0000-4000-8000-000000000004",
    guest: {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      phoneE164: null,
      countryCode: null,
      specialRequests: null,
    },
    privateNote: null,
    directSource: "email",
    stays: [
      {
        position: 1,
        roomId: "83000000-0000-4000-8000-000000000005",
        checkIn: "2027-01-01",
        checkOut: "2027-01-03",
        adults: 2,
        children: 0,
        ratePlanId: null,
        pricing: {
          kind: "custom",
          nightlyAmount: { amountDecimal: "100.00", currency: "EUR" },
        },
      },
    ],
    addOns: [],
    payment: { expectedMethod: "cash", settlement: { status: "unpaid" } },
    audit: {
      actor: {
        kind: "user",
        userId: "83000000-0000-4000-8000-000000000006",
        organizationId: "83000000-0000-4000-8000-000000000004",
      },
      requestId: "request-1",
      correlationId: null,
      requestedAt: "2026-08-18T10:00:00.000Z",
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
