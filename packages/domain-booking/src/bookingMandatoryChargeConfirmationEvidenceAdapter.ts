import {
  parsePmsMandatoryChargeConfirmationReadResult,
  type PmsMandatoryChargeConfirmationReadPort,
} from "@vayada/domain-pms";

import {
  parseBookingPricingEvidenceRequest,
  parseBookingPricingSourceFingerprint,
  type BookingMandatoryChargeConfirmationEvidencePort,
  type BookingMandatoryChargeConfirmationEvidenceResult,
  type BookingPricingEvidenceRequest,
} from "./bookingPricingEvidence.js";

export function createBookingMandatoryChargeConfirmationEvidenceAdapter(
  readPort: PmsMandatoryChargeConfirmationReadPort,
): BookingMandatoryChargeConfirmationEvidencePort {
  return Object.freeze({
    bookingPricingConfirmationEvidencePort: "pms_mandatory_charges" as const,
    async getMandatoryChargeConfirmation(requestValue: BookingPricingEvidenceRequest) {
      const request = parseBookingPricingEvidenceRequest(requestValue);
      if (!request) return malformed();

      let result: ReturnType<typeof parsePmsMandatoryChargeConfirmationReadResult>;
      try {
        const value: unknown = await readPort.getMandatoryChargeConfirmation(request);
        result = parsePmsMandatoryChargeConfirmationReadResult(value);
      } catch {
        return unavailable("system");
      }

      if (
        !result ||
        result.organizationId !== request.organizationId ||
        result.propertyId !== request.propertyId
      ) {
        return malformed();
      }

      if (result.outcome === "missing" || result.outcome === "malformed") {
        return Object.freeze({ outcome: result.outcome });
      }
      if (result.outcome === "unavailable") return unavailable(result.errorSource);

      const pricingSourceFingerprint = parseBookingPricingSourceFingerprint(
        result.evidence.pricingSourceFingerprint,
      );
      if (!pricingSourceFingerprint) return malformed();

      return Object.freeze({
        outcome: "available" as const,
        evidence: Object.freeze({
          organizationId: result.evidence.organizationId,
          propertyId: result.evidence.propertyId,
          pricingSourceFingerprint,
          confirmationRevision: result.evidence.confirmationRevision,
          confirmedAt: result.evidence.confirmedAt,
        }),
      });
    },
  });
}

function malformed(): BookingMandatoryChargeConfirmationEvidenceResult {
  return Object.freeze({ outcome: "malformed" });
}

function unavailable(
  errorSource: "provider" | "system",
): BookingMandatoryChargeConfirmationEvidenceResult {
  return Object.freeze({ outcome: "unavailable", errorSource });
}
