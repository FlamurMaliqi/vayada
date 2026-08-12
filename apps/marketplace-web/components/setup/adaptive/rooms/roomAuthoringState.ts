import {
  type PropertySetupRouteReadModel,
  type SavePropertySetupDraftRequest,
} from "@vayada/domain-hotels";
import { parseDraftRoomId, parseRoomTypeFacts, type RoomTypeFacts } from "@vayada/domain-pms";

export const ROOM_NAME_MAX_LENGTH = 200;
export const ROOM_DESCRIPTION_MAX_LENGTH = 5_000;
export const ROOM_MEDIA_MAX_FILE_SIZE = 10 * 1024 * 1024;

export const ROOM_CATEGORIES = [
  ["standard", "Standard"],
  ["deluxe", "Deluxe"],
  ["superior", "Superior"],
  ["suite", "Suite"],
  ["villa", "Villa"],
  ["bungalow", "Bungalow"],
  ["studio", "Studio"],
  ["penthouse", "Penthouse"],
] as const;

export const ROOM_BED_TYPES = [
  ["king", "King bed"],
  ["queen", "Queen bed"],
  ["double", "Double bed"],
  ["twin", "Twin bed"],
  ["single", "Single bed"],
  ["bunk_bed", "Bunk bed"],
  ["sofa_bed", "Sofa bed"],
] as const;

export const ROOM_AMENITY_GROUPS = [
  {
    label: "Popular",
    items: [
      ["wifi", "Wi-Fi"],
      ["air_conditioning", "Air conditioning"],
      ["flat_screen_tv", "Flat-screen TV"],
      ["balcony", "Balcony"],
      ["kitchen", "Kitchen"],
      ["non_smoking", "Non-smoking"],
    ],
  },
  {
    label: "Comfort",
    items: [
      ["heating", "Heating"],
      ["blackout_curtains", "Blackout curtains"],
      ["bathrobe", "Bathrobe"],
      ["slippers", "Slippers"],
      ["extra_pillows", "Extra pillows"],
      ["wardrobe", "Wardrobe"],
      ["clothes_rack", "Clothes rack"],
    ],
  },
  {
    label: "Bathroom",
    items: [
      ["bathtub", "Bathtub"],
      ["shower", "Shower"],
      ["hairdryer", "Hairdryer"],
      ["free_toiletries", "Free toiletries"],
      ["towels", "Towels"],
    ],
  },
  {
    label: "Kitchen and workspace",
    items: [
      ["minibar", "Minibar"],
      ["refrigerator", "Refrigerator"],
      ["microwave", "Microwave"],
      ["electric_kettle", "Electric kettle"],
      ["kitchenware", "Kitchenware"],
      ["work_desk", "Work desk"],
      ["laptop_friendly_workspace", "Laptop-friendly workspace"],
    ],
  },
] as const;

export type RoomBedDraft = {
  id: string;
  type: string;
  quantity: string;
};

export type RoomPhotoDraft = {
  mediaObjectId: string;
  previewUrl: string | null;
  uploadState: "ready" | "uploading" | "failed";
  errorMessage: string | null;
};

export type RoomAuthoringDraft = {
  draftRoomId: string;
  roomTypeId: string | null;
  roomFactsRevision: number | null;
  roomUnitsRevision: number | null;
  roomMediaRevision: number | null;
  roomAmenitiesRevision: number | null;
  name: string;
  unitCount: string;
  maxGuests: string;
  separateOccupancy: boolean;
  maxAdults: string;
  maxChildren: string;
  beds: RoomBedDraft[];
  bathroomType: "" | "private" | "shared";
  description: string;
  category: string;
  bedrooms: string;
  bathrooms: string;
  sizeSquareMetres: string;
  photos: RoomPhotoDraft[];
  amenityKeys: string[];
  reviewedEmptyAmenities: boolean;
  saved: boolean;
  dirty: boolean;
};

export type CanonicalRoomAuthoringState = {
  draftRoomId: string;
  roomTypeId: string;
  roomFactsRevision: number;
  roomUnitsRevision: number;
  roomMediaRevision: number;
  roomAmenitiesRevision: number;
  facts: RoomTypeFacts;
  activeUnitCount: number;
  photos: Array<{ mediaObjectId: string; publicUrl: string | null }>;
  amenityKeys: string[];
  amenitiesReviewed: boolean;
};

export type RoomDraftRevisionContext = {
  sessionId: string | null;
  trackRevision: number;
  sessionRevision: number;
  draftRevision: number;
  baseRevisions: {
    "pms.room_types": string;
    "pms.room_units": string;
    "pms.room_media": string;
  } | null;
};

export type RoomValidationErrors = Record<string, string>;

const ROOM_DRAFT_FIELDS = [
  "room.name",
  "room.category",
  "room.max_occupancy",
  "room.max_adults",
  "room.max_children",
  "room.beds",
  "room.bedrooms",
  "room.bathrooms",
  "room.bathroom_type",
  "room.size",
  "room.description",
  "room.unit_count",
  "room.images",
  "room.amenities",
] as const;

export function createEmptyRoomDraft(
  idFactory: () => string = () => `draft:${crypto.randomUUID()}`,
): RoomAuthoringDraft {
  const draftRoomId = idFactory();
  if (!parseDraftRoomId(draftRoomId)) {
    throw new TypeError("Room drafts require an opaque stable identifier.");
  }
  return {
    draftRoomId,
    roomTypeId: null,
    roomFactsRevision: null,
    roomUnitsRevision: null,
    roomMediaRevision: null,
    roomAmenitiesRevision: null,
    name: "",
    unitCount: "",
    maxGuests: "",
    separateOccupancy: false,
    maxAdults: "",
    maxChildren: "",
    beds: [{ id: `${draftRoomId}:bed:1`, type: "", quantity: "1" }],
    bathroomType: "",
    description: "",
    category: "",
    bedrooms: "",
    bathrooms: "",
    sizeSquareMetres: "",
    photos: [],
    amenityKeys: [],
    reviewedEmptyAmenities: false,
    saved: false,
    dirty: false,
  };
}

export function roomDraftRevisionContext(
  route: PropertySetupRouteReadModel,
  step: PropertySetupRouteReadModel["steps"][number],
): RoomDraftRevisionContext {
  const draft = step.stepId === "rooms" ? step.draft : null;
  const base =
    draft?.stepId === "rooms"
      ? draft.baseRevisions
      : step.stepId === "rooms"
        ? step.currentBaseRevisions
        : null;
  const roomTypesRevision = base?.["pms.room_types"];
  const roomUnitsRevision = base?.["pms.room_units"];
  const roomMediaRevision = base?.["pms.room_media"];
  return {
    sessionId: route.sessionId,
    trackRevision: route.trackRevision,
    sessionRevision: route.sessionRevision ?? 0,
    draftRevision: draft?.stepId === "rooms" ? draft.revision : 0,
    baseRevisions:
      typeof roomTypesRevision === "string" &&
      typeof roomUnitsRevision === "string" &&
      typeof roomMediaRevision === "string"
        ? {
            "pms.room_types": roomTypesRevision,
            "pms.room_units": roomUnitsRevision,
            "pms.room_media": roomMediaRevision,
          }
        : null,
  };
}

export function hydrateRoomDrafts(
  routeDraft: PropertySetupRouteReadModel["steps"][number]["draft"],
  canonicalRooms: readonly CanonicalRoomAuthoringState[],
  options: { ensureBlank?: boolean; idFactory?: () => string } = {},
): RoomAuthoringDraft[] {
  const payload = routeDraft?.stepId === "rooms" ? routeDraft.payload : {};
  const draftIds = new Set<string>();
  for (const field of ROOM_DRAFT_FIELDS) {
    const map = entityMap(payload[field]);
    for (const id of Object.keys(map)) {
      if (parseDraftRoomId(id)) draftIds.add(id);
    }
  }
  for (const room of canonicalRooms) draftIds.add(room.draftRoomId);

  const canonicalByDraftId = new Map(canonicalRooms.map((room) => [room.draftRoomId, room]));
  const rooms = Array.from(draftIds).map((draftRoomId) => {
    const canonical = canonicalByDraftId.get(draftRoomId);
    const fallback = canonical?.facts;
    const maxGuests = fieldValue(
      payload,
      "room.max_occupancy",
      draftRoomId,
      fallback?.occupancy.maxGuests,
    );
    const maxAdults = fieldValue(
      payload,
      "room.max_adults",
      draftRoomId,
      fallback?.occupancy.maxAdults,
    );
    const maxChildren = fieldValue(
      payload,
      "room.max_children",
      draftRoomId,
      fallback?.occupancy.maxChildren,
    );
    const beds = fieldValue(payload, "room.beds", draftRoomId, fallback?.beds);
    const images = fieldValue(
      payload,
      "room.images",
      draftRoomId,
      canonical?.photos.map(({ mediaObjectId }) => mediaObjectId),
    );
    const amenities = fieldValue(
      payload,
      "room.amenities",
      draftRoomId,
      canonical
        ? {
            keys: canonical.amenityKeys,
            reviewedEmpty: canonical.amenitiesReviewed && canonical.amenityKeys.length === 0,
          }
        : undefined,
    );
    const canonicalPhotos = new Map(
      canonical?.photos.map(({ mediaObjectId, publicUrl }) => [mediaObjectId, publicUrl]) ?? [],
    );
    const adultText = numberText(maxAdults);
    const childText = numberText(maxChildren);
    const guestText = numberText(maxGuests);

    return {
      draftRoomId,
      roomTypeId: canonical?.roomTypeId ?? null,
      roomFactsRevision: canonical?.roomFactsRevision ?? null,
      roomUnitsRevision: canonical?.roomUnitsRevision ?? null,
      roomMediaRevision: canonical?.roomMediaRevision ?? null,
      roomAmenitiesRevision: canonical?.roomAmenitiesRevision ?? null,
      name: stringValue(fieldValue(payload, "room.name", draftRoomId, fallback?.name)),
      unitCount: numberText(
        fieldValue(payload, "room.unit_count", draftRoomId, canonical?.activeUnitCount),
      ),
      maxGuests: guestText,
      separateOccupancy:
        adultText !== "" &&
        childText !== "" &&
        (adultText !== guestText || childText !== guestText),
      maxAdults: adultText,
      maxChildren: childText,
      beds:
        Array.isArray(beds) && beds.length > 0
          ? beds.map((bed, index) => ({
              id: `${draftRoomId}:bed:${index + 1}`,
              type: isRecord(bed) && typeof bed.type === "string" ? bed.type : "",
              quantity: isRecord(bed) ? numberText(bed.quantity) || "1" : "1",
            }))
          : [{ id: `${draftRoomId}:bed:1`, type: "", quantity: "1" }],
      bathroomType: bathroomType(
        fieldValue(payload, "room.bathroom_type", draftRoomId, fallback?.bathroomType),
      ),
      description: stringValue(
        fieldValue(payload, "room.description", draftRoomId, fallback?.description),
      ),
      category: stringValue(fieldValue(payload, "room.category", draftRoomId, fallback?.category)),
      bedrooms: numberText(fieldValue(payload, "room.bedrooms", draftRoomId, fallback?.bedrooms)),
      bathrooms: numberText(
        fieldValue(payload, "room.bathrooms", draftRoomId, fallback?.bathrooms),
      ),
      sizeSquareMetres: numberText(
        sizeValue(fieldValue(payload, "room.size", draftRoomId, fallback?.size)),
      ),
      photos: Array.isArray(images)
        ? images.flatMap((mediaObjectId) =>
            typeof mediaObjectId === "string"
              ? [
                  {
                    mediaObjectId,
                    previewUrl: canonicalPhotos.get(mediaObjectId) ?? null,
                    uploadState: "ready" as const,
                    errorMessage: null,
                  },
                ]
              : [],
          )
        : [],
      amenityKeys:
        isRecord(amenities) && Array.isArray(amenities.keys)
          ? amenities.keys.filter((key): key is string => typeof key === "string")
          : [],
      reviewedEmptyAmenities: isRecord(amenities) && amenities.reviewedEmpty === true,
      saved: Boolean(
        canonical &&
        canonical.activeUnitCount > 0 &&
        canonical.photos.length > 0 &&
        canonical.amenitiesReviewed,
      ),
      dirty: false,
    } satisfies RoomAuthoringDraft;
  });

  if (rooms.length === 0 && options.ensureBlank !== false) {
    return [createEmptyRoomDraft(options.idFactory)];
  }
  return rooms;
}

export function validateRoomDraft(
  room: RoomAuthoringDraft,
  allRooms: readonly RoomAuthoringDraft[],
): RoomValidationErrors {
  const errors: RoomValidationErrors = {};
  const name = room.name.trim();
  if (!name) errors.name = "Enter a room type name.";
  else if (name.length > ROOM_NAME_MAX_LENGTH) {
    errors.name = `Use ${ROOM_NAME_MAX_LENGTH} characters or fewer.`;
  } else if (
    allRooms.some(
      (candidate) =>
        candidate.draftRoomId !== room.draftRoomId &&
        candidate.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    errors.name = "Room type names must be unique.";
  }

  if (!wholeNumber(room.unitCount, 1, 500)) {
    errors.unitCount = "Enter a whole number from 1 to 500.";
  }
  if (!wholeNumber(room.maxGuests, 1, 100)) {
    errors.maxGuests = "Enter a whole number from 1 to 100.";
  }
  if (room.separateOccupancy) {
    const total = numberOrNull(room.maxGuests);
    const adults = numberOrNull(room.maxAdults);
    const children = numberOrNull(room.maxChildren);
    if (!wholeNumber(room.maxAdults, 1, total ?? 100)) {
      errors.maxAdults = "Enter at least one adult, no higher than maximum guests.";
    }
    if (!wholeNumber(room.maxChildren, 0, total ?? 100)) {
      errors.maxChildren = "Enter zero or more children, no higher than maximum guests.";
    }
    if (total !== null && adults !== null && children !== null && adults + children < total) {
      errors.maxChildren = "Adult and child limits together must cover maximum guests.";
    }
  }
  room.beds.forEach((bed, index) => {
    if (!bed.type) errors[`bedType.${index}`] = "Choose a bed type.";
    if (!wholeNumber(bed.quantity, 1, 20)) {
      errors[`bedQuantity.${index}`] = "Enter a quantity from 1 to 20.";
    }
  });
  if (!room.bathroomType) errors.bathroomType = "Choose a bathroom type.";
  if (room.description.length > ROOM_DESCRIPTION_MAX_LENGTH) {
    errors.description = `Use ${ROOM_DESCRIPTION_MAX_LENGTH} characters or fewer.`;
  }
  if (room.bedrooms && !wholeNumber(room.bedrooms, 0, 100)) {
    errors.bedrooms = "Enter a whole number from 0 to 100.";
  }
  if (room.bathroomType === "private" && room.bathrooms && !positiveNumber(room.bathrooms, 100)) {
    errors.bathrooms = "Enter a number greater than 0 and no higher than 100.";
  }
  if (room.sizeSquareMetres && !positiveNumber(room.sizeSquareMetres, 100_000)) {
    errors.sizeSquareMetres = "Enter a room size greater than 0.";
  }
  if (room.photos.length === 0 || room.photos.every(({ uploadState }) => uploadState !== "ready")) {
    errors.photos = "Add at least one room photo.";
  } else if (room.photos.some(({ uploadState }) => uploadState === "uploading")) {
    errors.photos = "Wait for photo uploads to finish.";
  } else if (room.photos.some(({ uploadState }) => uploadState === "failed")) {
    errors.photos = "Retry or remove every failed photo before saving.";
  }
  if (room.amenityKeys.length === 0 && !room.reviewedEmptyAmenities) {
    errors.amenities = "Choose room amenities or confirm that none apply.";
  }
  return errors;
}

export function roomDraftToFacts(room: RoomAuthoringDraft): RoomTypeFacts {
  const maxGuests = Number(room.maxGuests);
  const value = {
    name: room.name.trim(),
    description: room.description.trim(),
    category: room.category || null,
    occupancy: {
      maxGuests,
      maxAdults: room.separateOccupancy ? Number(room.maxAdults) : maxGuests,
      maxChildren: room.separateOccupancy ? Number(room.maxChildren) : maxGuests,
    },
    beds: room.beds.map((bed) => ({ type: bed.type, quantity: Number(bed.quantity) })),
    bedrooms: room.bedrooms === "" ? null : Number(room.bedrooms),
    bathrooms:
      room.bathroomType === "private" && room.bathrooms !== "" ? Number(room.bathrooms) : null,
    bathroomType: room.bathroomType,
    size:
      room.sizeSquareMetres === ""
        ? null
        : { value: Number(room.sizeSquareMetres), unit: "sqm" as const },
  };
  const facts = parseRoomTypeFacts(value);
  if (!facts) throw new TypeError("Complete room facts are invalid.");
  return facts;
}

export function buildRoomsDraftRequest(
  rooms: readonly RoomAuthoringDraft[],
  revision: RoomDraftRevisionContext,
): SavePropertySetupDraftRequest {
  if (revision.baseRevisions === null) {
    throw new RoomDraftManifestUnavailableError();
  }
  const persisted = rooms.filter((room) => room.roomTypeId !== null || roomHasInput(room));
  const payload = {
    "room.name": roomMap(persisted, (room) => boundedText(room.name, ROOM_NAME_MAX_LENGTH)),
    "room.category": roomMap(persisted, (room) => room.category || null),
    "room.max_occupancy": roomMap(persisted, (room) => draftInteger(room.maxGuests, 1, 100)),
    "room.max_adults": roomMap(persisted, (room) =>
      room.separateOccupancy
        ? draftInteger(room.maxAdults, 1, 100)
        : draftInteger(room.maxGuests, 1, 100),
    ),
    "room.max_children": roomMap(persisted, (room) =>
      room.separateOccupancy
        ? draftInteger(room.maxChildren, 0, 100)
        : draftInteger(room.maxGuests, 1, 100),
    ),
    "room.beds": roomMap(persisted, (room) =>
      room.beds.map((bed) => ({
        type: bed.type || null,
        quantity: draftInteger(bed.quantity, 1, 20),
      })),
    ),
    "room.bedrooms": roomMap(persisted, (room) => draftInteger(room.bedrooms, 0, 100)),
    "room.bathrooms": roomMap(persisted, (room) => draftNumber(room.bathrooms, 100)),
    "room.bathroom_type": roomMap(persisted, (room) => room.bathroomType || null),
    "room.size": roomMap(persisted, (room) => {
      const value = draftNumber(room.sizeSquareMetres, 100_000);
      return value === null ? null : { value, unit: "sqm" };
    }),
    "room.description": roomMap(persisted, (room) =>
      boundedText(room.description, ROOM_DESCRIPTION_MAX_LENGTH),
    ),
    "room.unit_count": roomMap(persisted, (room) => draftInteger(room.unitCount, 1, 500)),
    "room.images": roomMap(persisted, (room) =>
      room.photos
        .filter(({ uploadState }) => uploadState === "ready")
        .map(({ mediaObjectId }) => mediaObjectId),
    ),
    "room.amenities": roomMap(persisted, (room) => ({
      keys: Array.from(new Set(room.amenityKeys)).sort(),
      reviewedEmpty: room.amenityKeys.length === 0 ? room.reviewedEmptyAmenities || null : false,
    })),
  } as const;

  return {
    stepId: "rooms",
    payload,
    dirtyFields: Array.from(ROOM_DRAFT_FIELDS),
    expectedBaseRevisions: revision.baseRevisions,
    expectedTrackRevision: revision.trackRevision,
    expectedSessionRevision: revision.sessionRevision,
    expectedDraftRevision: revision.draftRevision,
  };
}

export function roomHasInput(room: RoomAuthoringDraft): boolean {
  return Boolean(
    room.name ||
    room.unitCount ||
    room.maxGuests ||
    room.beds.some(({ type }) => type) ||
    room.bathroomType ||
    room.description ||
    room.category ||
    room.bedrooms ||
    room.bathrooms ||
    room.sizeSquareMetres ||
    room.photos.length ||
    room.amenityKeys.length ||
    room.reviewedEmptyAmenities,
  );
}

export function roomMissingSummary(errors: RoomValidationErrors): string {
  const labels: Array<[string, string]> = [
    ["name", "name"],
    ["unitCount", "unit count"],
    ["maxGuests", "guest limit"],
    ["bathroomType", "bathroom"],
    ["photos", "photos"],
    ["amenities", "amenities"],
  ];
  if (Object.keys(errors).some((key) => key.startsWith("bed")))
    labels.splice(3, 0, ["beds", "beds"]);
  const missing = labels
    .filter(([key]) =>
      key === "beds"
        ? Object.keys(errors).some((error) => error.startsWith("bed"))
        : Boolean(errors[key]),
    )
    .map(([, label]) => label);
  return missing.length === 0 ? "Room details complete" : `Needs attention: ${missing.join(", ")}`;
}

export class RoomDraftManifestUnavailableError extends Error {
  constructor() {
    super("This room draft is missing its server revision manifest. Refresh setup and try again.");
    this.name = "RoomDraftManifestUnavailableError";
  }
}

function fieldValue(
  payload: Record<string, unknown>,
  field: string,
  draftRoomId: string,
  fallback: unknown,
): unknown {
  const map = entityMap(payload[field]);
  return Object.hasOwn(map, draftRoomId) ? map[draftRoomId] : fallback;
}

function entityMap(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function roomMap<T>(rooms: readonly RoomAuthoringDraft[], value: (room: RoomAuthoringDraft) => T) {
  return Object.fromEntries(rooms.map((room) => [room.draftRoomId, value(room)]));
}

function boundedText(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function draftInteger(value: string, minimum: number, maximum: number): number | null {
  return wholeNumber(value, minimum, maximum) ? Number(value) : null;
}

function draftNumber(value: string, maximum: number): number | null {
  return positiveNumber(value, maximum) ? Number(value) : null;
}

function wholeNumber(value: string, minimum: number, maximum: number): boolean {
  const parsed = numberOrNull(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function positiveNumber(value: string, maximum: number): boolean {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed > 0 && parsed <= maximum;
}

function numberOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function bathroomType(value: unknown): RoomAuthoringDraft["bathroomType"] {
  return value === "private" || value === "shared" ? value : "";
}

function sizeValue(value: unknown): unknown {
  return isRecord(value) && value.unit === "sqm" ? value.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
