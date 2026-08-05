import {
  createBookingGuestPolicySourceRevision,
  parseBookingGuestPolicyCatalogCurrentOwnerEvidence,
  parseBookingGuestPolicyCurrentOwnerEvidenceScope,
  parseBookingGuestPolicyPmsCurrentOwnerEvidence,
  parseBookingGuestPolicyRevision,
  type BookingGuestPolicyCatalogCurrentOwnerEvidencePort,
  type BookingGuestPolicyCurrentOwnerEvidenceFailure,
  type BookingGuestPolicyCurrentOwnerEvidencePort,
  type BookingGuestPolicyPmsCurrentOwnerEvidencePort,
  type BookingGuestPolicyReadPort,
} from "@vayada/domain-booking";

export function createBookingGuestPolicyCurrentOwnerEvidenceAdapter(dependencies: {
  booking: Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy">;
  pms: BookingGuestPolicyPmsCurrentOwnerEvidencePort;
  catalog: BookingGuestPolicyCatalogCurrentOwnerEvidencePort;
}): BookingGuestPolicyCurrentOwnerEvidencePort {
  return {
    async getCurrentGuestPolicyOwnerEvidence(input) {
      const scope = parseBookingGuestPolicyCurrentOwnerEvidenceScope(input);
      if (!scope)
        throw new TypeError("Booking guest-policy current owner-evidence scope is malformed");
      const [bookingResult, pmsResult, catalogResult] = await Promise.allSettled([
        dependencies.booking.getCurrentGuestPolicy(scope),
        dependencies.pms.getCurrentGuestPolicyBaseRevisions(scope),
        dependencies.catalog.getCurrentGuestPolicyBaseRevisions(scope),
      ]);
      const failures: BookingGuestPolicyCurrentOwnerEvidenceFailure[] = [];
      const booking =
        bookingResult.status === "fulfilled"
          ? bookingResult.value === null
            ? null
            : parseSafely(() => parseBookingGuestPolicyRevision(bookingResult.value))
          : undefined;
      if (bookingResult.status === "rejected") {
        failures.push({ owner: "booking", outcome: "unavailable", errorSource: "system" });
      } else if (bookingResult.value === null) {
        failures.push({ owner: "booking", outcome: "missing" });
      } else if (
        !booking ||
        booking.organizationId !== scope.organizationId ||
        booking.propertyId !== scope.propertyId
      ) {
        failures.push({ owner: "booking", outcome: "malformed" });
      }

      const pms =
        pmsResult.status === "fulfilled"
          ? parseSafely(() =>
              parseBookingGuestPolicyPmsCurrentOwnerEvidence(pmsResult.value, scope),
            )
          : null;
      collectOwnerFailure(failures, "pms", pmsResult.status, pms);
      const catalog =
        catalogResult.status === "fulfilled"
          ? parseSafely(() =>
              parseBookingGuestPolicyCatalogCurrentOwnerEvidence(catalogResult.value, scope),
            )
          : null;
      collectOwnerFailure(failures, "hotel_catalog", catalogResult.status, catalog);

      if (
        failures.length > 0 ||
        !booking ||
        !pms ||
        pms.outcome !== "available" ||
        !catalog ||
        catalog.outcome !== "available"
      ) {
        return Object.freeze({
          outcome: "unavailable",
          organizationId: scope.organizationId,
          propertyId: scope.propertyId,
          failures: Object.freeze(failures),
        });
      }
      return Object.freeze({
        outcome: "available",
        organizationId: scope.organizationId,
        propertyId: scope.propertyId,
        currentBaseRevisions: Object.freeze({
          "booking.guest_experience": createBookingGuestPolicySourceRevision(
            booking.propertyId,
            booking.revision,
          ).revision,
          "pms.pricing_settings": pms.evidence.revisions["pms.pricing_settings"],
          "pms.rate_plans": pms.evidence.revisions["pms.rate_plans"],
          "pms.room_types": pms.evidence.revisions["pms.room_types"],
          "hotel_catalog.location": catalog.evidence.revisions["hotel_catalog.location"],
          "hotel_catalog.policy": catalog.evidence.revisions["hotel_catalog.policy"],
        }),
      });
    },
  };
}

function parseSafely<Result>(parse: () => Result): Result | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

function collectOwnerFailure(
  failures: BookingGuestPolicyCurrentOwnerEvidenceFailure[],
  owner: "pms" | "hotel_catalog",
  promiseStatus: PromiseSettledResult<unknown>["status"],
  result:
    | ReturnType<typeof parseBookingGuestPolicyPmsCurrentOwnerEvidence>
    | ReturnType<typeof parseBookingGuestPolicyCatalogCurrentOwnerEvidence>,
): void {
  if (promiseStatus === "rejected") {
    failures.push({ owner, outcome: "unavailable", errorSource: "system" });
  } else if (!result) {
    failures.push({ owner, outcome: "malformed" });
  } else if (result.outcome === "unavailable") {
    failures.push({ owner, outcome: "unavailable", errorSource: result.errorSource });
  } else if (result.outcome !== "available") {
    failures.push({ owner, outcome: result.outcome });
  }
}
