import {
  parseBookingGuestPolicyCurrentOwnerEvidenceScope,
  type BookingGuestPolicyCatalogCurrentOwnerEvidencePort,
  type BookingGuestPolicyCurrentOwnerEvidenceScope,
} from "@vayada/domain-booking";
import {
  parseHotelCatalogLocationCurrentOwnerEvidenceResult,
  parseHotelCatalogPolicyCurrentOwnerEvidenceResult,
  type HotelCatalogLocationCurrentOwnerEvidencePort,
  type HotelCatalogLocationCurrentOwnerEvidenceResult,
  type HotelCatalogPolicyCurrentOwnerEvidencePort,
  type HotelCatalogPolicyCurrentOwnerEvidenceResult,
} from "@vayada/domain-hotels";

type CatalogOwnerResult =
  | HotelCatalogLocationCurrentOwnerEvidenceResult
  | HotelCatalogPolicyCurrentOwnerEvidenceResult
  | null;

type BookingCatalogResult = Awaited<
  ReturnType<
    BookingGuestPolicyCatalogCurrentOwnerEvidencePort["getCurrentGuestPolicyBaseRevisions"]
  >
>;

type BookingCatalogFailure = Exclude<BookingCatalogResult, { outcome: "available" }>;

const SYSTEM_UNAVAILABLE = Object.freeze({
  outcome: "unavailable" as const,
  errorSource: "system" as const,
});

export function createBookingGuestPolicyCatalogCurrentOwnerEvidenceAdapter(dependencies: {
  location: HotelCatalogLocationCurrentOwnerEvidencePort;
  policy: HotelCatalogPolicyCurrentOwnerEvidencePort;
}): BookingGuestPolicyCatalogCurrentOwnerEvidencePort {
  return Object.freeze({
    bookingGuestPolicyCurrentOwnerEvidencePort: "hotel_catalog" as const,
    async getCurrentGuestPolicyBaseRevisions(input: BookingGuestPolicyCurrentOwnerEvidenceScope) {
      const scope = parseBookingGuestPolicyCurrentOwnerEvidenceScope(input);
      if (!scope) return Object.freeze({ outcome: "malformed" as const });

      const [locationSettled, policySettled] = await Promise.allSettled([
        Promise.resolve().then(() => dependencies.location.getCurrentLocationOwnerEvidence(scope)),
        Promise.resolve().then(() => dependencies.policy.getCurrentPolicyOwnerEvidence(scope)),
      ]);
      const location =
        locationSettled.status === "fulfilled"
          ? parseSafely(() =>
              parseHotelCatalogLocationCurrentOwnerEvidenceResult(locationSettled.value, scope),
            )
          : SYSTEM_UNAVAILABLE;
      const policy =
        policySettled.status === "fulfilled"
          ? parseSafely(() =>
              parseHotelCatalogPolicyCurrentOwnerEvidenceResult(policySettled.value, scope),
            )
          : SYSTEM_UNAVAILABLE;
      const failure = catalogFailure([location, policy]);
      if (failure) return failure;
      if (location?.outcome !== "available" || policy?.outcome !== "available")
        return Object.freeze({ outcome: "malformed" as const });

      return Object.freeze({
        outcome: "available" as const,
        evidence: Object.freeze({
          organizationId: scope.organizationId,
          propertyId: scope.propertyId,
          revisions: Object.freeze({
            "hotel_catalog.location": location.evidence.baseRevision,
            "hotel_catalog.policy": policy.evidence.baseRevision,
          }),
        }),
      });
    },
  });
}

function catalogFailure(results: readonly CatalogOwnerResult[]): BookingCatalogFailure | null {
  if (results.some((result) => !result || result.outcome === "malformed"))
    return Object.freeze({ outcome: "malformed" });
  if (
    results.some((result) => result?.outcome === "unavailable" && result.errorSource === "system")
  )
    return SYSTEM_UNAVAILABLE;
  if (
    results.some((result) => result?.outcome === "unavailable" && result.errorSource === "provider")
  )
    return Object.freeze({ outcome: "unavailable", errorSource: "provider" });
  return results.some((result) => result?.outcome === "missing")
    ? Object.freeze({ outcome: "missing" })
    : null;
}

function parseSafely<Result>(parse: () => Result): Result | null {
  try {
    return parse();
  } catch {
    return null;
  }
}
