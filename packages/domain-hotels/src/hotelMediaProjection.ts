import {
  PROPERTY_MEDIA_MAX_ALT_TEXT_LENGTH,
  parseAssignPropertyLogoRequest,
  parsePropertyMediaLibraryItem,
  parseReplacePropertyPresentationMediaRequest,
  type PropertyMediaAssignment,
  type PropertyMediaCommandError,
  type PropertyMediaPublicVariant,
  type PropertyMediaUploadPurpose,
} from "./propertyMedia.js";

declare const resolvedPublicHotelMediaBrand: unique symbol;
declare const resolvedHotelMediaBatchBrand: unique symbol;
const propertyMediaProjectionBrand: unique symbol = Symbol("propertyMediaProjection");
const roomMediaProjectionBrand: unique symbol = Symbol("roomMediaProjection");
const trustedResolutionBatches = new WeakSet<object>();
const ROOM_MEDIA_PROJECTION_MAX_ITEMS = 20;

export type ResolvedPublicHotelMedia = {
  readonly [resolvedPublicHotelMediaBrand]: true;
  readonly mediaObjectId: string;
  readonly ownerOrganizationId: string;
  readonly propertyId: string;
  readonly purpose: PropertyMediaUploadPurpose;
  readonly publicVariants: readonly [
    Readonly<PropertyMediaPublicVariant>,
    ...Readonly<PropertyMediaPublicVariant>[],
  ];
};

export type HotelMediaResolutionTarget =
  | { readonly kind: "property"; readonly propertyId: string }
  | {
      readonly kind: "room_type";
      readonly propertyId: string;
      readonly roomTypeId: string;
    };

export type ResolvedHotelMediaBatch<
  Target extends HotelMediaResolutionTarget = HotelMediaResolutionTarget,
> = {
  readonly [resolvedHotelMediaBatchBrand]: true;
  readonly ownerOrganizationId: string;
  readonly target: Target;
  readonly media: readonly ResolvedPublicHotelMedia[];
};

export type ResolvedPropertyMediaBatch = ResolvedHotelMediaBatch<
  Extract<HotelMediaResolutionTarget, { kind: "property" }>
>;

export type ResolvedRoomMediaBatch = ResolvedHotelMediaBatch<
  Extract<HotelMediaResolutionTarget, { kind: "room_type" }>
>;

export type PublicHotelMediaResolutionSnapshot = {
  readonly mediaObjectId: string;
  readonly ownerOrganizationId: string;
  readonly propertyId: string;
  readonly purpose: PropertyMediaUploadPurpose;
  readonly publicVariants: readonly Readonly<PropertyMediaPublicVariant>[];
};

type MediaResolutionError = Extract<PropertyMediaCommandError, { mediaObjectIds: string[] }>;
type MediaResolutionResult =
  | {
      ok: true;
      resolvedTarget: HotelMediaResolutionTarget;
      media: readonly PublicHotelMediaResolutionSnapshot[];
    }
  | { ok: false; error: MediaResolutionError };

/**
 * Implemented only by the trusted Platform Media adapter. Its persistent query
 * must validate managed/public/approved/active non-staging image variants,
 * ownership, and the configured CDN. Room queries must bind roomTypeId to
 * propertyId and ownerOrganizationId in the same lookup.
 */
export type HotelMediaResolutionAdapter = {
  loadPublicMedia(input: {
    ownerOrganizationId: string;
    target: HotelMediaResolutionTarget;
    mediaObjectIds: readonly string[];
  }): Promise<MediaResolutionResult>;
};

export type HotelMediaResolutionPort = {
  resolvePublicMedia(input: {
    ownerOrganizationId: string;
    target: HotelMediaResolutionTarget;
    mediaObjectIds: readonly string[];
  }): Promise<
    { ok: true; batch: ResolvedHotelMediaBatch } | { ok: false; error: MediaResolutionError }
  >;
};

/**
 * Creates the only runtime path that can register an opaque resolution batch.
 * The wrapper validates scope/cardinality and copies plain snapshots so later
 * caller mutation cannot change a projection input.
 */
export function createHotelMediaResolutionPort(
  adapter: HotelMediaResolutionAdapter,
): HotelMediaResolutionPort {
  return {
    async resolvePublicMedia(input) {
      const request = snapshotResolutionRequest(input);
      if (!request) return unauthorized(input.mediaObjectIds);
      const loaded = await adapter.loadPublicMedia(request);
      if (!loaded.ok) return snapshotResolutionError(loaded.error, request.mediaObjectIds);
      const batch = createTrustedResolutionBatch(request, loaded);
      return batch ? { ok: true, batch } : unauthorized(request.mediaObjectIds);
    },
  };
}

export type PropertyMediaProjectionAssignmentDraft = {
  readonly mediaObjectId: string;
  readonly role: PropertyMediaAssignment["role"];
  readonly altText: string | null;
  readonly sortOrder: number;
};

export type ResolvedPropertyMediaAssignment = {
  readonly media: ResolvedPublicHotelMedia;
  readonly role: PropertyMediaAssignment["role"];
  readonly altText: string | null;
  readonly sortOrder: number;
};

export type PropertyMediaProjectionDraft = {
  readonly resolvedMedia: ResolvedPropertyMediaBatch;
  readonly profileRevision: number;
  readonly logoAssignment:
    | (PropertyMediaProjectionAssignmentDraft & { readonly role: "logo"; readonly sortOrder: 0 })
    | null;
  readonly presentationAssignments: readonly (PropertyMediaProjectionAssignmentDraft & {
    readonly role: "cover" | "gallery";
  })[];
};

export type PropertyMediaProjectionInput = {
  readonly [propertyMediaProjectionBrand]: true;
  readonly ownerOrganizationId: string;
  readonly propertyId: string;
  readonly profileRevision: number;
  readonly logoAssignment:
    | (ResolvedPropertyMediaAssignment & { readonly role: "logo"; readonly sortOrder: 0 })
    | null;
  readonly presentationAssignments: readonly (ResolvedPropertyMediaAssignment & {
    readonly role: "cover" | "gallery";
  })[];
};

export type MarketplaceHotelMediaProjectionInput = PropertyMediaProjectionInput;
export type BookingHotelMediaProjectionInput = PropertyMediaProjectionInput;

export type RoomMediaProjectionDraft = {
  readonly resolvedMedia: ResolvedRoomMediaBatch;
  readonly roomMediaRevision: number;
  readonly assignments: readonly {
    readonly mediaObjectId: string;
    readonly altText: string | null;
    readonly sortOrder: number;
  }[];
};

export type RoomMediaProjectionInput = {
  readonly [roomMediaProjectionBrand]: true;
  readonly ownerOrganizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomMediaRevision: number;
  readonly assignments: readonly {
    readonly media: ResolvedPublicHotelMedia;
    readonly altText: string | null;
    readonly sortOrder: number;
  }[];
};

export function createPropertyMediaProjectionInput(
  draft: PropertyMediaProjectionDraft,
): PropertyMediaProjectionInput | null {
  const batch = draft.resolvedMedia;
  const profileRevision = draft.profileRevision;
  const logoDraft = draft.logoAssignment;
  const presentationDraft = draft.presentationAssignments;
  if (!isTrustedBatch(batch) || batch.target.kind !== "property") return null;
  const logo = parseAssignPropertyLogoRequest({
    expectedProfileRevision: profileRevision,
    assignment: logoDraft,
  });
  const presentation = parseReplacePropertyPresentationMediaRequest({
    expectedProfileRevision: profileRevision,
    assignments: presentationDraft,
  });
  if (!logo || !presentation) return null;
  const mediaById = new Map(batch.media.map((media) => [media.mediaObjectId, media]));
  const logoAssignment = logo.assignment
    ? resolvePropertyAssignment(logo.assignment, mediaById)
    : null;
  const presentationAssignments = presentation.assignments.map((assignment) =>
    resolvePropertyAssignment(assignment, mediaById),
  );
  if ((logo.assignment && !logoAssignment) || presentationAssignments.some((item) => !item)) {
    return null;
  }
  return Object.freeze({
    ownerOrganizationId: batch.ownerOrganizationId,
    propertyId: batch.target.propertyId,
    profileRevision,
    logoAssignment,
    presentationAssignments: Object.freeze(
      presentationAssignments as ResolvedPropertyMediaAssignment[],
    ),
    [propertyMediaProjectionBrand]: true,
  }) as PropertyMediaProjectionInput;
}

export function createRoomMediaProjectionInput(
  draft: RoomMediaProjectionDraft,
): RoomMediaProjectionInput | null {
  const batch = draft.resolvedMedia;
  const roomMediaRevision = draft.roomMediaRevision;
  const assignmentDrafts = draft.assignments;
  if (
    !isTrustedBatch(batch) ||
    batch.target.kind !== "room_type" ||
    !isPositiveRevision(roomMediaRevision) ||
    !Array.isArray(assignmentDrafts) ||
    assignmentDrafts.length > ROOM_MEDIA_PROJECTION_MAX_ITEMS
  ) {
    return null;
  }
  const mediaById = new Map(batch.media.map((media) => [media.mediaObjectId, media]));
  const seen = new Set<string>();
  const assignments = assignmentDrafts.map((assignment, index) => {
    if (!isExactDataRecord(assignment, ["mediaObjectId", "altText", "sortOrder"])) return null;
    const mediaObjectId = normalizeUuid(assignment.mediaObjectId);
    if (
      !mediaObjectId ||
      seen.has(mediaObjectId) ||
      assignment.sortOrder !== index ||
      !isValidAltText(assignment.altText)
    ) {
      return null;
    }
    seen.add(mediaObjectId);
    const media = mediaById.get(mediaObjectId);
    return media
      ? Object.freeze({
          media,
          altText: assignment.altText,
          sortOrder: assignment.sortOrder,
        })
      : null;
  });
  if (assignments.some((assignment) => !assignment)) return null;
  return Object.freeze({
    ownerOrganizationId: batch.ownerOrganizationId,
    propertyId: batch.target.propertyId,
    roomTypeId: batch.target.roomTypeId,
    roomMediaRevision,
    assignments: Object.freeze(assignments as RoomMediaProjectionInput["assignments"]),
    [roomMediaProjectionBrand]: true,
  }) as RoomMediaProjectionInput;
}

function createTrustedResolutionBatch(
  request: {
    ownerOrganizationId: string;
    target: HotelMediaResolutionTarget;
    mediaObjectIds: readonly string[];
  },
  loaded: Extract<MediaResolutionResult, { ok: true }>,
): ResolvedHotelMediaBatch | null {
  const loadedTarget = loaded.resolvedTarget;
  const loadedMedia = loaded.media;
  const resolvedTarget = snapshotTarget(loadedTarget);
  if (!resolvedTarget || !sameTarget(request.target, resolvedTarget)) return null;
  if (!Array.isArray(loadedMedia) || loadedMedia.length !== request.mediaObjectIds.length) {
    return null;
  }
  const requestedIds = new Set(request.mediaObjectIds);
  const media = loadedMedia.map((item) => snapshotResolvedMedia(item, request));
  if (
    media.some((item) => !item || !requestedIds.has(item.mediaObjectId)) ||
    new Set(media.map((item) => item?.mediaObjectId)).size !== request.mediaObjectIds.length
  ) {
    return null;
  }
  const batch = Object.freeze({
    ownerOrganizationId: request.ownerOrganizationId,
    target: resolvedTarget,
    media: Object.freeze(media as ResolvedPublicHotelMedia[]),
  }) as ResolvedHotelMediaBatch;
  trustedResolutionBatches.add(batch);
  return batch;
}

function snapshotResolvedMedia(
  value: PublicHotelMediaResolutionSnapshot,
  request: { ownerOrganizationId: string; target: HotelMediaResolutionTarget },
): ResolvedPublicHotelMedia | null {
  if (
    !isExactDataRecord(value, [
      "mediaObjectId",
      "ownerOrganizationId",
      "propertyId",
      "purpose",
      "publicVariants",
    ]) ||
    value.ownerOrganizationId !== request.ownerOrganizationId ||
    value.propertyId !== request.target.propertyId ||
    !Array.isArray(value.publicVariants)
  ) {
    return null;
  }
  const parsed = parsePropertyMediaLibraryItem({
    mediaObjectId: value.mediaObjectId,
    purpose: value.purpose,
    status: "public_ready",
    publicVariants: value.publicVariants,
  });
  if (!parsed || parsed.publicVariants.length === 0) return null;
  return Object.freeze({
    mediaObjectId: parsed.mediaObjectId,
    ownerOrganizationId: request.ownerOrganizationId,
    propertyId: request.target.propertyId,
    purpose: parsed.purpose,
    publicVariants: parsed.publicVariants,
  }) as ResolvedPublicHotelMedia;
}

function snapshotResolutionRequest(input: {
  ownerOrganizationId: string;
  target: HotelMediaResolutionTarget;
  mediaObjectIds: readonly string[];
}): {
  ownerOrganizationId: string;
  target: HotelMediaResolutionTarget;
  mediaObjectIds: readonly string[];
} | null {
  const target = snapshotTarget(input.target);
  if (
    !isNonEmptyString(input.ownerOrganizationId) ||
    !target ||
    !Array.isArray(input.mediaObjectIds)
  ) {
    return null;
  }
  const mediaObjectIds = input.mediaObjectIds.map(normalizeUuid);
  if (mediaObjectIds.some((id) => !id) || new Set(mediaObjectIds).size !== mediaObjectIds.length) {
    return null;
  }
  return Object.freeze({
    ownerOrganizationId: input.ownerOrganizationId,
    target,
    mediaObjectIds: Object.freeze(mediaObjectIds as string[]),
  });
}

function snapshotTarget(value: HotelMediaResolutionTarget): HotelMediaResolutionTarget | null {
  if (
    isExactDataRecord(value, ["kind", "propertyId"]) &&
    value.kind === "property" &&
    isNonEmptyString(value.propertyId)
  ) {
    return Object.freeze({ kind: "property", propertyId: value.propertyId });
  }
  if (
    isExactDataRecord(value, ["kind", "propertyId", "roomTypeId"]) &&
    value.kind === "room_type" &&
    isNonEmptyString(value.propertyId) &&
    isNonEmptyString(value.roomTypeId)
  ) {
    return Object.freeze({
      kind: "room_type",
      propertyId: value.propertyId,
      roomTypeId: value.roomTypeId,
    });
  }
  return null;
}

function resolvePropertyAssignment(
  assignment: PropertyMediaAssignment,
  mediaById: ReadonlyMap<string, ResolvedPublicHotelMedia>,
): ResolvedPropertyMediaAssignment | null {
  const media = mediaById.get(assignment.mediaObjectId);
  return media
    ? Object.freeze({
        media,
        role: assignment.role,
        altText: assignment.altText,
        sortOrder: assignment.sortOrder,
      })
    : null;
}

function sameTarget(left: HotelMediaResolutionTarget, right: HotelMediaResolutionTarget): boolean {
  return (
    left.kind === right.kind &&
    left.propertyId === right.propertyId &&
    (left.kind === "property" ||
      (right.kind === "room_type" && left.roomTypeId === right.roomTypeId))
  );
}

function isTrustedBatch(value: object): value is ResolvedHotelMediaBatch {
  return trustedResolutionBatches.has(value);
}

function unauthorized(mediaObjectIds: readonly string[]): {
  ok: false;
  error: MediaResolutionError;
} {
  return {
    ok: false,
    error: { code: "media_not_authorized", mediaObjectIds: [...mediaObjectIds] },
  };
}

function snapshotResolutionError(
  error: MediaResolutionError,
  requestedMediaObjectIds: readonly string[],
): { ok: false; error: MediaResolutionError } {
  if (
    !isExactDataRecord(error, ["code", "mediaObjectIds"]) ||
    !["media_not_found", "media_not_authorized", "media_not_ready"].includes(
      error.code as string,
    ) ||
    !Array.isArray(error.mediaObjectIds)
  ) {
    return unauthorized(requestedMediaObjectIds);
  }
  const mediaObjectIds = error.mediaObjectIds.map(normalizeUuid);
  if (mediaObjectIds.some((id) => !id)) return unauthorized(requestedMediaObjectIds);
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: error.code,
      mediaObjectIds: Object.freeze(mediaObjectIds as string[]) as unknown as string[],
    }) as MediaResolutionError,
  });
}

function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function isExactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
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

function isValidAltText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= PROPERTY_MEDIA_MAX_ALT_TEXT_LENGTH)
  );
}

function isPositiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
