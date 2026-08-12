export const HOTEL_CATALOG_CURRENT_OWNER_KEYS = Object.freeze([
  "hotel_catalog.location",
  "hotel_catalog.policy",
] as const);

export const HOTEL_CATALOG_CURRENT_OWNER_REVISION_MAX = 2_147_483_647;

export type HotelCatalogCurrentOwnerKey = (typeof HOTEL_CATALOG_CURRENT_OWNER_KEYS)[number];

export type HotelCatalogCurrentOwnerEvidenceScope = Readonly<{
  organizationId: string;
  propertyId: string;
}>;

export type HotelCatalogCurrentOwnerSourceIdentity<Key extends HotelCatalogCurrentOwnerKey> =
  `${Key}:${string}`;

export type HotelCatalogCurrentOwnerBaseRevision<Key extends HotelCatalogCurrentOwnerKey> =
  `${HotelCatalogCurrentOwnerSourceIdentity<Key>}:r${number}`;

export type HotelCatalogCurrentOwnerEvidence<Key extends HotelCatalogCurrentOwnerKey> = Readonly<{
  organizationId: string;
  propertyId: string;
  ownerKey: Key;
  sourceIdentity: HotelCatalogCurrentOwnerSourceIdentity<Key>;
  revision: number;
  baseRevision: HotelCatalogCurrentOwnerBaseRevision<Key>;
}>;

export type HotelCatalogCurrentOwnerEvidenceResult<Key extends HotelCatalogCurrentOwnerKey> =
  | Readonly<{ outcome: "available"; evidence: HotelCatalogCurrentOwnerEvidence<Key> }>
  | Readonly<{ outcome: "missing"; reason: "property_scope" | "owner_state" }>
  | Readonly<{ outcome: "malformed" }>
  | Readonly<{ outcome: "unavailable"; errorSource: "provider" | "system" }>;

export type HotelCatalogLocationCurrentOwnerEvidenceResult =
  HotelCatalogCurrentOwnerEvidenceResult<"hotel_catalog.location">;

export type HotelCatalogPolicyCurrentOwnerEvidenceResult =
  HotelCatalogCurrentOwnerEvidenceResult<"hotel_catalog.policy">;

export interface HotelCatalogLocationCurrentOwnerEvidencePort {
  readonly ownerKey: "hotel_catalog.location";
  getCurrentLocationOwnerEvidence(
    scope: HotelCatalogCurrentOwnerEvidenceScope,
  ): Promise<HotelCatalogLocationCurrentOwnerEvidenceResult>;
}

export interface HotelCatalogPolicyCurrentOwnerEvidencePort {
  readonly ownerKey: "hotel_catalog.policy";
  getCurrentPolicyOwnerEvidence(
    scope: HotelCatalogCurrentOwnerEvidenceScope,
  ): Promise<HotelCatalogPolicyCurrentOwnerEvidenceResult>;
}

export function parseHotelCatalogCurrentOwnerEvidenceScope(
  value: unknown,
): HotelCatalogCurrentOwnerEvidenceScope | null {
  if (
    !exactDataRecord(value, ["organizationId", "propertyId"]) ||
    !uuid(value.organizationId) ||
    !uuid(value.propertyId)
  )
    return null;
  return Object.freeze({
    organizationId: value.organizationId.toLowerCase(),
    propertyId: value.propertyId.toLowerCase(),
  });
}

export function createHotelCatalogCurrentOwnerEvidence<Key extends HotelCatalogCurrentOwnerKey>(
  ownerKey: Key,
  scope: HotelCatalogCurrentOwnerEvidenceScope,
  revision: number,
): HotelCatalogCurrentOwnerEvidence<Key> | null {
  const parsedScope = parseHotelCatalogCurrentOwnerEvidenceScope(scope);
  if (!parsedScope || !boundedRevision(revision)) return null;
  const sourceIdentity = `${ownerKey}:${parsedScope.propertyId}` as const;
  return Object.freeze({
    ...parsedScope,
    ownerKey,
    sourceIdentity,
    revision,
    baseRevision: `${sourceIdentity}:r${revision}` as const,
  });
}

export function parseHotelCatalogLocationCurrentOwnerEvidenceResult(
  value: unknown,
  scope: HotelCatalogCurrentOwnerEvidenceScope,
): HotelCatalogLocationCurrentOwnerEvidenceResult | null {
  return parseResult(value, scope, "hotel_catalog.location");
}

export function parseHotelCatalogPolicyCurrentOwnerEvidenceResult(
  value: unknown,
  scope: HotelCatalogCurrentOwnerEvidenceScope,
): HotelCatalogPolicyCurrentOwnerEvidenceResult | null {
  return parseResult(value, scope, "hotel_catalog.policy");
}

function parseResult<Key extends HotelCatalogCurrentOwnerKey>(
  value: unknown,
  scope: HotelCatalogCurrentOwnerEvidenceScope,
  ownerKey: Key,
): HotelCatalogCurrentOwnerEvidenceResult<Key> | null {
  const parsedScope = parseHotelCatalogCurrentOwnerEvidenceScope(scope);
  if (!parsedScope || !dataRecord(value)) return null;
  if (value.outcome === "malformed") {
    return exactDataRecord(value, ["outcome"]) ? Object.freeze({ outcome: "malformed" }) : null;
  }
  if (value.outcome === "missing") {
    return exactDataRecord(value, ["outcome", "reason"]) &&
      (value.reason === "property_scope" || value.reason === "owner_state")
      ? Object.freeze({ outcome: "missing", reason: value.reason })
      : null;
  }
  if (value.outcome === "unavailable") {
    return exactDataRecord(value, ["outcome", "errorSource"]) &&
      (value.errorSource === "provider" || value.errorSource === "system")
      ? Object.freeze({ outcome: "unavailable", errorSource: value.errorSource })
      : null;
  }
  if (
    value.outcome !== "available" ||
    !exactDataRecord(value, ["outcome", "evidence"]) ||
    !exactDataRecord(value.evidence, [
      "organizationId",
      "propertyId",
      "ownerKey",
      "sourceIdentity",
      "revision",
      "baseRevision",
    ]) ||
    value.evidence.organizationId !== parsedScope.organizationId ||
    value.evidence.propertyId !== parsedScope.propertyId ||
    value.evidence.ownerKey !== ownerKey ||
    !boundedRevision(value.evidence.revision)
  )
    return null;
  const evidence = createHotelCatalogCurrentOwnerEvidence(
    ownerKey,
    parsedScope,
    value.evidence.revision,
  );
  if (
    !evidence ||
    value.evidence.sourceIdentity !== evidence.sourceIdentity ||
    value.evidence.baseRevision !== evidence.baseRevision
  )
    return null;
  return Object.freeze({ outcome: "available", evidence });
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!dataRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
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

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function boundedRevision(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= HOTEL_CATALOG_CURRENT_OWNER_REVISION_MAX
  );
}
