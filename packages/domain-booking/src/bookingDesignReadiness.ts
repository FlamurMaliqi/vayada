import type {
  PropertyMediaPublicVariant,
  ReadinessErrorSource,
  SourceEntityRevision,
} from "@vayada/domain-hotels";

import {
  BOOKING_DESIGN_FONT_PAIRINGS,
  createBookingDesignButtonColors,
  createBookingDesignSourceRevision,
  parseBookingDesignRevision,
  type BookingDesignReadPort,
  type BookingDesignSourceRevision,
} from "./bookingDesign.js";
import {
  BOOKING_DESIGN_COVER_FALLBACK_PATH,
  BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION,
  parseBookingDesignCatalogCoverAssignmentEvidenceResult,
  parseBookingDesignCatalogProfileEvidenceResult,
  parseBookingDesignCatalogSafeMediaEvidenceResult,
  type BookingDesignCatalogCoverAssignmentEvidencePort,
  type BookingDesignCatalogEvidenceFailure,
  type BookingDesignCatalogEvidencePortKey,
  type BookingDesignCatalogProfileEvidencePort,
  type BookingDesignCatalogSafeMediaEvidencePort,
} from "./bookingDesignSnapshot.js";

export const BOOKING_DESIGN_READINESS_BLOCKER_CODES = Object.freeze([
  "booking_design_missing",
  "booking_design_profile_missing",
  "booking_design_profile_stale",
  "booking_design_cover_assignment_missing",
  "booking_design_cover_assignment_stale",
  "booking_design_safe_media_missing",
  "booking_design_safe_media_stale",
] as const);

export const BOOKING_DESIGN_PROVIDER_FAILURE_CODES = Object.freeze([
  "booking_design_request_invalid",
  "booking_design_revision_invalid",
  "booking_design_revision_unavailable",
  "booking_design_profile_invalid",
  "booking_design_profile_unavailable",
  "booking_design_cover_assignment_invalid",
  "booking_design_cover_assignment_unavailable",
  "booking_design_safe_media_invalid",
  "booking_design_safe_media_unavailable",
] as const);

const OWNER_BLOCKER_CODES = Object.freeze({
  profile: Object.freeze({
    missing: "booking_design_profile_missing",
    stale: "booking_design_profile_stale",
  }),
  cover_assignment: Object.freeze({
    missing: "booking_design_cover_assignment_missing",
    stale: "booking_design_cover_assignment_stale",
  }),
  safe_media: Object.freeze({
    missing: "booking_design_safe_media_missing",
    stale: "booking_design_safe_media_stale",
  }),
} as const);

const OWNER_INVALID_CODES = Object.freeze({
  profile: "booking_design_profile_invalid",
  cover_assignment: "booking_design_cover_assignment_invalid",
  safe_media: "booking_design_safe_media_invalid",
} as const);

const OWNER_UNAVAILABLE_CODES = Object.freeze({
  profile: "booking_design_profile_unavailable",
  cover_assignment: "booking_design_cover_assignment_unavailable",
  safe_media: "booking_design_safe_media_unavailable",
} as const);

export type BookingDesignReadinessBlockerCode =
  (typeof BOOKING_DESIGN_READINESS_BLOCKER_CODES)[number];
export type BookingDesignProviderFailureCode =
  (typeof BOOKING_DESIGN_PROVIDER_FAILURE_CODES)[number];
export type BookingDesignReadinessEvidencePort = BookingDesignCatalogEvidencePortKey | "design";

export type BookingDesignRendererSnapshot = Readonly<{
  contractVersion: typeof BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  sourceBindings: readonly SourceEntityRevision[];
  appearance: Readonly<{
    primaryColor: string;
    fontPairing: string;
    headingFontFamily: string;
    bodyFontFamily: string;
    button: ReturnType<typeof createBookingDesignButtonColors>;
  }>;
  profile: Readonly<{
    displayName: string;
    contentLocale: string;
    shortDescription: string;
  }>;
  cover:
    | Readonly<{ kind: "fallback"; path: typeof BOOKING_DESIGN_COVER_FALLBACK_PATH }>
    | Readonly<{
        kind: "safe_media";
        mediaObjectId: string;
        altText: string | null;
        publicVariants: readonly Readonly<PropertyMediaPublicVariant>[];
      }>;
}>;

export type BookingDesignReadinessResult =
  | Readonly<{
      outcome: "ready";
      organizationId: string;
      propertyId: string;
      designSource: BookingDesignSourceRevision;
      snapshot: BookingDesignRendererSnapshot;
    }>
  | Readonly<{
      outcome: "blocked";
      organizationId: string;
      propertyId: string;
      blocker: Readonly<{
        code: BookingDesignReadinessBlockerCode;
        evidencePort: BookingDesignReadinessEvidencePort;
      }>;
    }>
  | Readonly<{
      outcome: "provider_failure";
      organizationId: string;
      propertyId: string;
      error: Readonly<{
        code: BookingDesignProviderFailureCode;
        evidencePort: BookingDesignReadinessEvidencePort;
        errorSource: ReadinessErrorSource;
      }>;
    }>;

export interface BookingDesignReadinessPort {
  getBookingDesignReadiness(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<BookingDesignReadinessResult>;
}

export function createBookingDesignReadinessProvider(config: {
  design: BookingDesignReadPort;
  profile: BookingDesignCatalogProfileEvidencePort;
  coverAssignment: BookingDesignCatalogCoverAssignmentEvidencePort;
  safeMedia: BookingDesignCatalogSafeMediaEvidencePort;
}): BookingDesignReadinessPort {
  return {
    async getBookingDesignReadiness(input) {
      const scope = parseSafely(() => parseScope(input));
      if (!scope) return providerFailure("", "", "design", "booking_design_request_invalid");

      let rawDesign: unknown;
      try {
        rawDesign = await config.design.getCurrentDesign(scope);
      } catch {
        return providerFailure(
          scope.organizationId,
          scope.propertyId,
          "design",
          "booking_design_revision_unavailable",
          "system",
        );
      }
      if (rawDesign === null) return blocked(scope, "design", "booking_design_missing");
      const design = parseSafely(() => parseBookingDesignRevision(rawDesign));
      if (!design || design.propertyId !== scope.propertyId) {
        return providerFailure(
          scope.organizationId,
          scope.propertyId,
          "design",
          "booking_design_revision_invalid",
        );
      }
      const designSource = createBookingDesignSourceRevision(design.propertyId, design.revision);

      let rawProfile: unknown;
      try {
        rawProfile = await config.profile.getBookingDesignProfileEvidence(scope);
      } catch {
        return unavailable(scope, "profile", "system");
      }
      const profile = parseSafely(() =>
        parseBookingDesignCatalogProfileEvidenceResult(rawProfile, scope),
      );
      if (!profile) return invalid(scope, "profile");
      if (profile.outcome !== "evidence") return ownerFailure(scope, profile);

      let rawCover: unknown;
      try {
        rawCover = await config.coverAssignment.getBookingDesignCoverAssignmentEvidence(scope);
      } catch {
        return unavailable(scope, "cover_assignment", "system");
      }
      const assignment = parseSafely(() =>
        parseBookingDesignCatalogCoverAssignmentEvidenceResult(rawCover, scope),
      );
      if (!assignment) return invalid(scope, "cover_assignment");
      if (assignment.outcome !== "evidence") return ownerFailure(scope, assignment);

      const sources: SourceEntityRevision[] = [designSource, profile.source, assignment.source];
      let cover: BookingDesignRendererSnapshot["cover"];
      if (assignment.cover === null) {
        cover = Object.freeze({ kind: "fallback", path: BOOKING_DESIGN_COVER_FALLBACK_PATH });
      } else {
        const assignedCover = assignment.cover;
        let rawMedia: unknown;
        try {
          rawMedia = await config.safeMedia.getBookingDesignSafeMediaEvidence({
            ...scope,
            mediaObjectId: assignedCover.mediaObjectId,
          });
        } catch {
          return unavailable(scope, "safe_media", "system");
        }
        const safeMedia = parseSafely(() =>
          parseBookingDesignCatalogSafeMediaEvidenceResult(rawMedia, {
            ...scope,
            mediaObjectId: assignedCover.mediaObjectId,
          }),
        );
        if (!safeMedia) return invalid(scope, "safe_media");
        if (safeMedia.outcome !== "evidence") return ownerFailure(scope, safeMedia);
        if (
          safeMedia.media.mediaObjectId !== assignedCover.mediaObjectId ||
          safeMedia.source.entityId !== assignedCover.mediaObjectId
        ) {
          return invalid(scope, "safe_media");
        }
        sources.push(safeMedia.source);
        cover = Object.freeze({
          kind: "safe_media",
          mediaObjectId: safeMedia.media.mediaObjectId,
          altText: assignedCover.altText,
          publicVariants: Object.freeze(
            safeMedia.media.publicVariants
              .map((variant) => Object.freeze({ ...variant }))
              .sort((left, right) => compareText(left.variantName, right.variantName)),
          ),
        });
      }

      const pairing = BOOKING_DESIGN_FONT_PAIRINGS[design.choices.fontPairing];
      const snapshot = Object.freeze({
        contractVersion: BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION,
        ...scope,
        sourceBindings: Object.freeze(
          sources.slice().sort((left, right) => compareText(sourceKey(left), sourceKey(right))),
        ),
        appearance: Object.freeze({
          primaryColor: design.choices.primaryColor,
          fontPairing: design.choices.fontPairing,
          headingFontFamily: pairing.headingFamily,
          bodyFontFamily: pairing.bodyFamily,
          button: createBookingDesignButtonColors(design.choices.primaryColor),
        }),
        profile: Object.freeze({
          displayName: profile.profile.displayName,
          contentLocale: profile.profile.contentLocale,
          shortDescription: profile.profile.shortDescription,
        }),
        cover,
      }) as BookingDesignRendererSnapshot;
      return Object.freeze({ outcome: "ready", ...scope, designSource, snapshot });
    },
  };
}

function ownerFailure(
  scope: Readonly<{ organizationId: string; propertyId: string }>,
  failure: BookingDesignCatalogEvidenceFailure,
): BookingDesignReadinessResult {
  return failure.outcome === "unavailable"
    ? unavailable(scope, failure.evidencePort, failure.errorSource)
    : blocked(
        scope,
        failure.evidencePort,
        OWNER_BLOCKER_CODES[failure.evidencePort][failure.outcome],
      );
}

function invalid(
  scope: Readonly<{ organizationId: string; propertyId: string }>,
  port: BookingDesignCatalogEvidencePortKey,
): BookingDesignReadinessResult {
  return providerFailure(scope.organizationId, scope.propertyId, port, OWNER_INVALID_CODES[port]);
}

function unavailable(
  scope: Readonly<{ organizationId: string; propertyId: string }>,
  port: BookingDesignCatalogEvidencePortKey,
  errorSource: ReadinessErrorSource,
): BookingDesignReadinessResult {
  return providerFailure(
    scope.organizationId,
    scope.propertyId,
    port,
    OWNER_UNAVAILABLE_CODES[port],
    errorSource,
  );
}

function blocked(
  scope: Readonly<{ organizationId: string; propertyId: string }>,
  evidencePort: BookingDesignReadinessEvidencePort,
  code: BookingDesignReadinessBlockerCode,
): BookingDesignReadinessResult {
  return Object.freeze({
    outcome: "blocked",
    ...scope,
    blocker: Object.freeze({ code, evidencePort }),
  });
}

function providerFailure(
  organizationId: string,
  propertyId: string,
  evidencePort: BookingDesignReadinessEvidencePort,
  code: BookingDesignProviderFailureCode,
  errorSource: ReadinessErrorSource = "provider",
): BookingDesignReadinessResult {
  return Object.freeze({
    outcome: "provider_failure",
    organizationId,
    propertyId,
    error: Object.freeze({ code, evidencePort, errorSource }),
  });
}

function parseScope(input: { organizationId: string; propertyId: string }) {
  if (!exact(input, ["organizationId", "propertyId"])) return null;
  const organizationId = input["organizationId"];
  const propertyId = input["propertyId"];
  if (!uuid(organizationId) || !uuid(propertyId)) return null;
  return Object.freeze({
    organizationId: organizationId.toLowerCase(),
    propertyId: propertyId.toLowerCase(),
  });
}

function sourceKey(source: SourceEntityRevision): string {
  return JSON.stringify([source.ownerDomain, source.entityType, source.entityId]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseSafely<Value>(parse: () => Value): Value | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
