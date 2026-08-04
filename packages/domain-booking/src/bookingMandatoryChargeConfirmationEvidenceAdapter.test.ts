import {
  type PmsMandatoryChargeConfirmationReadPort,
  type PmsMandatoryChargeConfirmationReadResult,
} from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import { createBookingMandatoryChargeConfirmationEvidenceAdapter } from "./bookingMandatoryChargeConfirmationEvidenceAdapter.js";

const organizationId = "123e4567-e89b-42d3-a456-426614174000";
const propertyId = "223e4567-e89b-42d3-a456-426614174000";
const fingerprint = "6169ef53c2f84dcab9a23edabdaa9f8360e45c9cae1202135320bcc0c2db5e86";
const request = { organizationId, propertyId };

function adapter(value: unknown) {
  const getMandatoryChargeConfirmation = vi.fn(
    async () => value as PmsMandatoryChargeConfirmationReadResult,
  );
  const readPort: PmsMandatoryChargeConfirmationReadPort = {
    getMandatoryChargeConfirmation,
  };
  return {
    adapter: createBookingMandatoryChargeConfirmationEvidenceAdapter(readPort),
    getMandatoryChargeConfirmation,
  };
}

describe("createBookingMandatoryChargeConfirmationEvidenceAdapter", () => {
  it("maps parsed PMS evidence into the Booking-owned confirmation boundary", async () => {
    const owner = adapter({
      outcome: "available",
      organizationId,
      propertyId,
      evidence: {
        organizationId,
        propertyId,
        pricingSourceFingerprint: fingerprint,
        confirmationRevision: 7,
        confirmedAt: "2026-08-04T10:00:00.000Z",
      },
    });

    const result = await owner.adapter.getMandatoryChargeConfirmation({
      organizationId: organizationId.toUpperCase(),
      propertyId: propertyId.toUpperCase(),
    });

    expect(owner.getMandatoryChargeConfirmation).toHaveBeenCalledWith(request);
    expect(result).toEqual({
      outcome: "available",
      evidence: {
        organizationId,
        propertyId,
        pricingSourceFingerprint: fingerprint,
        confirmationRevision: 7,
        confirmedAt: "2026-08-04T10:00:00.000Z",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome === "available") expect(Object.isFrozen(result.evidence)).toBe(true);
  });

  it.each([
    [{ outcome: "missing", organizationId, propertyId }, { outcome: "missing" }],
    [{ outcome: "malformed", organizationId, propertyId }, { outcome: "malformed" }],
    [
      { outcome: "unavailable", organizationId, propertyId, errorSource: "provider" },
      { outcome: "unavailable", errorSource: "provider" },
    ],
    [
      { outcome: "unavailable", organizationId, propertyId, errorSource: "system" },
      { outcome: "unavailable", errorSource: "system" },
    ],
  ] as const)("maps the scoped PMS %s result without repeating scope", async (value, expected) => {
    await expect(adapter(value).adapter.getMandatoryChargeConfirmation(request)).resolves.toEqual(
      expected,
    );
  });

  it("rejects mismatched or malformed owner scope and evidence", async () => {
    const wrongScope = {
      outcome: "missing",
      organizationId,
      propertyId: "323e4567-e89b-42d3-a456-426614174000",
    };
    const nestedScopeMismatch = {
      outcome: "available",
      organizationId,
      propertyId,
      evidence: {
        organizationId,
        propertyId: "323e4567-e89b-42d3-a456-426614174000",
        pricingSourceFingerprint: fingerprint,
        confirmationRevision: 7,
        confirmedAt: "2026-08-04T10:00:00.000Z",
      },
    };
    const poisoned = {
      outcome: "missing",
      organizationId,
      propertyId,
      providerSecret: "must-not-cross-booking-boundary",
    };

    for (const value of [wrongScope, nestedScopeMismatch, poisoned]) {
      const result = await adapter(value).adapter.getMandatoryChargeConfirmation(request);
      expect(result).toEqual({ outcome: "malformed" });
      expect(JSON.stringify(result)).not.toContain("must-not-cross-booking-boundary");
    }
  });

  it("does not call PMS for an invalid Booking scope", async () => {
    const owner = adapter({ outcome: "missing", organizationId, propertyId });

    await expect(
      owner.adapter.getMandatoryChargeConfirmation({
        organizationId: "not-an-organization",
        propertyId,
      }),
    ).resolves.toEqual({ outcome: "malformed" });
    expect(owner.getMandatoryChargeConfirmation).not.toHaveBeenCalled();
  });

  it("maps unexpected PMS failures to a secret-safe system unavailability", async () => {
    const readPort: PmsMandatoryChargeConfirmationReadPort = {
      async getMandatoryChargeConfirmation() {
        throw new Error("provider secret must stay private");
      },
    };
    const result =
      await createBookingMandatoryChargeConfirmationEvidenceAdapter(
        readPort,
      ).getMandatoryChargeConfirmation(request);

    expect(result).toEqual({ outcome: "unavailable", errorSource: "system" });
    expect(JSON.stringify(result)).not.toContain("provider secret");
  });

  it("contains exceptions raised while parsing hostile owner evidence", async () => {
    const hostile = Object.defineProperty({}, "organizationId", {
      enumerable: true,
      get() {
        throw new Error("accessor secret must stay private");
      },
    });

    const result = await adapter(hostile).adapter.getMandatoryChargeConfirmation(request);

    expect(result).toEqual({ outcome: "unavailable", errorSource: "system" });
    expect(JSON.stringify(result)).not.toContain("accessor secret");
  });
});
