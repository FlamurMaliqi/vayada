import { pmsClient } from "../api/pmsClient";

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
  images: string[];
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
  size?: number;
  baseRate?: number;
  nonRefundableRate?: number | null;
  currency?: string;
  locationAddress?: string;
  latitude?: number | null;
  longitude?: number | null;
  amenities?: string[];
  images?: string[];
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

export interface LinkedInventoryGroup {
  groupId: string;
  name: string;
  memberRoomTypeIds: string[];
}

export interface RoomCreate {
  roomTypeId: string;
  roomNumber: string;
  floor?: string;
  status?: string;
  sortOrder?: number;
}

export interface LocationSuggestion {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
}

export const individualRoomsService = {
  list: () => pmsClient.get<Room[]>("/admin/rooms"),

  create: (data: RoomCreate) => pmsClient.post<Room>("/admin/rooms", data),

  update: (id: string, data: Partial<RoomCreate>) =>
    pmsClient.patch<Room>(`/admin/rooms/${id}`, data),

  delete: (id: string) => pmsClient.delete(`/admin/rooms/${id}`),
};

export const benefitsService = {
  get: () => pmsClient.get<{ benefits: string[] }>("/admin/benefits"),

  update: (benefits: string[]) =>
    pmsClient.put<{ benefits: string[] }>("/admin/benefits", { benefits }),
};

export const roomsService = {
  list: () => pmsClient.get<RoomType[]>("/admin/room-types"),

  searchLocations: (query: string, options?: RequestInit) =>
    pmsClient.get<{ results: LocationSuggestion[] }>(
      `/admin/geocode/search?q=${encodeURIComponent(query)}`,
      options,
    ),

  get: (id: string) => pmsClient.get<RoomType>(`/admin/room-types/${id}`),

  create: (data: RoomTypeCreate) => pmsClient.post<RoomType>("/admin/room-types", data),

  update: (id: string, data: RoomTypeUpdate) =>
    pmsClient.patch<RoomType>(`/admin/room-types/${id}`, data),

  delete: (id: string) => pmsClient.delete(`/admin/room-types/${id}`),

  duplicate: (id: string) => pmsClient.post<RoomType>(`/admin/room-types/${id}/duplicate`),
};

export const linkedInventoryGroupsService = {
  list: () => pmsClient.get<LinkedInventoryGroup[]>("/admin/linked-inventory-groups"),

  create: (name: string, memberRoomTypeIds: string[]) =>
    pmsClient.post<LinkedInventoryGroup>("/admin/linked-inventory-groups", {
      name,
      memberRoomTypeIds,
    }),

  update: (groupId: string, name: string, memberRoomTypeIds: string[]) =>
    pmsClient.put<LinkedInventoryGroup>(`/admin/linked-inventory-groups/${groupId}`, {
      name,
      memberRoomTypeIds,
    }),

  delete: (groupId: string) => pmsClient.delete<void>(`/admin/linked-inventory-groups/${groupId}`),
};
