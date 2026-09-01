import { createHash } from "node:crypto";

import type { RequestAuditMetadata } from "@vayada/backend-auth";
import {
  PROPERTY_MEDIA_PUBLIC_VARIANTS,
  parseAssignPropertyLogoRequest,
  parsePropertyMediaCommandError,
  parsePropertyMediaCommandResponse,
  parseReplacePropertyPresentationMediaRequest,
  type AssignPropertyLogoRequest,
  type PropertyMediaAssignment,
  type PropertyMediaCommandError,
  type PropertyMediaCommandResponse,
  type ReplacePropertyPresentationMediaRequest,
} from "@vayada/domain-hotels";

import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";

export type BaseCommand = {
  organizationId: string;
  propertyId: string;
  idempotencyKey: string;
  actorUserId: string;
  audit: RequestAuditMetadata;
};

export type AssignPropertyLogoCommand = BaseCommand & AssignPropertyLogoRequest;
export type ReplacePropertyPresentationMediaCommand = BaseCommand &
  ReplacePropertyPresentationMediaRequest;
export type ReplacePlatformAdminPropertyHeroCommand = Omit<BaseCommand, "organizationId"> & {
  expectedProfileRevision: number;
  mediaObjectId: string | null;
};

export type PropertyMediaCommandResult =
  | { ok: true; response: PropertyMediaCommandResponse }
  | { ok: false; error: PropertyMediaCommandError | { code: "property_not_found" } };

export type Operation = "logo" | "presentation";
export type InternalCommand = BaseCommand & {
  operation: Operation;
  expectedProfileRevision: number;
  assignments: readonly PropertyMediaAssignment[];
  platformAdminHero?: true;
};
export type PublicationCommand = Omit<InternalCommand, "idempotencyKey">;

export type PropertyRow = { profileRevision: string | number };
export type PlatformAdminPropertyRow = PropertyRow & { ownerOrganizationId: string };
export type AssignmentRow = {
  mediaObjectId: string;
  mediaType: "hero_image" | "gallery_image" | "logo";
  altText: string | null;
  sortOrder: number;
};
export const MEDIA_TYPE_BY_ROLE: Record<
  PropertyMediaAssignment["role"],
  AssignmentRow["mediaType"]
> = {
  logo: "logo",
  cover: "hero_image",
  gallery: "gallery_image",
};
export const ROLE_BY_MEDIA_TYPE: Record<
  AssignmentRow["mediaType"],
  PropertyMediaAssignment["role"]
> = {
  logo: "logo",
  hero_image: "cover",
  gallery_image: "gallery",
};
export type MediaRow = {
  mediaObjectId: string;
  bucket: string | null;
  storageKey: string | null;
  storageKind: string;
  visibility: string;
  purpose: string;
  ownerOrganizationId: string | null;
  propertyId: string | null;
  lifecycleStatus: string;
  publicApproved: boolean;
  contentType: unknown;
  widthPx: unknown;
  heightPx: unknown;
  sizeBytes: unknown;
  checksumSha256: unknown;
  variants: unknown;
};
export type VariantRow = {
  variantName: string;
  visibility: string;
  storageKey: string;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  sizeBytes: number;
  checksumSha256: string | null;
  publicUrl: string | null;
};
export type ReadyMedia = {
  mediaObjectId: string;
  originalSafeUrl: string;
  promotion: readonly {
    variantName: string;
    privateStorageKey: string;
    publicStorageKey: string;
    publicUrl: string;
    contentType: string;
  }[];
};
export type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  metadata: unknown;
};

export type PublicationJobPayload = {
  version: 2;
  command: PublicationCommand;
  idempotencyId: string;
  keyHash: string;
  requestFingerprintHash: string;
  publicationToken: string;
  acceptedProfileRevision: number;
  acceptedAt: string;
  before: AssignmentRow[];
  media: ReadyMedia[];
};

export type PublicationJobRow = {
  id: string;
  jobKey: string;
  status: string;
  attemptsCount: number;
  maxAttempts: number;
  lockedAt: unknown;
  lockedBy: string | null;
  propertyId: string | null;
  keyHash: string | null;
  tenantScope: string;
  resourceProduct: string;
  resourceType: string;
  resourceId: string;
  cleanupRequired: boolean;
  cleanupKeys: unknown;
  payload: unknown;
};

export type PublicationClaim = {
  jobId: string;
  workerId: string;
  attemptsCount: number;
  maxAttempts: number;
  exhaustedBeforeClaim: boolean;
  cleanupRequired: boolean;
  payload: PublicationJobPayload;
};

export type InvalidPublicationJob = {
  jobId: string;
  workerId: string;
  force: boolean;
  reason: "invalid_envelope" | "missing_idempotency_fence";
  cleanupKeys: string[];
};

export type InvalidPublicationRecoveryRow = {
  propertyId: string;
  keyHash: string | null;
  correlationId: string | null;
  jobKey: string;
  status: string;
  attemptsCount: number;
  maxAttempts: number;
  tenantScope: string;
  resourceProduct: string;
  resourceType: string;
  resourceId: string;
  cleanupKeys: unknown;
  payload: unknown;
};

export type PropertyMediaPublicationBatchResult = {
  processed: number;
  deferred: number;
  deadLettered: number;
};

export const OPERATIONS = {
  logo: "hotel_catalog.property_media.logo.assign",
  presentation: "hotel_catalog.property_media.presentation.replace",
} as const;
export const PUBLICATION_JOB_MAX_ATTEMPTS = 8;
export const PUBLICATION_JOB_LEASE_MS = 15 * 60_000;
export const PUBLICATION_JOB_RETRY_MS = 30_000;
export const PUBLICATION_JOB_MAX_RETRY_MS = 15 * 60_000;
export const PUBLICATION_TERMINAL_RECONCILIATION_MS = 60_000;
export const PUBLICATION_TERMINAL_RECONCILIATION_PASSES = 3;
export const PUBLICATION_COPY_CONCURRENCY = 8;
export const DEFAULT_PUBLICATION_BATCH_LIMIT = 10;

export function publicationRetryDelayMs(claim: PublicationClaim): number {
  const exponentialDelay = Math.min(
    PUBLICATION_JOB_MAX_RETRY_MS,
    PUBLICATION_JOB_RETRY_MS * 2 ** Math.max(0, claim.attemptsCount - 1),
  );
  const jitterBucket = Number.parseInt(
    sha256(`${claim.jobId}:${claim.attemptsCount}`).slice(0, 8),
    16,
  );
  const jitter = 0.5 + (jitterBucket / 0xffffffff) * 0.5;
  return Math.max(1, Math.round(exponentialDelay * jitter));
}

export function preparePublicationMedia(
  media: readonly ReadyMedia[],
  publicationToken: string,
  serving: PlatformMediaServingConfig,
): ReadyMedia[] {
  return media.map((item) => {
    if (item.promotion.length === 0) return item;
    const promotion = item.promotion.map((variant) => {
      const publicStorageKey = `public/${serving.publicPathPrefix}/${item.mediaObjectId}/${variant.variantName}/publication-${publicationToken}.webp`;
      return {
        ...variant,
        publicStorageKey,
        publicUrl: new URL(
          publicStorageKey.slice("public/".length),
          `${serving.cdnBaseUrl}/`,
        ).toString(),
      };
    });
    const originalSafe = promotion.find(({ variantName }) => variantName === "original_safe");
    if (!originalSafe) throw new Error("Property media publication has no original-safe variant");
    return { ...item, originalSafeUrl: originalSafe.publicUrl, promotion };
  });
}

export function assignmentResponse(
  outcome: PropertyMediaCommandResponse["outcome"],
  profileRevision: number,
  rows: readonly AssignmentRow[],
): PropertyMediaCommandResponse {
  const assignments = rows.map((row) => ({
    mediaObjectId: row.mediaObjectId,
    role: ROLE_BY_MEDIA_TYPE[row.mediaType],
    altText: row.altText,
    sortOrder: row.sortOrder,
  })) as PropertyMediaAssignment[];
  const logo = assignments.find(({ role }) => role === "logo") ?? null;
  const response: PropertyMediaCommandResponse = {
    outcome,
    profileRevision,
    logoAssignment: logo as PropertyMediaCommandResponse["logoAssignment"],
    presentationAssignments: assignments.filter(
      ({ role }) => role !== "logo",
    ) as PropertyMediaCommandResponse["presentationAssignments"],
  };
  const parsed = parsePropertyMediaCommandResponse(response);
  if (!parsed) throw new Error("Persisted property media assignments violate the contract");
  return parsed;
}

export function commandAssignmentResponse(
  outcome: PropertyMediaCommandResponse["outcome"],
  profileRevision: number,
  rows: readonly AssignmentRow[],
  command: Pick<PublicationCommand, "platformAdminHero">,
): PropertyMediaCommandResponse {
  if (!command.platformAdminHero) return assignmentResponse(outcome, profileRevision, rows);

  const logo = rows.filter(({ mediaType }) => mediaType === "logo");
  const cover = rows.filter(({ mediaType }) => mediaType === "hero_image");
  const gallery = rows
    .filter(({ mediaType }) => mediaType === "gallery_image")
    .map((row, index) => ({ ...row, sortOrder: cover.length + index }));
  return assignmentResponse(outcome, profileRevision, [...logo, ...cover, ...gallery]);
}

export function parseStoredResult(value: unknown): PropertyMediaCommandResult | null {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return null;
  if (value["ok"] === true) {
    const response = parsePropertyMediaCommandResponse(value["response"]);
    return response ? { ok: true, response } : null;
  }
  const error = parsePropertyMediaCommandError(value["error"]);
  return error ? { ok: false, error } : null;
}

export function propertyMediaCommandResultStatus(result: PropertyMediaCommandResult): number {
  if (result.ok) return 200;
  if (result.error.code === "media_not_found" || result.error.code === "property_not_found")
    return 404;
  if (result.error.code === "media_not_authorized") return 403;
  if (result.error.code === "media_not_ready") return 422;
  if (result.error.code === "media_publication_failed") return 503;
  return 409;
}

export function mediaFailure(
  code: "media_not_found" | "media_not_authorized" | "media_not_ready",
  mediaObjectIds: string[],
) {
  return { ok: false as const, error: { code, mediaObjectIds } };
}

export function snapshotCommand(input: InternalCommand): InternalCommand {
  if (!isRecord(input)) throw new Error("Property media command must be plain data");
  const operation = input["operation"];
  const organizationId = input["organizationId"];
  const propertyId = input["propertyId"];
  const actorUserId = input["actorUserId"];
  const idempotencyKey = input["idempotencyKey"];
  const auditValue = input["audit"];
  const platformAdminHero = input["platformAdminHero"];
  if (
    (operation !== "logo" && operation !== "presentation") ||
    !isUuid(organizationId) ||
    !isUuid(propertyId) ||
    !isUuid(actorUserId) ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 200 ||
    !isRecord(auditValue) ||
    (platformAdminHero !== undefined && platformAdminHero !== true) ||
    (platformAdminHero === true && operation !== "presentation")
  ) {
    throw new Error("Property media command contains invalid scope data");
  }
  const requestId = auditValue["requestId"];
  const correlationId = auditValue["correlationId"];
  const source = auditValue["source"];
  const sourceIp = auditValue["sourceIp"];
  const userAgent = auditValue["userAgent"];
  const receivedAt = auditValue["receivedAt"];
  if (
    typeof requestId !== "string" ||
    !requestId ||
    (correlationId !== undefined && typeof correlationId !== "string") ||
    !["web", "admin", "api", "agent", "migration"].includes(String(source)) ||
    (sourceIp !== undefined && typeof sourceIp !== "string") ||
    (userAgent !== undefined && typeof userAgent !== "string") ||
    typeof receivedAt !== "string" ||
    !Number.isFinite(Date.parse(receivedAt))
  ) {
    throw new Error("Property media command contains invalid audit data");
  }
  const audit: RequestAuditMetadata = {
    requestId,
    ...(correlationId === undefined ? {} : { correlationId }),
    source: source as RequestAuditMetadata["source"],
    ...(sourceIp === undefined ? {} : { sourceIp }),
    ...(userAgent === undefined ? {} : { userAgent }),
    receivedAt,
  };
  const expectedProfileRevision = input["expectedProfileRevision"];
  const assignments = input["assignments"];
  let parsedRevision: number;
  let parsedAssignments: PropertyMediaAssignment[];
  if (operation === "logo") {
    if (!Array.isArray(assignments) || assignments.length > 1) {
      throw new Error("Property media command violates its request contract");
    }
    const parsed = parseAssignPropertyLogoRequest({
      expectedProfileRevision,
      assignment: assignments.length === 1 ? assignments[0] : null,
    });
    if (!parsed) throw new Error("Property media command violates its request contract");
    parsedRevision = parsed.expectedProfileRevision;
    parsedAssignments = parsed.assignment ? [{ ...parsed.assignment }] : [];
  } else {
    const parsed = parseReplacePropertyPresentationMediaRequest({
      expectedProfileRevision,
      assignments,
    });
    if (!parsed) throw new Error("Property media command violates its request contract");
    parsedRevision = parsed.expectedProfileRevision;
    parsedAssignments = parsed.assignments.map((assignment) => ({ ...assignment }));
  }
  return {
    operation,
    organizationId: organizationId.toLowerCase(),
    propertyId: propertyId.toLowerCase(),
    actorUserId: actorUserId.toLowerCase(),
    idempotencyKey,
    audit,
    expectedProfileRevision: parsedRevision,
    assignments: parsedAssignments,
    ...(platformAdminHero === true ? { platformAdminHero: true as const } : {}),
  };
}

export function snapshotPlatformAdminHeroCommand(
  input: ReplacePlatformAdminPropertyHeroCommand,
): ReplacePlatformAdminPropertyHeroCommand {
  const normalized = snapshotCommand({
    ...input,
    organizationId: "00000000-0000-4000-8000-000000000000",
    operation: "presentation",
    assignments: input.mediaObjectId
      ? [{ mediaObjectId: input.mediaObjectId, role: "cover", altText: null, sortOrder: 0 }]
      : [],
    platformAdminHero: true,
  });
  return {
    propertyId: normalized.propertyId,
    actorUserId: normalized.actorUserId,
    idempotencyKey: normalized.idempotencyKey,
    audit: normalized.audit,
    expectedProfileRevision: normalized.expectedProfileRevision,
    mediaObjectId: normalized.assignments[0]?.mediaObjectId ?? null,
  };
}

export function commandWithoutIdempotencyKey(command: InternalCommand): PublicationCommand {
  return {
    operation: command.operation,
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    actorUserId: command.actorUserId,
    audit: { ...command.audit },
    expectedProfileRevision: command.expectedProfileRevision,
    assignments: command.assignments.map((assignment) => ({ ...assignment })),
    ...(command.platformAdminHero ? { platformAdminHero: true as const } : {}),
  };
}

export function commandFingerprint(command: PublicationCommand): string {
  return sha256(
    canonicalJson({
      organizationId: command.organizationId,
      propertyId: command.propertyId,
      operation: command.operation,
      expectedProfileRevision: command.expectedProfileRevision,
      assignments: command.assignments,
      ...(command.platformAdminHero ? { platformAdminHero: true } : {}),
    }),
  );
}

export function publicationJobRowMatchesPayload(
  row: PublicationJobRow,
  payload: PublicationJobPayload,
): boolean {
  const cleanupKeys = parsePublicationCleanupKeys(row.cleanupKeys);
  return (
    row.tenantScope === "property" &&
    row.propertyId === payload.command.propertyId &&
    row.resourceProduct === "hotel_catalog" &&
    row.resourceType === "property_media_assignment" &&
    row.resourceId === payload.command.propertyId &&
    row.keyHash === payload.keyHash &&
    cleanupKeys !== null &&
    canonicalJson(cleanupKeys) === canonicalJson(publicationCleanupKeys(payload.media)) &&
    row.jobKey ===
      `${payload.command.propertyId}:${OPERATIONS[payload.command.operation]}:${payload.keyHash}`
  );
}

export function publicationCleanupKeys(media: readonly ReadyMedia[]): string[] {
  return [
    ...new Set(
      media.flatMap(({ promotion }) => promotion.map(({ publicStorageKey }) => publicStorageKey)),
    ),
  ].sort();
}

export function parsePublicationCleanupKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_048) return null;
  const keys = value.filter((item): item is string => typeof item === "string");
  if (keys.length !== value.length || new Set(keys).size !== keys.length) return null;
  for (const key of keys) {
    const segments = key.split("/");
    const filename = segments.at(-1);
    const variantName = segments.at(-2);
    const mediaObjectId = segments.at(-3);
    const prefix = segments.slice(1, -3);
    const publicationToken = filename?.match(/^publication-([0-9a-f-]+)\.webp$/)?.[1];
    if (
      segments[0] !== "public" ||
      prefix.length === 0 ||
      prefix.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) ||
      !isUuid(mediaObjectId) ||
      !PROPERTY_MEDIA_PUBLIC_VARIANTS.includes(variantName as never) ||
      !isUuid(publicationToken) ||
      publicationToken !== publicationToken.toLowerCase()
    ) {
      return null;
    }
  }
  return [...keys].sort();
}

export function publicationRecoveryRowMatchesPayload(
  row: InvalidPublicationRecoveryRow,
  payload: PublicationJobPayload,
): boolean {
  const cleanupKeys = parsePublicationCleanupKeys(row.cleanupKeys);
  return (
    row.tenantScope === "property" &&
    row.propertyId === payload.command.propertyId &&
    row.resourceProduct === "hotel_catalog" &&
    row.resourceType === "property_media_assignment" &&
    row.resourceId === payload.command.propertyId &&
    row.keyHash === payload.keyHash &&
    cleanupKeys !== null &&
    canonicalJson(cleanupKeys) === canonicalJson(publicationCleanupKeys(payload.media)) &&
    row.jobKey ===
      `${payload.command.propertyId}:${OPERATIONS[payload.command.operation]}:${payload.keyHash}`
  );
}

export function parsePublicationJobPayload(value: unknown): PublicationJobPayload | null {
  if (!isRecord(value) || value["version"] !== 2 || !isRecord(value["command"])) return null;
  const commandValue = value["command"];
  const operation = commandValue["operation"];
  const assignments = commandValue["assignments"];
  let command: InternalCommand;
  try {
    command = snapshotCommand({
      ...commandValue,
      operation,
      assignments,
      idempotencyKey: "persisted-publication-job",
    } as InternalCommand);
  } catch {
    return null;
  }
  const idempotencyId = value["idempotencyId"];
  const keyHash = value["keyHash"];
  const requestFingerprintHash = value["requestFingerprintHash"];
  const publicationToken = value["publicationToken"];
  const acceptedProfileRevision = value["acceptedProfileRevision"];
  const acceptedAt = value["acceptedAt"];
  const beforeValue = value["before"];
  const mediaValue = value["media"];
  if (
    !isUuid(idempotencyId) ||
    !isSha256(keyHash) ||
    !isSha256(requestFingerprintHash) ||
    requestFingerprintHash !== commandFingerprint(command) ||
    !isUuid(publicationToken) ||
    !Number.isSafeInteger(acceptedProfileRevision) ||
    (acceptedProfileRevision as number) !== command.expectedProfileRevision + 1 ||
    typeof acceptedAt !== "string" ||
    !Number.isFinite(Date.parse(acceptedAt)) ||
    !Array.isArray(beforeValue) ||
    !Array.isArray(mediaValue)
  ) {
    return null;
  }
  const before = beforeValue.map(parseAssignmentRow);
  const media = mediaValue.map((item) => parseReadyMedia(item, publicationToken));
  if (before.some((row) => !row) || media.some((item) => !item)) return null;
  const requestedIds = new Set(command.assignments.map(({ mediaObjectId }) => mediaObjectId));
  if (
    media.length !== requestedIds.size ||
    media.some((item) => !requestedIds.has(item!.mediaObjectId))
  ) {
    return null;
  }
  return {
    version: 2,
    command: commandWithoutIdempotencyKey(command),
    idempotencyId: idempotencyId.toLowerCase(),
    keyHash,
    requestFingerprintHash,
    publicationToken: publicationToken.toLowerCase(),
    acceptedProfileRevision: acceptedProfileRevision as number,
    acceptedAt,
    before: before as AssignmentRow[],
    media: media as ReadyMedia[],
  };
}

export function parseAssignmentRow(value: unknown): AssignmentRow | null {
  if (!isRecord(value)) return null;
  const mediaObjectId = value["mediaObjectId"];
  const mediaType = value["mediaType"];
  const altText = value["altText"];
  const sortOrder = value["sortOrder"];
  return isUuid(mediaObjectId) &&
    ["hero_image", "gallery_image", "logo"].includes(String(mediaType)) &&
    (typeof altText === "string" || altText === null) &&
    Number.isSafeInteger(sortOrder) &&
    (sortOrder as number) >= 0
    ? {
        mediaObjectId: mediaObjectId.toLowerCase(),
        mediaType: mediaType as AssignmentRow["mediaType"],
        altText,
        sortOrder: sortOrder as number,
      }
    : null;
}

export function parseReadyMedia(value: unknown, publicationToken: string): ReadyMedia | null {
  if (!isRecord(value)) return null;
  const mediaObjectId = value["mediaObjectId"];
  const originalSafeUrl = value["originalSafeUrl"];
  const promotionValue = value["promotion"];
  if (!isUuid(mediaObjectId) || !isHttpsUrl(originalSafeUrl) || !Array.isArray(promotionValue)) {
    return null;
  }
  const promotion = promotionValue.map((variant) => {
    if (!isRecord(variant)) return null;
    const variantName = variant["variantName"];
    const privateStorageKey = variant["privateStorageKey"];
    const publicStorageKey = variant["publicStorageKey"];
    const publicUrl = variant["publicUrl"];
    const contentType = variant["contentType"];
    return PROPERTY_MEDIA_PUBLIC_VARIANTS.includes(variantName as never) &&
      typeof privateStorageKey === "string" &&
      privateStorageKey.startsWith("private/") &&
      typeof publicStorageKey === "string" &&
      publicStorageKey.startsWith("public/") &&
      publicStorageKey.endsWith(`/publication-${publicationToken.toLowerCase()}.webp`) &&
      isHttpsUrl(publicUrl) &&
      new URL(publicUrl).pathname.replace(/^\/+/, "") ===
        publicStorageKey.slice("public/".length) &&
      contentType === "image/webp"
      ? { variantName, privateStorageKey, publicStorageKey, publicUrl, contentType }
      : null;
  });
  if (
    promotion.some((variant) => !variant) ||
    (promotion.length !== 0 &&
      (promotion.length !== PROPERTY_MEDIA_PUBLIC_VARIANTS.length ||
        new Set(promotion.map((variant) => variant!.variantName)).size !== promotion.length))
  ) {
    return null;
  }
  const originalSafe = promotion.find((variant) => variant?.variantName === "original_safe");
  if (promotion.length > 0 && originalSafe?.publicUrl !== originalSafeUrl) return null;
  return {
    mediaObjectId: mediaObjectId.toLowerCase(),
    originalSafeUrl,
    promotion: promotion as ReadyMedia["promotion"],
  };
}

export function pendingPublicationJobId(metadata: unknown): string | null {
  if (!isRecord(metadata) || !isRecord(metadata["publication"])) return null;
  const jobId = metadata["publication"]["jobId"];
  return isUuid(jobId) ? jobId.toLowerCase() : null;
}

export function safeFailureMessage(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return (normalized || "Property media publication failed").slice(0, 500);
}

export function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  return value === undefined
    ? fallback
    : Number.isSafeInteger(value) && value > 0 && value <= max
      ? value
      : fallback;
}

export function positiveInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new Error("Property profile revision is invalid");
  }
  return parsed;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Canonical JSON cannot encode this value");
  return serialized;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}
