import {
  assertPmsOperationsReadModelEnabled,
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "../api/pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";
import { unsupportedPmsNextStackFeature } from "../api/unsupported";
import type { RoomImageReference } from "../upload";
import { imageReferenceUrl, pmsRoomMediaResource, uploadService } from "../upload";

export interface MonthlyRate {
  baseRate?: number | null;
  nonRefundableRate?: number | null;
}

// Booking.com meal_plan_code values that Channex maps for us. 0 (room only)
// is the implicit default and never appears in the meal_plans array.
export type MealPlanCode = 1 | 3 | 4 | 9;

export type MealPlanChargeUnit = "room" | "person";

export interface MealPlan {
  code: MealPlanCode;
  surcharge: number;
  chargePer: MealPlanChargeUnit;
}

export interface PartialRefundTier {
  minDaysBeforeCheckIn: number;
  refundPercent: number;
}

export type RatePlanKey = "flexible" | "nonrefundable";

export interface RateDepositSetting {
  enabled: boolean;
  percentage: number | null;
}

export interface RoomType {
  id: string;
  hotelId: string;
  name: string;
  category: string;
  description: string;
  shortDescription: string;
  maxOccupancy: number;
  maxAdults: number | null;
  maxChildren: number | null;
  bedrooms: number;
  bathrooms: number;
  size: number;
  baseRate: number;
  nonRefundableRate: number | null;
  currency: string;
  locationAddress: string;
  latitude: number | null;
  longitude: number | null;
  amenities: string[];
  images: RoomImageReference[];
  roomMediaRevision: number;
  bedType: string;
  features: string[];
  benefits: string[];
  totalRooms: number;
  isActive: boolean;
  sortOrder: number;
  monthlyRates: Record<string, MonthlyRate>;
  dailyRates: Record<string, number>;
  operatingPeriods: { from: string; to: string }[];
  seasons: {
    name: string;
    tier: string;
    from: string;
    to: string;
    rate: string;
    minStay: number;
    maxStay?: number | string | null;
    occupancyRates?: Record<string, string>;
  }[];
  weekendSurcharge: string;
  cancellationPolicy: string;
  flexibleRateEnabled: boolean;
  flexibleCancellationType: "free" | "partial_refund";
  partialRefundCancelWindowDays: number;
  partialRefundAmountPercent: number;
  partialRefundTiers: PartialRefundTier[];
  nonRefundableEnabled: boolean;
  nonRefundableDiscount: number;
  nonRefundableCancellationPolicy: string;
  minimumAdvanceDays: number;
  ratePaymentMethods: Record<string, string[]> | null;
  rateDepositSettings: Partial<Record<RatePlanKey, RateDepositSetting>> | null;
  mealPlans: MealPlan[];
  createdAt: string;
  updatedAt: string;
}

export interface RoomTypeCreate {
  name: string;
  category?: string;
  description?: string;
  shortDescription?: string;
  maxOccupancy?: number;
  maxAdults?: number | null;
  maxChildren?: number | null;
  bedrooms?: number;
  bathrooms?: number;
  bathroomType?: "private" | "shared";
  size?: number;
  baseRate?: number;
  nonRefundableRate?: number | null;
  currency?: string;
  locationAddress?: string;
  latitude?: number | null;
  longitude?: number | null;
  amenities?: string[];
  images?: RoomImageReference[];
  bedType?: string;
  features?: string[];
  benefits?: string[];
  totalRooms?: number;
  isActive?: boolean;
  sortOrder?: number;
  monthlyRates?: Record<string, MonthlyRate>;
  dailyRates?: Record<string, number>;
  operatingPeriods?: { from: string; to: string }[];
  seasons?: {
    name: string;
    tier: string;
    from: string;
    to: string;
    rate: string;
    minStay: number;
    maxStay?: number | string | null;
    occupancyRates?: Record<string, string>;
  }[];
  weekendSurcharge?: string;
  cancellationPolicy?: string;
  flexibleRateEnabled?: boolean;
  flexibleCancellationType?: "free" | "partial_refund";
  partialRefundCancelWindowDays?: number;
  partialRefundAmountPercent?: number;
  partialRefundTiers?: PartialRefundTier[];
  nonRefundableEnabled?: boolean;
  nonRefundableDiscount?: number;
  nonRefundableCancellationPolicy?: string;
  minimumAdvanceDays?: number;
  ratePaymentMethods?: Record<string, string[]> | null;
  rateDepositSettings?: Partial<Record<RatePlanKey, RateDepositSetting>> | null;
  mealPlans?: MealPlan[];
}

export type RoomTypeUpdate = Partial<RoomTypeCreate>;

export interface Room {
  id: string;
  hotelId: string;
  roomTypeId: string;
  roomTypeName: string;
  roomNumber: string;
  floor: string;
  status: "available" | "maintenance" | "out_of_order";
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type PmsOperationsContractVersion = "pms-operations.v1";

export interface PropertyPlan {
  propertyId: string;
  plan: "commission" | "fixed";
  limits: {
    maxRoomPhotosPerType: number;
    maxAddons: number;
    guestContactAccess: "after_acceptance" | "always";
  };
}

export interface PmsPropertyPlanResponse {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  propertyPlan: PropertyPlan;
}

export interface PmsOperationsMoney {
  amountDecimal: string;
  currency: string;
}

export interface PmsOperationsRatePlan {
  ratePlanId: string;
  code: string;
  name: string;
  rateType: "flexible" | "non_refundable" | "package" | "manual";
  mealPlan: string | null;
  baseRate: PmsOperationsMoney;
  active: boolean;
}

export interface PmsOperationsRateRulesSummary {
  minStayNights: number | null;
  maxStayNights: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  activeRuleCount: number;
}

export interface PmsOperationsRoomType {
  roomTypeId: string;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: Record<string, number>;
  attributes: Record<string, string | number | boolean | null>;
  amenities: string[];
  media: { mediaObjectId?: string; url: string; altText?: string | null }[];
  roomMediaRevision: number;
  baseRate: PmsOperationsMoney;
  active: boolean;
  sortOrder: number;
  ratePlans: PmsOperationsRatePlan[];
  rateRulesSummary: PmsOperationsRateRulesSummary;
  roomCount: number;
}

export interface PmsOperationsRoom {
  roomId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  status: "available" | "maintenance" | "out_of_order" | "retired";
  sortOrder: number;
  metadata: Record<string, string | number | boolean | null>;
}

export interface PmsOperationsListResponse<T> {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: T[];
  sourceFreshness: Record<string, string | number | boolean | null>;
}

export interface PmsOperationsDetailResponse<T> {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: T;
  sourceFreshness: Record<string, string | number | boolean | null>;
}

export interface PmsOperationsCommandMeta {
  contractVersion: PmsOperationsContractVersion;
  commandId: string;
  idempotencyKey: string;
  acceptedAt: string;
  sideEffects: Array<"calendar_refresh" | "ari_changed" | "distribution_refresh" | "audit_event">;
}

export interface PmsOperationsCommandResponse<T> {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: T;
  commandMeta: PmsOperationsCommandMeta;
}

export interface RoomCreate {
  roomTypeId: string;
  roomNumber: string;
  floor?: string;
  status?: string;
  sortOrder?: number;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = asNumber(value, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toRoom(
  response: PmsOperationsListResponse<PmsOperationsRoom>,
  room: PmsOperationsRoom,
): Room {
  return {
    id: room.roomId,
    hotelId: response.propertyId,
    roomTypeId: room.roomTypeId,
    roomTypeName: asString(room.metadata.roomTypeName),
    roomNumber: room.roomNumber,
    floor: room.floor ?? "",
    status: room.status === "retired" ? "out_of_order" : room.status,
    sortOrder: room.sortOrder,
    createdAt: "",
    updatedAt: "",
  };
}

function toRoomType(propertyId: string, roomType: PmsOperationsRoomType): RoomType {
  const baseRate = asNumber(roomType.baseRate.amountDecimal);
  const maxAdults = roomType.occupancyLimits.adults ?? null;
  const maxChildren = roomType.occupancyLimits.children ?? null;
  const derivedOccupancy = (maxAdults ?? 0) + (maxChildren ?? 0);
  const maxOccupancy =
    roomType.occupancyLimits.total ?? (derivedOccupancy > 0 ? derivedOccupancy : 0);
  const nonRefundablePlan = roomType.ratePlans.find(
    (plan) => plan.active && plan.rateType === "non_refundable",
  );
  const nonRefundableRate = nonRefundablePlan
    ? asNumber(nonRefundablePlan.baseRate.amountDecimal)
    : null;

  return {
    id: roomType.roomTypeId,
    hotelId: propertyId,
    name: roomType.name,
    category: roomType.category ?? "",
    description: roomType.description,
    shortDescription: asString(roomType.attributes.shortDescription, roomType.description),
    maxOccupancy,
    maxAdults,
    maxChildren,
    bedrooms: asNumber(roomType.attributes.bedrooms, 1),
    bathrooms: asNumber(roomType.attributes.bathrooms, 1),
    size: asNumber(roomType.attributes.size),
    baseRate,
    nonRefundableRate,
    currency: roomType.baseRate.currency,
    locationAddress: asString(roomType.attributes.locationAddress),
    latitude: asNullableNumber(roomType.attributes.latitude),
    longitude: asNullableNumber(roomType.attributes.longitude),
    amenities: roomType.amenities,
    images: roomType.media.map((image) =>
      image.altText === undefined
        ? { url: image.url, platformMediaObjectId: image.mediaObjectId }
        : {
            url: image.url,
            platformMediaObjectId: image.mediaObjectId,
            altText: image.altText,
          },
    ),
    roomMediaRevision: roomType.roomMediaRevision ?? 1,
    bedType: asString(roomType.attributes.bedType),
    features: [],
    benefits: [],
    totalRooms: roomType.roomCount,
    isActive: roomType.active,
    sortOrder: roomType.sortOrder,
    monthlyRates: {},
    dailyRates: {},
    operatingPeriods: [],
    seasons:
      baseRate > 0
        ? [
            {
              name: "Default",
              tier: "mid",
              from: "01-01",
              to: "12-31",
              rate: String(baseRate),
              minStay: roomType.rateRulesSummary.minStayNights ?? 1,
              maxStay: roomType.rateRulesSummary.maxStayNights,
            },
          ]
        : [],
    weekendSurcharge: "+0%",
    cancellationPolicy: "Free until 7 days before",
    flexibleRateEnabled: true,
    flexibleCancellationType: "free",
    partialRefundCancelWindowDays: 30,
    partialRefundAmountPercent: 50,
    partialRefundTiers: [],
    nonRefundableEnabled: nonRefundableRate != null,
    nonRefundableDiscount:
      baseRate > 0 && nonRefundableRate != null
        ? Math.max(0, Math.round((1 - nonRefundableRate / baseRate) * 100))
        : 5,
    nonRefundableCancellationPolicy: "Non-refundable from booking",
    minimumAdvanceDays: 0,
    ratePaymentMethods: null,
    rateDepositSettings: null,
    mealPlans: [],
    createdAt: "",
    updatedAt: "",
  };
}

export const individualRoomsService = {
  list: async () => {
    const propertyId = await resolveSelectedPmsPropertyId("loading rooms");
    const response = await pmsOperationsRoomsReadService.listRooms(propertyId);
    return response.items
      .filter((room) => room.status !== "retired")
      .map((room) => toRoom(response, room));
  },

  create: (_data: RoomCreate) => unsupportedPmsNextStackFeature<Room>("Room creation"),

  update: (_id: string, _data: Partial<RoomCreate>) =>
    unsupportedPmsNextStackFeature<Room>("Room updates"),

  delete: (_id: string) => unsupportedPmsNextStackFeature<void>("Room deletion"),
};

export const benefitsService = {
  get: () => unsupportedPmsNextStackFeature<{ benefits: string[] }>("Room benefits"),

  update: (_benefits: string[]) =>
    unsupportedPmsNextStackFeature<{ benefits: string[] }>("Room benefits"),
};

export const roomsService = {
  getPropertyPlan: async () => {
    const propertyId = await resolveSelectedPmsPropertyId("loading property plan");
    const response = await pmsOperationsRoomsReadService.getPropertyPlan(propertyId);
    return response.propertyPlan;
  },

  list: async () => {
    const propertyId = await resolveSelectedPmsPropertyId("loading room types");
    const response = await pmsOperationsRoomsReadService.listRoomTypes(propertyId);
    return response.items.map((roomType) => toRoomType(response.propertyId, roomType));
  },

  get: async (id: string) => {
    const propertyId = await resolveSelectedPmsPropertyId("loading room type");
    const response = await pmsOperationsRoomsReadService.getRoomType(propertyId, id);
    return toRoomType(response.propertyId, response.item);
  },

  create: async (data: RoomTypeCreate) => {
    const propertyId = await resolveSelectedPmsPropertyId("creating room type");
    const stagedImages = (data.images ?? []).filter(
      (image): image is Exclude<RoomImageReference, string> & { pendingFile: File } =>
        typeof File !== "undefined" &&
        typeof image !== "string" &&
        image.pendingFile instanceof File,
    );
    const response = await pmsOperationsRoomsReadService.createRoomType(propertyId, {
      ...data,
      images: [],
    });
    let created = toRoomType(response.propertyId, response.item);
    if (stagedImages.length > 0) {
      const uploaded = await uploadService.uploadImages(
        stagedImages.map(({ pendingFile }) => pendingFile),
        pmsRoomMediaResource(propertyId, created.id),
      );
      const images = uploaded.images.map(({ platformMediaObjectId, url }) => ({
        url,
        platformMediaObjectId,
      }));
      await replaceRoomTypeMedia(propertyId, created, images);
      stagedImages.forEach(({ url }) => {
        if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
      });
      const refreshed = await pmsOperationsRoomsReadService.getRoomType(propertyId, created.id);
      created = toRoomType(refreshed.propertyId, refreshed.item);
    }
    return created;
  },

  update: async (id: string, data: RoomTypeUpdate) => {
    const propertyId = await resolveSelectedPmsPropertyId("updating room type");
    const response = await pmsOperationsRoomsReadService.updateRoomType(propertyId, id, data);
    let updated = toRoomType(response.propertyId, response.item);
    if (data.images && !sameRoomImageOrder(data.images, updated.images)) {
      await replaceRoomTypeMedia(propertyId, updated, data.images);
      const refreshed = await pmsOperationsRoomsReadService.getRoomType(propertyId, id);
      updated = toRoomType(refreshed.propertyId, refreshed.item);
    }
    return updated;
  },

  delete: (_id: string) => unsupportedPmsNextStackFeature<void>("Room type deletion"),

  duplicate: (_id: string) => unsupportedPmsNextStackFeature<RoomType>("Room type duplication"),
};

export const pmsOperationsRoomsReadService = {
  getPropertyPlan: (propertyId: string) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.get<PmsPropertyPlanResponse>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/plan-limits`,
      pmsOperationsRequestOptions,
    );
  },

  listRooms: (propertyId: string) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoom>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/rooms`,
      pmsOperationsRequestOptions,
    );
  },

  listRoomTypes: (propertyId: string) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoomType>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types`,
      pmsOperationsRequestOptions,
    );
  },

  getRoomType: (propertyId: string, roomTypeId: string) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.get<PmsOperationsDetailResponse<PmsOperationsRoomType>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(
        roomTypeId,
      )}`,
      pmsOperationsRequestOptions,
    );
  },

  createRoomType: (propertyId: string, data: RoomTypeCreate) => {
    assertPmsOperationsReadModelEnabled();
    const commandId = randomCommandId("pms-room-type-create");
    return pmsOperationsClient.post<PmsOperationsCommandResponse<PmsOperationsRoomType>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types`,
      {
        ...data,
        commandId,
        idempotencyKey: commandId,
      },
      pmsOperationsRequestOptions,
    );
  },

  updateRoomType: (propertyId: string, roomTypeId: string, data: RoomTypeUpdate) => {
    assertPmsOperationsReadModelEnabled();
    const commandId = randomCommandId("pms-room-type-update");
    return pmsOperationsClient.patch<PmsOperationsCommandResponse<PmsOperationsRoomType>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(
        roomTypeId,
      )}`,
      {
        ...roomTypeLocationPayload(data),
        commandId,
        idempotencyKey: commandId,
      },
      pmsOperationsRequestOptions,
    );
  },

  replaceRoomTypeMedia: (
    propertyId: string,
    roomTypeId: string,
    expectedRoomMediaRevision: number,
    assignments: { mediaObjectId: string; altText: string | null; sortOrder: number }[],
    legacyMediaSnapshot?: {
      mediaObjectId: string | null;
      url: string;
      altText: string | null;
      sortOrder: number;
    }[],
  ) => {
    assertPmsOperationsReadModelEnabled();
    const commandId = randomCommandId("pms-room-media");
    return pmsOperationsClient.put<{
      propertyId: string;
      roomTypeId: string;
      roomMediaRevision: number;
    }>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(
        roomTypeId,
      )}/media`,
      {
        expectedRoomMediaRevision,
        assignments,
        ...(legacyMediaSnapshot ? { legacyMediaSnapshot } : {}),
      },
      {
        ...pmsOperationsRequestOptions,
        headers: {
          ...(pmsOperationsRequestOptions.headers as Record<string, string>),
          "Idempotency-Key": commandId,
        },
      },
    );
  },
};

async function replaceRoomTypeMedia(
  propertyId: string,
  roomType: RoomType,
  images: RoomImageReference[],
): Promise<void> {
  const assignments = images
    .filter(
      (image): image is Exclude<RoomImageReference, string> & { platformMediaObjectId: string } =>
        typeof image !== "string" && Boolean(image.platformMediaObjectId),
    )
    .map((image, sortOrder) => ({
      mediaObjectId: image.platformMediaObjectId,
      altText: image.altText?.trim() || null,
      sortOrder,
    }));
  const hasLegacyMedia = assignments.length !== images.length;
  const legacyMediaSnapshot = hasLegacyMedia
    ? images.map((image, sortOrder) => ({
        mediaObjectId: typeof image === "string" ? null : (image.platformMediaObjectId ?? null),
        url: imageReferenceUrl(image),
        altText: typeof image === "string" ? null : image.altText?.trim() || null,
        sortOrder,
      }))
    : undefined;
  if (
    legacyMediaSnapshot?.some(({ url }) => {
      const resolvedUrl = url.trim();
      return !resolvedUrl || resolvedUrl.startsWith("blob:");
    })
  ) {
    throw new Error("Every saved room photo must finish uploading before the room can be saved.");
  }
  await pmsOperationsRoomsReadService.replaceRoomTypeMedia(
    propertyId,
    roomType.id,
    roomType.roomMediaRevision,
    assignments,
    legacyMediaSnapshot,
  );
}

function sameRoomImageOrder(left: RoomImageReference[], right: RoomImageReference[]): boolean {
  const keys = (images: RoomImageReference[]) =>
    images.map((image) =>
      typeof image !== "string" && image.platformMediaObjectId
        ? `media:${image.platformMediaObjectId}`
        : `url:${imageReferenceUrl(image)}`,
    );
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right));
}

function roomTypeLocationPayload(data: RoomTypeUpdate) {
  const payload: Pick<RoomTypeCreate, "locationAddress" | "latitude" | "longitude"> = {};
  if (Object.hasOwn(data, "locationAddress")) payload.locationAddress = data.locationAddress;
  if (Object.hasOwn(data, "latitude")) payload.latitude = data.latitude ?? null;
  if (Object.hasOwn(data, "longitude")) payload.longitude = data.longitude ?? null;
  return payload;
}

function randomCommandId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}
