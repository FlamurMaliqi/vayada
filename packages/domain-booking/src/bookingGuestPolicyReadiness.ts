import {
  BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION,
  createBookingGuestPolicySourceRevision,
  parseBookingGuestPolicyHash,
  type BookingGuestPolicyChoices,
  type BookingGuestPolicyComposition,
  type BookingGuestPolicyCompositionBlocker,
  type BookingGuestPolicyCurrentSourceRevision,
  type BookingGuestPolicyHash,
} from "./bookingGuestPolicy.js";
import {
  parseBookingGuestPolicyRevision,
  type BookingGuestPolicyCommandPort,
  type BookingGuestPolicyRevision,
  type BookingGuestPolicySetupAggregate,
} from "./bookingGuestPolicyAggregate.js";
import {
  BOOKING_GUEST_POLICY_CURRENT_BASE_REVISION_KEYS,
  type BookingGuestPolicyCurrentBaseRevisions,
  type BookingGuestPolicyCurrentOwnerEvidenceResult,
} from "./bookingGuestPolicyCurrentOwnerEvidence.js";

export const BOOKING_GUEST_POLICY_READINESS_CONTRACT_VERSION =
  "booking-guest-policy-readiness.v1" as const;

export type BookingGuestPolicyReadinessBlockerCode =
  | BookingGuestPolicyCompositionBlocker["code"]
  | "guest_policy_not_configured"
  | "guest_policy_source_stale"
  | "current_owner_evidence_missing"
  | "current_owner_evidence_malformed"
  | "current_owner_evidence_unavailable"
  | "catalog_projection_pending"
  | "catalog_projection_conflict"
  | "catalog_projection_stale";

export type BookingGuestPolicyReadinessBlocker = Readonly<{
  code: BookingGuestPolicyReadinessBlockerCode;
  kind: "user_fixable" | "external_pending" | "provider_failure";
  owner?: "booking" | "pms" | "hotel_catalog";
  roomTypeId?: string;
  sourceId?: string;
}>;

export type BookingGuestPolicyReadiness = Readonly<{
  contractVersion: typeof BOOKING_GUEST_POLICY_READINESS_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  status: "ready" | "blocked" | "pending";
  guestPolicySourceRevision: BookingGuestPolicyCurrentSourceRevision["revision"];
  sourceFingerprint: BookingGuestPolicyHash | null;
  currentBaseRevisions: BookingGuestPolicyCurrentBaseRevisions | null;
  blockers: readonly BookingGuestPolicyReadinessBlocker[];
}>;

export interface BookingGuestPolicySetupReadPort {
  getGuestPolicySetup(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<BookingGuestPolicySetupAggregate>;
}

export interface BookingGuestPolicyPreviewPort {
  previewGuestPolicy(input: {
    organizationId: string;
    propertyId: string;
    choices: BookingGuestPolicyChoices;
  }): Promise<BookingGuestPolicyComposition>;
}

export interface BookingGuestPolicyReadinessPort {
  getGuestPolicyReadiness(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<BookingGuestPolicyReadiness>;
}

export type BookingGuestPolicyApplicationPort = BookingGuestPolicyCommandPort &
  BookingGuestPolicySetupReadPort &
  BookingGuestPolicyPreviewPort &
  BookingGuestPolicyReadinessPort;

export function evaluateBookingGuestPolicyReadiness(input: {
  organizationId: string;
  propertyId: string;
  current: BookingGuestPolicyRevision | null;
  composition: BookingGuestPolicyComposition | null;
  currentOwnerEvidence: BookingGuestPolicyCurrentOwnerEvidenceResult;
}): BookingGuestPolicyReadiness {
  const scope = parseScope(input);
  const current = input.current === null ? null : parseBookingGuestPolicyRevision(input.current);
  if (
    !scope ||
    (input.current !== null && current === null) ||
    (current !== null &&
      (current.organizationId !== scope.organizationId || current.propertyId !== scope.propertyId))
  )
    throw new TypeError("Booking guest-policy readiness input is invalid");

  const blockers: BookingGuestPolicyReadinessBlocker[] = [];
  let configurationBlocked = false;
  if (!current) {
    blockers.push(blocker("guest_policy_not_configured", "user_fixable"));
    configurationBlocked = true;
  } else if (!input.composition || input.composition.outcome === "blocked") {
    for (const compositionBlocker of input.composition?.blockers ?? []) {
      blockers.push(Object.freeze({ ...compositionBlocker, kind: "user_fixable" as const }));
    }
    if (blockers.length === 0) blockers.push(blocker("guest_policy_source_stale", "user_fixable"));
    configurationBlocked = true;
  } else if (
    input.composition.bundle.organizationId !== scope.organizationId ||
    input.composition.bundle.propertyId !== scope.propertyId ||
    input.composition.bundle.sourceFingerprint !== current.bundle.sourceFingerprint ||
    input.composition.bundle.bundleHash !== current.bundle.bundleHash
  ) {
    blockers.push(blocker("guest_policy_source_stale", "user_fixable"));
    configurationBlocked = true;
  }

  const expectedGuestPolicyRevision = current
    ? createBookingGuestPolicySourceRevision(current.propertyId, current.revision).revision
    : BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION;
  let currentBaseRevisions = ownerBaseRevisions(input.currentOwnerEvidence, scope, blockers);
  if (
    currentBaseRevisions &&
    currentBaseRevisions["booking.guest_experience"] !== expectedGuestPolicyRevision
  ) {
    blockers.push(blocker("current_owner_evidence_malformed", "provider_failure", "booking"));
    currentBaseRevisions = null;
  }

  if (!configurationBlocked && current) {
    const receipt = current.projectionReceipt;
    if (!receipt) {
      blockers.push(blocker("catalog_projection_pending", "external_pending", "hotel_catalog"));
    } else if (receipt.outcome === "source_revision_conflict") {
      blockers.push(blocker("catalog_projection_conflict", "external_pending", "hotel_catalog"));
    } else if (
      receipt.projectedGuestPolicyRevision !== current.revision ||
      !currentBaseRevisions ||
      !catalogPolicyRevisionMatches(
        currentBaseRevisions["hotel_catalog.policy"],
        current.propertyId,
        receipt.catalogPolicyProjectionRevision,
      )
    ) {
      blockers.push(blocker("catalog_projection_stale", "external_pending", "hotel_catalog"));
    }
  }

  const status = configurationBlocked
    ? "blocked"
    : blockers.some(({ kind }) => kind === "user_fixable")
      ? "blocked"
      : blockers.length > 0
        ? "pending"
        : "ready";
  return deepFreeze({
    contractVersion: BOOKING_GUEST_POLICY_READINESS_CONTRACT_VERSION,
    organizationId: scope.organizationId,
    propertyId: scope.propertyId,
    status,
    guestPolicySourceRevision: expectedGuestPolicyRevision,
    sourceFingerprint: current?.bundle.sourceFingerprint ?? null,
    currentBaseRevisions,
    blockers,
  });
}

export function parseBookingGuestPolicyReadiness(
  value: unknown,
): BookingGuestPolicyReadiness | null {
  if (
    !exactDataRecord(value, [
      "contractVersion",
      "organizationId",
      "propertyId",
      "status",
      "guestPolicySourceRevision",
      "sourceFingerprint",
      "currentBaseRevisions",
      "blockers",
    ]) ||
    value.contractVersion !== BOOKING_GUEST_POLICY_READINESS_CONTRACT_VERSION ||
    !canonicalUuid(value.organizationId) ||
    !canonicalUuid(value.propertyId) ||
    (value.status !== "ready" && value.status !== "blocked" && value.status !== "pending") ||
    !guestPolicyBaseRevision(value.guestPolicySourceRevision) ||
    (value.sourceFingerprint !== null && !parseBookingGuestPolicyHash(value.sourceFingerprint)) ||
    !Array.isArray(value.blockers)
  )
    return null;
  const currentBaseRevisions = parseCurrentBaseRevisions(value.currentBaseRevisions);
  const blockers = value.blockers.map(parseReadinessBlocker);
  if (
    (value.currentBaseRevisions !== null && !currentBaseRevisions) ||
    blockers.some((candidate) => !candidate) ||
    (value.guestPolicySourceRevision === BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION) !==
      (value.sourceFingerprint === null) ||
    (value.guestPolicySourceRevision === BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION) !==
      (blockers as BookingGuestPolicyReadinessBlocker[]).some(
        ({ code }) => code === "guest_policy_not_configured",
      ) ||
    (value.status === "ready" && currentBaseRevisions === null) ||
    (currentBaseRevisions !== null &&
      currentBaseRevisions["booking.guest_experience"] !== value.guestPolicySourceRevision) ||
    !statusMatchesBlockers(value.status, blockers as BookingGuestPolicyReadinessBlocker[])
  )
    return null;
  return deepFreeze({
    contractVersion: BOOKING_GUEST_POLICY_READINESS_CONTRACT_VERSION,
    organizationId: value.organizationId,
    propertyId: value.propertyId,
    status: value.status,
    guestPolicySourceRevision: value.guestPolicySourceRevision,
    sourceFingerprint: value.sourceFingerprint as BookingGuestPolicyHash | null,
    currentBaseRevisions,
    blockers: blockers as BookingGuestPolicyReadinessBlocker[],
  });
}

function ownerBaseRevisions(
  result: BookingGuestPolicyCurrentOwnerEvidenceResult,
  scope: Readonly<{ organizationId: string; propertyId: string }>,
  blockers: BookingGuestPolicyReadinessBlocker[],
): BookingGuestPolicyCurrentBaseRevisions | null {
  if (result.organizationId !== scope.organizationId || result.propertyId !== scope.propertyId) {
    blockers.push(blocker("current_owner_evidence_malformed", "provider_failure"));
    return null;
  }
  if (result.outcome === "unavailable") {
    if (result.failures.length === 0) {
      blockers.push(blocker("current_owner_evidence_malformed", "provider_failure"));
      return null;
    }
    for (const failure of result.failures) {
      blockers.push(
        blocker(
          failure.outcome === "missing"
            ? "current_owner_evidence_missing"
            : failure.outcome === "malformed"
              ? "current_owner_evidence_malformed"
              : "current_owner_evidence_unavailable",
          failure.outcome === "unavailable" ? "provider_failure" : "user_fixable",
          failure.owner,
        ),
      );
    }
    return null;
  }
  return parseCurrentBaseRevisions(result.currentBaseRevisions, blockers);
}

function parseCurrentBaseRevisions(
  value: unknown,
  blockers?: BookingGuestPolicyReadinessBlocker[],
): BookingGuestPolicyCurrentBaseRevisions | null {
  if (
    !exactDataRecord(value, BOOKING_GUEST_POLICY_CURRENT_BASE_REVISION_KEYS) ||
    !guestPolicyBaseRevision(value["booking.guest_experience"]) ||
    !BOOKING_GUEST_POLICY_CURRENT_BASE_REVISION_KEYS.slice(1).every((key) =>
      baseRevision(value[key]),
    )
  ) {
    blockers?.push(blocker("current_owner_evidence_malformed", "provider_failure"));
    return null;
  }
  return Object.freeze({
    "booking.guest_experience": value["booking.guest_experience"],
    "pms.pricing_settings": value["pms.pricing_settings"] as string,
    "pms.rate_plans": value["pms.rate_plans"] as string,
    "pms.room_types": value["pms.room_types"] as string,
    "hotel_catalog.location": value["hotel_catalog.location"] as string,
    "hotel_catalog.policy": value["hotel_catalog.policy"] as string,
  });
}

function parseReadinessBlocker(value: unknown): BookingGuestPolicyReadinessBlocker | null {
  if (!dataRecord(value)) return null;
  const optionalKeys = ["owner", "roomTypeId", "sourceId"].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (
    !exactDataRecord(value, ["code", "kind", ...optionalKeys]) ||
    !READINESS_BLOCKER_CODES.has(value.code as BookingGuestPolicyReadinessBlockerCode) ||
    (value.kind !== "user_fixable" &&
      value.kind !== "external_pending" &&
      value.kind !== "provider_failure") ||
    (Object.hasOwn(value, "owner") &&
      value.owner !== "booking" &&
      value.owner !== "pms" &&
      value.owner !== "hotel_catalog") ||
    (Object.hasOwn(value, "roomTypeId") && !canonicalUuid(value.roomTypeId)) ||
    (Object.hasOwn(value, "sourceId") && !canonicalUuid(value.sourceId))
  )
    return null;
  return Object.freeze({
    code: value.code as BookingGuestPolicyReadinessBlockerCode,
    kind: value.kind,
    ...(typeof value.owner === "string"
      ? { owner: value.owner as BookingGuestPolicyReadinessBlocker["owner"] }
      : {}),
    ...(typeof value.roomTypeId === "string" ? { roomTypeId: value.roomTypeId } : {}),
    ...(typeof value.sourceId === "string" ? { sourceId: value.sourceId } : {}),
  });
}

const READINESS_BLOCKER_CODES = new Set<BookingGuestPolicyReadinessBlockerCode>([
  "pricing_source_invalid",
  "pricing_source_missing",
  "pricing_currency_mismatch",
  "property_timezone_missing",
  "property_timezone_invalid",
  "property_profile_unavailable",
  "property_profile_malformed",
  "room_capacity_missing",
  "room_capacity_invalid",
  "child_policy_capacity_incompatible",
  "mandatory_charge_confirmation_missing",
  "mandatory_charge_confirmation_unavailable",
  "mandatory_charge_confirmation_malformed",
  "mandatory_charge_confirmation_stale",
  "flexible_rate_policy_missing",
  "optional_rate_policy_invalid",
  "guest_policy_not_configured",
  "guest_policy_source_stale",
  "current_owner_evidence_missing",
  "current_owner_evidence_malformed",
  "current_owner_evidence_unavailable",
  "catalog_projection_pending",
  "catalog_projection_conflict",
  "catalog_projection_stale",
]);

function statusMatchesBlockers(
  status: BookingGuestPolicyReadiness["status"],
  blockers: readonly BookingGuestPolicyReadinessBlocker[],
): boolean {
  if (status === "ready") return blockers.length === 0;
  if (status === "blocked") return blockers.some(({ kind }) => kind === "user_fixable");
  return blockers.length > 0 && !blockers.some(({ kind }) => kind === "user_fixable");
}

function catalogPolicyRevisionMatches(
  value: string,
  propertyId: string,
  revision: number,
): boolean {
  const match = /^hotel_catalog\.policy:([0-9a-f-]{36}):r([1-9][0-9]*)$/.exec(value);
  return (
    match?.[1] === propertyId && Number(match[2]) === revision && positiveRevision(Number(match[2]))
  );
}

function blocker(
  code: BookingGuestPolicyReadinessBlockerCode,
  kind: BookingGuestPolicyReadinessBlocker["kind"],
  owner?: BookingGuestPolicyReadinessBlocker["owner"],
): BookingGuestPolicyReadinessBlocker {
  return Object.freeze({ code, kind, ...(owner ? { owner } : {}) });
}

function parseScope(value: {
  organizationId: unknown;
  propertyId: unknown;
}): Readonly<{ organizationId: string; propertyId: string }> | null {
  return canonicalUuid(value.organizationId) && canonicalUuid(value.propertyId)
    ? Object.freeze({ organizationId: value.organizationId, propertyId: value.propertyId })
    : null;
}

function guestPolicyBaseRevision(
  value: unknown,
): value is BookingGuestPolicyCurrentSourceRevision["revision"] {
  if (value === BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION) return true;
  const match = typeof value === "string" ? /^guest-policy:([1-9][0-9]*)$/.exec(value) : null;
  return match !== null && positiveRevision(Number(match[1]));
}

function baseRevision(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}

function canonicalUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!dataRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  return (
    names.length === keys.length &&
    names.every((name) => keys.includes(name)) &&
    Object.values(descriptors).every(
      (descriptor) => "value" in descriptor && descriptor.enumerable === true,
    )
  );
}

function dataRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
