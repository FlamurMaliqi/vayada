import type {
  PropertyMediaPublicVariant,
  ReadinessErrorSource,
  SourceEntityRevision,
} from "@vayada/domain-hotels";
import {
  HOTEL_CATALOG_CONTENT_LOCALES,
  PROPERTY_MEDIA_MAX_ALT_TEXT_LENGTH,
  normalizeHotelCatalogStep1Summary,
  parsePropertyMediaLibraryItem,
} from "@vayada/domain-hotels";

import {
  BOOKING_DESIGN_FONT_PAIRINGS,
  BOOKING_DESIGN_PRIMARY_COLORS,
  createBookingDesignButtonColors,
  createBookingDesignSourceRevision,
  parseBookingDesignRevision,
  type BookingDesignReadPort,
  type BookingDesignFontPairing,
  type BookingDesignPrimaryColor,
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

/** Strict wire/port parser for the protected renderer-readiness result. */
export function parseBookingDesignReadinessResult(
  value: unknown,
  expectedScope: Readonly<{ organizationId: string; propertyId: string }>,
): BookingDesignReadinessResult | null {
  const scope = parseSafely(() => parseScope(expectedScope));
  if (!scope) return null;
  if (
    exact(value, ["outcome", "organizationId", "propertyId", "blocker"]) &&
    value["outcome"] === "blocked" &&
    matchesScope(value, scope) &&
    exact(value["blocker"], ["code", "evidencePort"]) &&
    BOOKING_DESIGN_READINESS_BLOCKER_CODES.includes(
      value["blocker"]["code"] as BookingDesignReadinessBlockerCode,
    ) &&
    readinessEvidencePort(value["blocker"]["evidencePort"])
  ) {
    return Object.freeze({
      outcome: "blocked",
      ...scope,
      blocker: Object.freeze({
        code: value["blocker"]["code"] as BookingDesignReadinessBlockerCode,
        evidencePort: value["blocker"]["evidencePort"],
      }),
    });
  }
  if (
    exact(value, ["outcome", "organizationId", "propertyId", "error"]) &&
    value["outcome"] === "provider_failure" &&
    matchesScope(value, scope) &&
    exact(value["error"], ["code", "evidencePort", "errorSource"]) &&
    BOOKING_DESIGN_PROVIDER_FAILURE_CODES.includes(
      value["error"]["code"] as BookingDesignProviderFailureCode,
    ) &&
    readinessEvidencePort(value["error"]["evidencePort"]) &&
    (value["error"]["errorSource"] === "provider" || value["error"]["errorSource"] === "system")
  ) {
    return Object.freeze({
      outcome: "provider_failure",
      ...scope,
      error: Object.freeze({
        code: value["error"]["code"] as BookingDesignProviderFailureCode,
        evidencePort: value["error"]["evidencePort"],
        errorSource: value["error"]["errorSource"],
      }),
    });
  }
  if (
    !exact(value, ["outcome", "organizationId", "propertyId", "designSource", "snapshot"]) ||
    value["outcome"] !== "ready" ||
    !matchesScope(value, scope)
  ) {
    return null;
  }
  const designSource = parseRendererSource(value["designSource"]);
  const snapshot = parseRendererSnapshot(value["snapshot"], scope, designSource);
  if (
    !designSource ||
    designSource.ownerDomain !== "booking" ||
    designSource.entityType !== "design_revision" ||
    designSource.entityId !== scope.propertyId ||
    !/^design:[1-9][0-9]*$/.test(designSource.revision) ||
    !snapshot
  ) {
    return null;
  }
  return Object.freeze({
    outcome: "ready",
    ...scope,
    designSource: designSource as BookingDesignSourceRevision,
    snapshot,
  });
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

function parseRendererSnapshot(
  value: unknown,
  scope: Readonly<{ organizationId: string; propertyId: string }>,
  designSource: SourceEntityRevision | null,
): BookingDesignRendererSnapshot | null {
  if (
    !designSource ||
    !exact(value, [
      "contractVersion",
      "organizationId",
      "propertyId",
      "sourceBindings",
      "appearance",
      "profile",
      "cover",
    ]) ||
    value["contractVersion"] !== BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION ||
    !matchesScope(value, scope) ||
    !dataArray(value["sourceBindings"])
  ) {
    return null;
  }
  const appearance = parseRendererAppearance(value["appearance"]);
  const profile = parseRendererProfile(value["profile"]);
  const cover = parseRendererCover(value["cover"]);
  const sources = value["sourceBindings"].map(parseRendererSource);
  if (!appearance || !profile || !cover || sources.some((source) => !source)) return null;
  const sourceBindings = sources as SourceEntityRevision[];
  const safeMediaId = cover.kind === "safe_media" ? cover.mediaObjectId : null;
  const expectedIdentities = [
    "booking:design_revision:" + scope.propertyId,
    "hotel_catalog:property_profile:" + scope.propertyId,
    "hotel_catalog:property_media_assignment:" + scope.propertyId,
    ...(safeMediaId ? [`hotel_catalog:property_safe_media:${safeMediaId}`] : []),
  ];
  const actualIdentities = sourceBindings.map(sourceIdentity);
  const sorted = sourceBindings
    .slice()
    .sort((left, right) => compareText(sourceKey(left), sourceKey(right)));
  if (
    actualIdentities.length !== expectedIdentities.length ||
    new Set(actualIdentities).size !== actualIdentities.length ||
    !expectedIdentities.every((identity) => actualIdentities.includes(identity)) ||
    !sourceBindings.every(
      (source, index) =>
        source === sorted[index] || sourceKey(source) === sourceKey(sorted[index]!),
    ) ||
    !sameSource(
      sourceBindings.find((source) => sourceIdentity(source) === expectedIdentities[0]),
      designSource,
    )
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION,
    ...scope,
    sourceBindings: Object.freeze(sourceBindings),
    appearance,
    profile,
    cover,
  });
}

function parseRendererAppearance(
  value: unknown,
): BookingDesignRendererSnapshot["appearance"] | null {
  if (
    !exact(value, [
      "primaryColor",
      "fontPairing",
      "headingFontFamily",
      "bodyFontFamily",
      "button",
    ]) ||
    !BOOKING_DESIGN_PRIMARY_COLORS.includes(value["primaryColor"] as BookingDesignPrimaryColor) ||
    !Object.hasOwn(BOOKING_DESIGN_FONT_PAIRINGS, value["fontPairing"] as PropertyKey)
  ) {
    return null;
  }
  const primaryColor = value["primaryColor"] as BookingDesignPrimaryColor;
  const fontPairing = value["fontPairing"] as BookingDesignFontPairing;
  const pairing = BOOKING_DESIGN_FONT_PAIRINGS[fontPairing];
  const button = createBookingDesignButtonColors(primaryColor);
  if (
    value["headingFontFamily"] !== pairing.headingFamily ||
    value["bodyFontFamily"] !== pairing.bodyFamily ||
    !exact(value["button"], ["backgroundColor", "hoverBackgroundColor", "foregroundColor"]) ||
    value["button"]["backgroundColor"] !== button.backgroundColor ||
    value["button"]["hoverBackgroundColor"] !== button.hoverBackgroundColor ||
    value["button"]["foregroundColor"] !== button.foregroundColor
  ) {
    return null;
  }
  return Object.freeze({
    primaryColor,
    fontPairing,
    headingFontFamily: pairing.headingFamily,
    bodyFontFamily: pairing.bodyFamily,
    button,
  });
}

function parseRendererProfile(value: unknown): BookingDesignRendererSnapshot["profile"] | null {
  if (
    !exact(value, ["displayName", "contentLocale", "shortDescription"]) ||
    typeof value["displayName"] !== "string" ||
    value["displayName"].trim().length === 0 ||
    value["displayName"].trim() !== value["displayName"] ||
    !HOTEL_CATALOG_CONTENT_LOCALES.includes(value["contentLocale"] as never) ||
    typeof value["shortDescription"] !== "string" ||
    normalizeHotelCatalogStep1Summary(value["shortDescription"]) !== value["shortDescription"]
  ) {
    return null;
  }
  return Object.freeze({
    displayName: value["displayName"],
    contentLocale: value["contentLocale"] as string,
    shortDescription: value["shortDescription"],
  });
}

function parseRendererCover(value: unknown): BookingDesignRendererSnapshot["cover"] | null {
  if (
    exact(value, ["kind", "path"]) &&
    value["kind"] === "fallback" &&
    value["path"] === BOOKING_DESIGN_COVER_FALLBACK_PATH
  ) {
    return Object.freeze({ kind: "fallback", path: BOOKING_DESIGN_COVER_FALLBACK_PATH });
  }
  if (
    !exact(value, ["kind", "mediaObjectId", "altText", "publicVariants"]) ||
    value["kind"] !== "safe_media" ||
    !uuid(value["mediaObjectId"]) ||
    !(
      value["altText"] === null ||
      (typeof value["altText"] === "string" &&
        value["altText"].length <= PROPERTY_MEDIA_MAX_ALT_TEXT_LENGTH)
    )
  ) {
    return null;
  }
  const media = parsePropertyMediaLibraryItem({
    mediaObjectId: value["mediaObjectId"],
    purpose: "property.hero_image",
    status: "public_ready",
    publicVariants: value["publicVariants"],
  });
  if (
    !media ||
    !media.publicVariants.some(({ variantName }) => variantName === "original_safe") ||
    media.publicVariants.some(
      (variant, index) =>
        index > 0 &&
        compareText(media.publicVariants[index - 1]!.variantName, variant.variantName) > 0,
    )
  ) {
    return null;
  }
  return Object.freeze({
    kind: "safe_media",
    mediaObjectId: media.mediaObjectId,
    altText: value["altText"] as string | null,
    publicVariants: media.publicVariants,
  });
}

function parseRendererSource(value: unknown): SourceEntityRevision | null {
  if (
    !exact(value, ["ownerDomain", "entityType", "entityId", "revision"]) ||
    !sourceOwnerDomain(value["ownerDomain"]) ||
    !token(value["entityType"]) ||
    !uuid(value["entityId"]) ||
    !token(value["revision"])
  ) {
    return null;
  }
  return Object.freeze({
    ownerDomain: value["ownerDomain"],
    entityType: value["entityType"],
    entityId: value["entityId"].toLowerCase(),
    revision: value["revision"],
  });
}

function sourceOwnerDomain(value: unknown): value is SourceEntityRevision["ownerDomain"] {
  return (
    value === "booking" ||
    value === "hotel_catalog" ||
    value === "marketplace" ||
    value === "pms" ||
    value === "finance"
  );
}

function sourceIdentity(source: SourceEntityRevision): string {
  return `${source.ownerDomain}:${source.entityType}:${source.entityId}`;
}

function sameSource(left: SourceEntityRevision | undefined, right: SourceEntityRevision): boolean {
  return Boolean(
    left &&
    left.ownerDomain === right.ownerDomain &&
    left.entityType === right.entityType &&
    left.entityId === right.entityId &&
    left.revision === right.revision,
  );
}

function matchesScope(
  value: Record<string, unknown>,
  scope: Readonly<{ organizationId: string; propertyId: string }>,
): boolean {
  return (
    typeof value["organizationId"] === "string" &&
    typeof value["propertyId"] === "string" &&
    value["organizationId"].toLowerCase() === scope.organizationId &&
    value["propertyId"].toLowerCase() === scope.propertyId
  );
}

function readinessEvidencePort(value: unknown): value is BookingDesignReadinessEvidencePort {
  return (
    value === "design" ||
    value === "profile" ||
    value === "cover_assignment" ||
    value === "safe_media"
  );
}

function dataArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

function token(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
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
