import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  PmsInventoryPublicOfferProjectionPort,
  PublicBookabilityPublicationCommandPort,
} from "@vayada/domain-distribution";
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

import { syncPropertyOfferReadModels } from "./marketplaceAdmin.js";
import { enforceRoutePolicy } from "./policy.js";

export const BOOKING_ADDON_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/addons",
  permission: "booking.settings.manage",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export const BOOKING_GUEST_FORM_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/guest-form",
  permission: "booking.settings.manage",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export const BOOKING_BENEFITS_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/benefits",
  permission: "booking.settings.manage",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export const BOOKING_LOCALIZATION_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/localization",
  permission: "booking.settings.manage",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export const BOOKING_ROOM_FILTER_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/room-filters",
  permission: "booking.settings.manage",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export const BOOKING_DESIGN_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/design",
  permission: "booking.settings.manage",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export const BOOKING_LAST_MINUTE_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/last-minute",
  permission: "booking.settings.manage",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export const BOOKING_HOTEL_PROPERTY_LINK_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/property-link",
  permission: "booking.settings.manage",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export const BOOKING_ADDON_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_ADDON_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_GUEST_FORM_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_GUEST_FORM_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_BENEFITS_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_BENEFITS_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_LOCALIZATION_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_LOCALIZATION_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_ROOM_FILTER_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_ROOM_FILTER_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_DESIGN_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_DESIGN_SETTINGS_CONTRACT,
  method: "PATCH",
} as const;

export const BOOKING_LAST_MINUTE_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_LAST_MINUTE_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_PROPERTY_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_HOTEL_PROPERTY_LINK_CONTRACT,
  method: "PATCH",
  path: "/api/booking/hotels/:hotelId/settings/property",
} as const;

export const BOOKING_PUBLIC_BOOKABILITY_PUBLICATION_CONTRACT = {
  ...BOOKING_HOTEL_PROPERTY_LINK_CONTRACT,
  method: "POST",
  path: "/api/booking/hotels/:hotelId/public-bookability",
} as const;

export type BookingAddonSettingsReadModel = {
  showAddonsStep?: boolean | null;
  groupAddonsByCategory?: boolean | null;
};

export type BookingGuestFormSettingsReadModel = {
  specialRequestsEnabled?: boolean | null;
  arrivalTimeEnabled?: boolean | null;
  guestCountEnabled?: boolean | null;
  phoneRequired?: boolean | null;
  adultAgeThreshold?: number | null;
  childrenEnabled?: boolean | null;
};

export type BookingBenefitsSettingsReadModel = {
  benefits?: unknown;
};

export type BookingLocalizationSettingsReadModel = {
  defaultCurrency?: string | null;
  defaultLanguage?: string | null;
  supportedCurrencies?: unknown;
  supportedLanguages?: unknown;
};

export type BookingRoomFilterSettingsReadModel = {
  bookingFilters?: unknown;
  customFilters?: unknown;
  filterRooms?: unknown;
};

export type BookingDesignSettingsReadModel = {
  headerLogo?: string | null;
  heroImage?: string | null;
  heroHeading?: string | null;
  heroSubtext?: string | null;
  primaryColor?: string | null;
  fontPairing?: string | null;
};

export type BookingLastMinuteTier = {
  daysBeforeMin: number;
  daysBeforeMax: number | null;
  discountPercent: number;
};

export type BookingLastMinuteSettingsReadModel = {
  lastMinuteDiscount?: unknown;
  updatedAt?: string | Date | null;
};

export type BookingHotelPropertyLinkReadModel = {
  propertyId: string;
  pmsProperty: boolean;
  financeProperty: boolean;
};

export type BookingPropertySettingsReadModel = {
  id: string;
  propertyId?: string | null;
  bookingHotelId?: string | null;
  slug?: string | null;
  propertyName?: string | null;
  reservationEmail?: string | null;
  phoneNumber?: string | null;
  whatsappNumber?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  defaultCurrency?: string | null;
  defaultLanguage?: string | null;
  supportedCurrencies?: unknown;
  supportedLanguages?: unknown;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  specialRequestsEnabled?: boolean | null;
  arrivalTimeEnabled?: boolean | null;
  guestCountEnabled?: boolean | null;
  cancellationPolicyText?: string | null;
  acceptedPaymentMethods?: unknown;
};

export type BookingAddonSettingsResponse = {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
};

export type BookingGuestFormSettingsResponse = {
  specialRequestsEnabled: boolean;
  arrivalTimeEnabled: boolean;
  guestCountEnabled: boolean;
  phoneRequired: boolean;
  adultAgeThreshold: number;
  childrenEnabled: boolean;
};

export type BookingBenefitsSettingsResponse = {
  benefits: string[];
};

export type BookingLocalizationSettingsResponse = {
  defaultCurrency: string;
  defaultLanguage: string;
  supportedCurrencies: string[];
  supportedLanguages: string[];
};

export type BookingRoomFilterSettingsResponse = {
  bookingFilters: string[];
  customFilters: Record<string, string>;
  filterRooms: Record<string, string[]>;
};

export type BookingDesignSettingsResponse = {
  headerLogo: string;
  heroImage: string;
  heroHeading: string;
  heroSubtext: string;
  primaryColor: string;
  fontPairing: string;
};

export type BookingLastMinuteSettingsResponse = {
  enabled: boolean;
  stackWithPromo: boolean;
  tiers: BookingLastMinuteTier[];
  updatedAt: string;
};

export type BookingHotelPropertyLinkResponse = {
  hotelId: string;
  propertyId: string;
  resourceLinks: {
    bookingHotel: true;
    pmsProperty: boolean;
    financeProperty: boolean;
  };
};

export type BookingPropertySettingsResponse = Record<string, unknown>;

export type BookingAddonSettings = BookingAddonSettingsResponse;
export type BookingGuestFormSettings = BookingGuestFormSettingsResponse;
export type BookingBenefitsSettings = BookingBenefitsSettingsResponse;
export type BookingLocalizationSettings = BookingLocalizationSettingsResponse;
export type BookingRoomFilterSettings = BookingRoomFilterSettingsResponse;
export type BookingDesignSettings = BookingDesignSettingsResponse;
export type BookingLastMinuteSettings = BookingLastMinuteSettingsResponse;

export type BookingSettingsReadRepository = {
  findPropertyLinkByHotelId?(hotelId: string): Promise<BookingHotelPropertyLinkReadModel | null>;
  findPropertySettingsByHotelId?(hotelId: string): Promise<BookingPropertySettingsReadModel | null>;
  findAddonSettingsByHotelId(hotelId: string): Promise<BookingAddonSettingsReadModel | null>;
  findGuestFormSettingsByHotelId(
    hotelId: string,
  ): Promise<BookingGuestFormSettingsReadModel | null>;
  findBenefitsSettingsByHotelId(hotelId: string): Promise<BookingBenefitsSettingsReadModel | null>;
  findLocalizationSettingsByHotelId(
    hotelId: string,
  ): Promise<BookingLocalizationSettingsReadModel | null>;
  findRoomFilterSettingsByHotelId?(
    hotelId: string,
  ): Promise<BookingRoomFilterSettingsReadModel | null>;
  findDesignSettingsByHotelId?(hotelId: string): Promise<BookingDesignSettingsReadModel | null>;
  findLastMinuteSettingsByHotelId?(
    hotelId: string,
  ): Promise<BookingLastMinuteSettingsReadModel | null>;
  close?(): Promise<void>;
};

export type UpdateBookingAddonSettingsBody = BookingAddonSettingsResponse;
export type UpdateBookingGuestFormSettingsBody = Omit<
  BookingGuestFormSettingsResponse,
  "phoneRequired"
> & {
  phoneRequired?: boolean;
};
export type UpdateBookingBenefitsSettingsBody = BookingBenefitsSettingsResponse;
export type UpdateBookingLocalizationSettingsBody = BookingLocalizationSettingsResponse;
export type UpdateBookingRoomFilterSettingsBody = BookingRoomFilterSettingsResponse;
export type UpdateBookingDesignSettingsBody = Partial<BookingDesignSettingsResponse>;
export type UpdateBookingLastMinuteSettingsBody = Omit<
  BookingLastMinuteSettingsResponse,
  "updatedAt"
>;

export type UpdateBookingPropertySettingsBody = {
  propertyName?: string;
  reservationEmail?: string | null;
  phoneNumber?: string | null;
  whatsappNumber?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  defaultCurrency?: string;
  defaultLanguage?: string;
  supportedCurrencies?: string[];
  supportedLanguages?: string[];
  checkInTime?: string | null;
  checkOutTime?: string | null;
  specialRequestsEnabled?: boolean;
  arrivalTimeEnabled?: boolean;
  guestCountEnabled?: boolean;
  cancellationPolicyText?: string | null;
  acceptedPaymentMethods?: string[];
};

export type BookingSettingsWriteRepository = {
  updatePropertySettingsByHotelId?(
    hotelId: string,
    settings: UpdateBookingPropertySettingsBody,
    organizationId: string,
  ): Promise<BookingPropertySettingsReadModel | null>;
  updateAddonSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingAddonSettingsBody,
  ): Promise<BookingAddonSettingsReadModel | null>;
  updateGuestFormSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingGuestFormSettingsBody,
  ): Promise<BookingGuestFormSettingsReadModel | null>;
  updateBenefitsSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingBenefitsSettingsBody,
  ): Promise<BookingBenefitsSettingsReadModel | null>;
  updateLocalizationSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingLocalizationSettingsBody,
  ): Promise<BookingLocalizationSettingsReadModel | null>;
  updateRoomFilterSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingRoomFilterSettingsBody,
  ): Promise<BookingRoomFilterSettingsReadModel | null>;
  updateDesignSettingsByHotelId?(
    hotelId: string,
    settings: UpdateBookingDesignSettingsBody,
  ): Promise<BookingDesignSettingsReadModel | null>;
  updateLastMinuteSettingsByHotelId?(
    hotelId: string,
    settings: UpdateBookingLastMinuteSettingsBody,
  ): Promise<BookingLastMinuteSettingsReadModel | null>;
  close?(): Promise<void>;
};

export type BookingSettingsRepository = BookingSettingsReadRepository &
  BookingSettingsWriteRepository;

export type BookingSettingsPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  connect?(): Promise<BookingSettingsQueryClient>;
  end(): Promise<void>;
};

type BookingSettingsQueryClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  release(): void;
};

export type BookingSettingsWriteErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "write_model";

export type BookingSettingsWriteErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_payload"
  | "private_contact_conflict"
  | "not_found"
  | "write_model_unavailable";

export type BookingSettingsWriteError = {
  statusCode: 401 | 403 | 404 | 409 | 422 | 500;
  code: BookingSettingsWriteErrorCode;
  category: BookingSettingsWriteErrorCategory;
  message: string;
  details?: unknown;
};

export type BookingAddonSettingsErrorCategory = "authentication" | "authorization" | "read_model";
export type BookingGuestFormSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingAddonSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export type BookingGuestFormSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export type BookingBenefitsSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingLocalizationSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingRoomFilterSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";
export type BookingLastMinuteSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingBenefitsSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable";

export type BookingLocalizationSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export type BookingRoomFilterSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable";
export type BookingLastMinuteSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export type BookingAddonSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingAddonSettingsErrorCode;
  category: BookingAddonSettingsErrorCategory;
  message: string;
};

export type BookingGuestFormSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingGuestFormSettingsErrorCode;
  category: BookingGuestFormSettingsErrorCategory;
  message: string;
};

export type BookingBenefitsSettingsError = {
  statusCode: 401 | 403 | 500;
  code: BookingBenefitsSettingsErrorCode;
  category: BookingBenefitsSettingsErrorCategory;
  message: string;
};

export type BookingLocalizationSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingLocalizationSettingsErrorCode;
  category: BookingLocalizationSettingsErrorCategory;
  message: string;
};

export type BookingRoomFilterSettingsError = {
  statusCode: 401 | 403 | 500;
  code: BookingRoomFilterSettingsErrorCode;
  category: BookingRoomFilterSettingsErrorCategory;
  message: string;
};

export type BookingLastMinuteSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingLastMinuteSettingsErrorCode;
  category: BookingLastMinuteSettingsErrorCategory;
  message: string;
};

export type BookingHotelPropertyLinkError = {
  statusCode: 401 | 403 | 404 | 500;
  code:
    | "unauthenticated"
    | "missing_permission"
    | "missing_entitlement"
    | "inactive_entitlement"
    | "missing_resource_access"
    | "not_found"
    | "read_model_unavailable";
  category: "authentication" | "authorization" | "read_model";
  message: string;
};

export type BookingAddonSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingGuestFormSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingBenefitsSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingLocalizationSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingRoomFilterSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingLastMinuteSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type UpdateBookingAddonSettingsRequest = BookingAddonSettingsRequest & {
  body: UpdateBookingAddonSettingsBody;
};

export type UpdateBookingGuestFormSettingsRequest = BookingGuestFormSettingsRequest & {
  body: UpdateBookingGuestFormSettingsBody;
};

export type UpdateBookingBenefitsSettingsRequest = BookingBenefitsSettingsRequest & {
  body: UpdateBookingBenefitsSettingsBody;
};

export type UpdateBookingLocalizationSettingsRequest = BookingLocalizationSettingsRequest & {
  body: UpdateBookingLocalizationSettingsBody;
};

export type UpdateBookingRoomFilterSettingsRequest = BookingRoomFilterSettingsRequest & {
  body: UpdateBookingRoomFilterSettingsBody;
};

export type UpdateBookingLastMinuteSettingsRequest = BookingLastMinuteSettingsRequest & {
  body: UpdateBookingLastMinuteSettingsBody;
};

export type UpdateBookingPropertySettingsRequest = BookingAddonSettingsRequest & {
  body: UpdateBookingPropertySettingsBody;
};

export type BookingAddonSettingsContract = {
  method: typeof BOOKING_ADDON_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_ADDON_SETTINGS_CONTRACT.path;
  request: BookingAddonSettingsRequest;
  response: BookingAddonSettingsResponse;
  error: BookingAddonSettingsError;
};

export type BookingGuestFormSettingsContract = {
  method: typeof BOOKING_GUEST_FORM_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_GUEST_FORM_SETTINGS_CONTRACT.path;
  request: BookingGuestFormSettingsRequest;
  response: BookingGuestFormSettingsResponse;
  error: BookingGuestFormSettingsError;
};

export type BookingBenefitsSettingsContract = {
  method: typeof BOOKING_BENEFITS_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_BENEFITS_SETTINGS_CONTRACT.path;
  request: BookingBenefitsSettingsRequest;
  response: BookingBenefitsSettingsResponse;
  error: BookingBenefitsSettingsError;
};

export type BookingLocalizationSettingsContract = {
  method: typeof BOOKING_LOCALIZATION_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_LOCALIZATION_SETTINGS_CONTRACT.path;
  request: BookingLocalizationSettingsRequest;
  response: BookingLocalizationSettingsResponse;
  error: BookingLocalizationSettingsError;
};

export type BookingRoomFilterSettingsContract = {
  method: typeof BOOKING_ROOM_FILTER_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_ROOM_FILTER_SETTINGS_CONTRACT.path;
  request: BookingRoomFilterSettingsRequest;
  response: BookingRoomFilterSettingsResponse;
  error: BookingRoomFilterSettingsError;
};

export type BookingLastMinuteSettingsContract = {
  method: typeof BOOKING_LAST_MINUTE_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_LAST_MINUTE_SETTINGS_CONTRACT.path;
  request: BookingLastMinuteSettingsRequest;
  response: BookingLastMinuteSettingsResponse;
  error: BookingLastMinuteSettingsError;
};

export type BookingHotelPropertyLinkContract = {
  method: typeof BOOKING_HOTEL_PROPERTY_LINK_CONTRACT.method;
  path: typeof BOOKING_HOTEL_PROPERTY_LINK_CONTRACT.path;
  request: BookingAddonSettingsRequest;
  response: BookingHotelPropertyLinkResponse;
  error: BookingHotelPropertyLinkError;
};

export type UpdateBookingAddonSettingsContract = {
  method: typeof BOOKING_ADDON_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_ADDON_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingAddonSettingsRequest;
  response: BookingAddonSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingGuestFormSettingsContract = {
  method: typeof BOOKING_GUEST_FORM_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_GUEST_FORM_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingGuestFormSettingsRequest;
  response: BookingGuestFormSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingBenefitsSettingsContract = {
  method: typeof BOOKING_BENEFITS_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_BENEFITS_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingBenefitsSettingsRequest;
  response: BookingBenefitsSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingLocalizationSettingsContract = {
  method: typeof BOOKING_LOCALIZATION_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_LOCALIZATION_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingLocalizationSettingsRequest;
  response: BookingLocalizationSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingRoomFilterSettingsContract = {
  method: typeof BOOKING_ROOM_FILTER_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_ROOM_FILTER_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingRoomFilterSettingsRequest;
  response: BookingRoomFilterSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingLastMinuteSettingsContract = {
  method: typeof BOOKING_LAST_MINUTE_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_LAST_MINUTE_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingLastMinuteSettingsRequest;
  response: BookingLastMinuteSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingPropertySettingsContract = {
  method: typeof BOOKING_PROPERTY_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_PROPERTY_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingPropertySettingsRequest;
  response: BookingPropertySettingsResponse;
  error: BookingSettingsWriteError;
};

type BookingHotelParams = {
  hotelId: string;
};

type BookingAddonSettingsRow = {
  show_addons_step: boolean | null;
  group_addons_by_category: boolean | null;
};

type BookingGuestFormSettingsRow = {
  special_requests_enabled: boolean | null;
  arrival_time_enabled: boolean | null;
  guest_count_enabled: boolean | null;
  phone_required?: boolean | null;
  adult_age_threshold?: number | null;
  children_enabled?: boolean | null;
};

type BookingBenefitsSettingsRow = {
  benefits: unknown;
};

type BookingLocalizationSettingsRow = {
  currency: string | null;
  default_language: string | null;
  supported_currencies: unknown;
  supported_languages: unknown;
};

type BookingRoomFilterSettingsRow = {
  booking_filters: unknown;
  custom_filters: unknown;
  filter_rooms: unknown;
};

type BookingLastMinuteSettingsRow = {
  updated_at: string | Date | null;
};

type TargetBookingSettingsRow = {
  show_addons_step: boolean | null;
  group_addons_by_category: boolean | null;
  special_requests_enabled: boolean | null;
  arrival_time_enabled: boolean | null;
  guest_count_enabled: boolean | null;
  phone_required: boolean | null;
  adult_age_threshold: number | null;
  children_enabled: boolean | null;
  benefits: unknown;
  default_currency: string | null;
  default_language: string | null;
  supported_currencies: unknown;
  supported_languages: unknown;
  booking_filters: unknown;
  custom_filters: unknown;
  filter_rooms: unknown;
  header_logo_url: string | null;
  hero_image_url: string | null;
  hero_heading: string | null;
  hero_subtext: string | null;
  primary_color: string | null;
  font_pairing: string | null;
  last_minute_discount: unknown;
  updated_at: string | Date | null;
};

type TargetBookingSettingsQueryRow = TargetBookingSettingsRow & {
  settings_property_id: string | null;
  source_link_count: number | string;
};

type TargetBookingPropertySettingsRow = TargetBookingSettingsRow & {
  source_link_count: number | string;
  id: string;
  property_id: string;
  booking_hotel_id: string | null;
  slug: string | null;
  property_name: string | null;
  reservation_email: string | null;
  phone_number: string | null;
  whatsapp_number: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  instagram: string | null;
  facebook: string | null;
  check_in_time: string | null;
  check_out_time: string | null;
  cancellation_policy_text: string | null;
  accepted_payment_methods: unknown;
};

const DEFAULT_LAST_MINUTE_SETTINGS: UpdateBookingLastMinuteSettingsBody = {
  enabled: false,
  stackWithPromo: false,
  tiers: [],
};

const BOOKING_FONT_PAIRINGS = new Set([
  "high-end-serif",
  "modern-minimalist",
  "grand-classic",
  "imperial-serif",
  "italiana-serif",
]);

type TargetBookingPropertyLinkQueryRow = {
  source_link_count: number | string;
  propertyId: string | null;
  pmsProperty: boolean;
  financeProperty: boolean;
};

type TargetBookingPropertySettingsUpdateRow = {
  source_link_count: number | string;
  id: string | null;
  propertyId: string | null;
  privateContactConflict: boolean;
};

type TargetBookingPropertyWriteTargetRow = {
  source_link_count: number | string;
  propertyId: string | null;
};

export class BookingContactPublicationConflictError extends Error {
  constructor() {
    super(
      "That contact is stored as private hotel information. Publish it from Hotel setup or use a different Booking contact.",
    );
    this.name = "BookingContactPublicationConflictError";
  }
}

const TARGET_BOOKING_SETTINGS_SOURCE_LINK_CTE = `
  WITH scoped_property_candidates AS (
    SELECT property.id AS property_id
    FROM hotel_catalog.properties property
    WHERE property.id::text = $1
    UNION
    SELECT property_id
    FROM hotel_catalog.property_source_links
    WHERE source_system = 'booking'
      AND source_table = 'booking_hotels'
      AND source_id = $1
      AND relationship = 'canonical_input'
      AND status = 'active'
  ),
  source_link_status AS (
    SELECT count(*)::int AS source_link_count,
           min(property_id::text)::uuid AS property_id
    FROM scoped_property_candidates
  )
`;

const TARGET_BOOKING_PROPERTY_LINK_SELECT = `
  ${TARGET_BOOKING_SETTINGS_SOURCE_LINK_CTE}
  SELECT
    source_link_status.source_link_count,
    source_link_status.property_id::text AS "propertyId",
    EXISTS (
      SELECT 1
      FROM hotel_catalog.property_source_links pms_link
      WHERE pms_link.property_id = source_link_status.property_id
        AND pms_link.source_system = 'pms'
        AND pms_link.status = 'active'
    ) AS "pmsProperty",
    EXISTS (
      SELECT 1
      FROM finance.payment_settings payment_settings
      WHERE payment_settings.property_id = source_link_status.property_id
    ) AS "financeProperty"
  FROM source_link_status
  WHERE source_link_status.source_link_count > 0
`;

const TARGET_BOOKING_PROPERTY_SETTINGS_SELECT = `
  ${TARGET_BOOKING_SETTINGS_SOURCE_LINK_CTE}
  SELECT
    source_link_status.source_link_count,
    COALESCE(booking_source.source_id, property.id::text) AS id,
    property.id::text AS property_id,
    booking_source.source_id AS booking_hotel_id,
    slug.slug,
    property.display_name AS property_name,
    contact.reservation_email,
    contact.phone_number,
    contact.whatsapp_number,
    contact.instagram,
    contact.facebook,
    COALESCE(
      NULLIF(location.raw_marketplace_location, ''),
      NULLIF(
        concat_ws(
          ', ',
          NULLIF(location.street_address, ''),
          NULLIF(location.city, ''),
          NULLIF(location.region, ''),
          NULLIF(location.postal_code, ''),
          NULLIF(location.country_code, '')
        ),
        ''
      )
    ) AS address,
    location.city,
    location.country_code AS country,
    to_char(policy.check_in_time, 'HH24:MI') AS check_in_time,
    to_char(policy.check_out_time, 'HH24:MI') AS check_out_time,
    policy.cancellation_summary AS cancellation_policy_text,
    settings.show_addons_step,
    settings.group_addons_by_category,
    settings.special_requests_enabled,
    settings.arrival_time_enabled,
    settings.guest_count_enabled,
    settings.phone_required,
    settings.adult_age_threshold,
    settings.children_enabled,
    settings.benefits,
    settings.default_currency,
    settings.default_language,
    settings.supported_currencies,
    settings.supported_languages,
    settings.booking_filters,
    settings.custom_filters,
    settings.filter_rooms,
    settings.header_logo_url,
    settings.hero_image_url,
    settings.hero_heading,
    settings.hero_subtext,
    settings.primary_color,
    settings.font_pairing,
    settings.last_minute_discount,
    settings.updated_at,
    finance.accepted_methods AS accepted_payment_methods
  FROM source_link_status
  JOIN hotel_catalog.properties property
    ON property.id = source_link_status.property_id
  LEFT JOIN LATERAL (
    SELECT source_link.source_id
    FROM hotel_catalog.property_source_links source_link
    WHERE source_link.property_id = property.id
      AND source_link.source_system = 'booking'
      AND source_link.source_table = 'booking_hotels'
      AND source_link.relationship = 'canonical_input'
      AND source_link.status = 'active'
    ORDER BY source_link.updated_at DESC, source_link.source_id
    LIMIT 1
  ) booking_source ON TRUE
  LEFT JOIN LATERAL (
    SELECT property_slug.slug
    FROM hotel_catalog.property_slugs property_slug
    WHERE property_slug.property_id = property.id
      AND property_slug.purpose = 'canonical'
      AND property_slug.status = 'active'
    ORDER BY property_slug.updated_at DESC, property_slug.id
    LIMIT 1
  ) slug ON TRUE
  LEFT JOIN hotel_catalog.property_locations location
    ON location.property_id = property.id
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(
        max(value) FILTER (WHERE channel_type = 'email' AND source_system = 'booking'),
        max(value) FILTER (WHERE channel_type = 'email')
      ) AS reservation_email,
      COALESCE(
        max(value) FILTER (WHERE channel_type = 'phone' AND source_system = 'booking'),
        max(value) FILTER (WHERE channel_type = 'phone')
      ) AS phone_number,
      COALESCE(
        max(value) FILTER (WHERE channel_type = 'whatsapp' AND source_system = 'booking'),
        max(value) FILTER (WHERE channel_type = 'whatsapp')
      ) AS whatsapp_number,
      COALESCE(
        max(value) FILTER (WHERE channel_type = 'instagram' AND source_system = 'booking'),
        max(value) FILTER (WHERE channel_type = 'instagram')
      ) AS instagram,
      COALESCE(
        max(value) FILTER (WHERE channel_type = 'facebook' AND source_system = 'booking'),
        max(value) FILTER (WHERE channel_type = 'facebook')
      ) AS facebook
    FROM hotel_catalog.property_contact_channels
    WHERE property_id = property.id
      AND is_public = TRUE
  ) contact ON TRUE
  LEFT JOIN hotel_catalog.property_policy_summaries policy
    ON policy.property_id = property.id
  LEFT JOIN booking.booking_settings settings
    ON settings.property_id = property.id
  LEFT JOIN finance.payment_settings finance
    ON finance.property_id = property.id
  WHERE source_link_status.source_link_count > 0
`;

const TARGET_BOOKING_SETTINGS_SELECT = `
  ${TARGET_BOOKING_SETTINGS_SOURCE_LINK_CTE}
  SELECT
    source_link_status.source_link_count,
    settings.property_id::text AS settings_property_id,
    settings.show_addons_step,
    settings.group_addons_by_category,
    settings.special_requests_enabled,
    settings.arrival_time_enabled,
    settings.guest_count_enabled,
    settings.phone_required,
    settings.adult_age_threshold,
    settings.children_enabled,
    settings.benefits,
    settings.default_currency,
    settings.default_language,
    settings.supported_currencies,
    settings.supported_languages,
    settings.booking_filters,
    settings.custom_filters,
    settings.filter_rooms,
    settings.header_logo_url,
    settings.hero_image_url,
    settings.hero_heading,
    settings.hero_subtext,
    settings.primary_color,
    settings.font_pairing,
    settings.last_minute_discount,
    settings.updated_at
  FROM source_link_status
  LEFT JOIN booking.booking_settings settings
    ON source_link_status.source_link_count = 1
   AND settings.property_id = source_link_status.property_id
  WHERE source_link_status.source_link_count > 0
`;

// Booking design is guest-facing presentation owned by Booking. Canonical
// Catalog descriptions and media are edited through the revisioned profile API.
const TARGET_BOOKING_DESIGN_SETTINGS_UPDATE = `
  ${TARGET_BOOKING_SETTINGS_SOURCE_LINK_CTE},
  updated_settings AS (
    UPDATE booking.booking_settings settings
    SET header_logo_url = CASE
          WHEN $2::jsonb ? 'headerLogo'
            THEN NULLIF(BTRIM($2::jsonb ->> 'headerLogo'), '')
          ELSE settings.header_logo_url
        END,
        hero_image_url = CASE
          WHEN $2::jsonb ? 'heroImage'
            THEN NULLIF(BTRIM($2::jsonb ->> 'heroImage'), '')
          ELSE settings.hero_image_url
        END,
        hero_heading = CASE
          WHEN $2::jsonb ? 'heroHeading'
            THEN NULLIF(BTRIM($2::jsonb ->> 'heroHeading'), '')
          ELSE settings.hero_heading
        END,
        hero_subtext = CASE
          WHEN $2::jsonb ? 'heroSubtext'
            THEN NULLIF(BTRIM($2::jsonb ->> 'heroSubtext'), '')
          ELSE settings.hero_subtext
        END,
        primary_color = CASE
          WHEN $2::jsonb ? 'primaryColor' THEN $2::jsonb ->> 'primaryColor'
          ELSE settings.primary_color
        END,
        font_pairing = CASE
          WHEN $2::jsonb ? 'fontPairing' THEN $2::jsonb ->> 'fontPairing'
          ELSE settings.font_pairing
        END,
        updated_at = now()
    FROM source_link_status
    WHERE source_link_status.source_link_count = 1
      AND settings.property_id = source_link_status.property_id
    RETURNING
      settings.property_id::text AS settings_property_id,
      settings.show_addons_step,
      settings.group_addons_by_category,
      settings.special_requests_enabled,
      settings.arrival_time_enabled,
      settings.guest_count_enabled,
      settings.phone_required,
      settings.adult_age_threshold,
      settings.children_enabled,
      settings.benefits,
      settings.default_currency,
      settings.default_language,
      settings.supported_currencies,
      settings.supported_languages,
      settings.booking_filters,
      settings.custom_filters,
      settings.filter_rooms,
      settings.header_logo_url,
      settings.hero_image_url,
      settings.hero_heading,
      settings.hero_subtext,
      settings.primary_color,
      settings.font_pairing,
      settings.last_minute_discount,
      settings.updated_at
  )
  SELECT
    source_link_status.source_link_count,
    updated_settings.settings_property_id,
    updated_settings.show_addons_step,
    updated_settings.group_addons_by_category,
    updated_settings.special_requests_enabled,
    updated_settings.arrival_time_enabled,
    updated_settings.guest_count_enabled,
    updated_settings.phone_required,
    updated_settings.adult_age_threshold,
    updated_settings.children_enabled,
    updated_settings.benefits,
    updated_settings.default_currency,
    updated_settings.default_language,
    updated_settings.supported_currencies,
    updated_settings.supported_languages,
    updated_settings.booking_filters,
    updated_settings.custom_filters,
    updated_settings.filter_rooms,
    updated_settings.header_logo_url,
    updated_settings.hero_image_url,
    updated_settings.hero_heading,
    updated_settings.hero_subtext,
    updated_settings.primary_color,
    updated_settings.font_pairing,
    updated_settings.last_minute_discount,
    updated_settings.updated_at
  FROM source_link_status
  LEFT JOIN updated_settings ON TRUE
  WHERE source_link_status.source_link_count > 0
`;

const TARGET_BOOKING_PROPERTY_SETTINGS_UPDATE = `
  ${TARGET_BOOKING_SETTINGS_SOURCE_LINK_CTE},
  target_property AS (
    SELECT source_link_status.property_id
    FROM source_link_status
    WHERE source_link_status.source_link_count = 1
      AND source_link_status.property_id IS NOT NULL
  ),
  contact_input AS (
    SELECT target_property.property_id, contact.channel_type, contact.value
    FROM target_property
    JOIN jsonb_to_recordset($2::jsonb) AS contact(channel_type text, value text) ON TRUE
  ),
  private_contact_conflict AS (
    SELECT EXISTS (
      SELECT 1
      FROM contact_input
      JOIN hotel_catalog.property_contact_channels existing
        ON existing.property_id = contact_input.property_id
       AND existing.channel_type = contact_input.channel_type
       AND existing.value = contact_input.value
      WHERE existing.source_system <> 'booking'
        AND existing.is_public = FALSE
    ) AS found
  ),
  writable_target AS (
    SELECT target_property.property_id
    FROM target_property, private_contact_conflict
    WHERE private_contact_conflict.found = FALSE
  ),
  updated_property AS (
    UPDATE hotel_catalog.properties property
    SET profile_revision = property.profile_revision + 1,
        updated_at = now()
    FROM writable_target
    WHERE property.id = writable_target.property_id
    RETURNING property.id
  ),
  deleted_contacts AS (
    DELETE FROM hotel_catalog.property_contact_channels contact
    USING writable_target
    WHERE contact.property_id = writable_target.property_id
      AND contact.source_system = 'booking'
      AND EXISTS (
        SELECT 1
        FROM jsonb_to_recordset($2::jsonb) AS input(channel_type text, value text)
        WHERE input.channel_type = contact.channel_type
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_to_recordset($2::jsonb) AS input(channel_type text, value text)
        WHERE input.channel_type = contact.channel_type
          AND input.value = contact.value
          AND NULLIF(input.value, '') IS NOT NULL
      )
    RETURNING contact.property_id
  ),
  writable_contact_input AS (
    SELECT contact_input.*
    FROM contact_input
    JOIN writable_target USING (property_id)
  ),
  upserted_contacts AS (
    INSERT INTO hotel_catalog.property_contact_channels (
      property_id,
      channel_type,
      value,
      is_public,
      source_system,
      updated_at
    )
    SELECT
      writable_contact_input.property_id,
      writable_contact_input.channel_type,
      writable_contact_input.value,
      TRUE,
      'booking',
      now()
    FROM writable_contact_input
    WHERE NULLIF(writable_contact_input.value, '') IS NOT NULL
    ON CONFLICT (property_id, channel_type, value) DO UPDATE
    SET is_public = TRUE,
        updated_at = now()
    WHERE hotel_catalog.property_contact_channels.source_system = 'booking'
    RETURNING property_id
  ),
  upserted_policy AS (
    INSERT INTO hotel_catalog.property_policy_summaries (
      property_id,
      check_in_time,
      check_out_time,
      cancellation_summary,
      policy_source_owner,
      updated_at
    )
    SELECT
      writable_target.property_id,
      NULLIF($3::text, '')::time,
      NULLIF($4::text, '')::time,
      $5,
      'booking',
      now()
    FROM writable_target
    ON CONFLICT (property_id) DO UPDATE
    SET check_in_time = EXCLUDED.check_in_time,
        check_out_time = EXCLUDED.check_out_time,
        cancellation_summary = EXCLUDED.cancellation_summary,
        policy_source_owner = EXCLUDED.policy_source_owner,
        updated_at = now()
    RETURNING property_id
  ),
  upserted_booking_settings AS (
    INSERT INTO booking.booking_settings (
      property_id,
      default_currency,
      default_language,
      supported_currencies,
      supported_languages,
      special_requests_enabled,
      arrival_time_enabled,
      guest_count_enabled,
      updated_at
    )
    SELECT
      writable_target.property_id,
      $7,
      $6,
      $8::text[],
      $9::text[],
      $10,
      $11,
      $12,
      now()
    FROM writable_target
    ON CONFLICT (property_id) DO UPDATE
    SET default_currency = EXCLUDED.default_currency,
        default_language = EXCLUDED.default_language,
        supported_currencies = EXCLUDED.supported_currencies,
        supported_languages = EXCLUDED.supported_languages,
        special_requests_enabled = EXCLUDED.special_requests_enabled,
        arrival_time_enabled = EXCLUDED.arrival_time_enabled,
        guest_count_enabled = EXCLUDED.guest_count_enabled,
        updated_at = now()
    RETURNING property_id
  )
  SELECT source_link_status.source_link_count,
         target_property.property_id::text AS "propertyId",
         private_contact_conflict.found AS "privateContactConflict",
         COALESCE(booking_source.source_id, target_property.property_id::text) AS id
  FROM source_link_status
  LEFT JOIN target_property ON TRUE
  CROSS JOIN private_contact_conflict
  LEFT JOIN LATERAL (
    SELECT source_link.source_id
    FROM hotel_catalog.property_source_links source_link
    WHERE source_link.property_id = target_property.property_id
      AND source_link.source_system = 'booking'
      AND source_link.source_table = 'booking_hotels'
      AND source_link.relationship = 'canonical_input'
      AND source_link.status = 'active'
    ORDER BY source_link.updated_at DESC, source_link.source_id
    LIMIT 1
  ) booking_source ON TRUE
  WHERE source_link_status.source_link_count > 0
`;

const TARGET_BOOKING_PROPERTY_WRITE_TARGET = `
  ${TARGET_BOOKING_SETTINGS_SOURCE_LINK_CTE}
  SELECT
    source_link_status.source_link_count,
    source_link_status.property_id::text AS "propertyId"
  FROM source_link_status
  WHERE source_link_status.source_link_count > 0
`;

function toTargetAddonSettings(row: TargetBookingSettingsRow): BookingAddonSettingsReadModel {
  return {
    showAddonsStep: row.show_addons_step,
    groupAddonsByCategory: row.group_addons_by_category,
  };
}

function toTargetGuestFormSettings(
  row: TargetBookingSettingsRow,
): BookingGuestFormSettingsReadModel {
  return {
    specialRequestsEnabled: row.special_requests_enabled,
    arrivalTimeEnabled: row.arrival_time_enabled,
    guestCountEnabled: row.guest_count_enabled,
    phoneRequired: row.phone_required,
    adultAgeThreshold: row.adult_age_threshold,
    childrenEnabled: row.children_enabled,
  };
}

function toTargetBenefitsSettings(row: TargetBookingSettingsRow): BookingBenefitsSettingsReadModel {
  return {
    benefits: row.benefits,
  };
}

function toTargetLocalizationSettings(
  row: TargetBookingSettingsRow,
): BookingLocalizationSettingsReadModel {
  return {
    defaultCurrency: row.default_currency,
    defaultLanguage: row.default_language,
    supportedCurrencies: row.supported_currencies,
    supportedLanguages: row.supported_languages,
  };
}

function toTargetRoomFilterSettings(
  row: TargetBookingSettingsRow,
): BookingRoomFilterSettingsReadModel {
  return {
    bookingFilters: row.booking_filters,
    customFilters: row.custom_filters,
    filterRooms: row.filter_rooms,
  };
}

function toTargetDesignSettings(row: TargetBookingSettingsRow): BookingDesignSettingsReadModel {
  return {
    headerLogo: row.header_logo_url,
    heroImage: row.hero_image_url,
    heroHeading: row.hero_heading,
    heroSubtext: row.hero_subtext,
    primaryColor: row.primary_color,
    fontPairing: row.font_pairing,
  };
}

function toTargetLastMinuteSettings(
  row: TargetBookingSettingsRow,
): BookingLastMinuteSettingsReadModel {
  return {
    lastMinuteDiscount: row.last_minute_discount,
    updatedAt: row.updated_at,
  };
}

function toTargetPropertySettings(
  row: TargetBookingPropertySettingsRow,
): BookingPropertySettingsReadModel {
  return {
    id: row.id,
    propertyId: row.property_id,
    bookingHotelId: row.booking_hotel_id,
    slug: row.slug,
    propertyName: row.property_name,
    reservationEmail: row.reservation_email,
    phoneNumber: row.phone_number,
    whatsappNumber: row.whatsapp_number,
    address: row.address,
    city: row.city,
    country: row.country,
    instagram: row.instagram,
    facebook: row.facebook,
    defaultCurrency: row.default_currency,
    defaultLanguage: row.default_language,
    supportedCurrencies: row.supported_currencies,
    supportedLanguages: row.supported_languages,
    checkInTime: row.check_in_time,
    checkOutTime: row.check_out_time,
    specialRequestsEnabled: row.special_requests_enabled,
    arrivalTimeEnabled: row.arrival_time_enabled,
    guestCountEnabled: row.guest_count_enabled,
    cancellationPolicyText: row.cancellation_policy_text,
    acceptedPaymentMethods: row.accepted_payment_methods,
  };
}

function targetPropertySettingsWriteValues(
  current: BookingPropertySettingsReadModel,
  update: UpdateBookingPropertySettingsBody,
): readonly unknown[] {
  const defaultLanguage = update.defaultLanguage ?? current.defaultLanguage ?? "en";
  const supportedLanguages = withoutDefaultCode(
    update.supportedLanguages ?? parseStringList(current.supportedLanguages, []),
    defaultLanguage,
  );
  const defaultCurrency = update.defaultCurrency ?? current.defaultCurrency ?? "EUR";
  const supportedCurrencies = withoutDefaultCode(
    update.supportedCurrencies ?? parseStringList(current.supportedCurrencies, []),
    defaultCurrency,
  );
  const contacts = targetPropertyContactInputs(update);

  return [
    JSON.stringify(contacts),
    nullableText(update.checkInTime !== undefined ? update.checkInTime : current.checkInTime),
    nullableText(update.checkOutTime !== undefined ? update.checkOutTime : current.checkOutTime),
    nullableText(
      update.cancellationPolicyText !== undefined
        ? update.cancellationPolicyText
        : current.cancellationPolicyText,
    ),
    defaultLanguage,
    defaultCurrency,
    supportedCurrencies,
    supportedLanguages,
    update.specialRequestsEnabled ?? current.specialRequestsEnabled ?? true,
    update.arrivalTimeEnabled ?? current.arrivalTimeEnabled ?? false,
    update.guestCountEnabled ?? current.guestCountEnabled ?? false,
  ];
}

function targetPropertyContactInputs(input: {
  reservationEmail?: string | null;
  phoneNumber?: string | null;
  whatsappNumber?: string | null;
  instagram?: string | null;
  facebook?: string | null;
}): { channel_type: string; value: string }[] {
  const contacts: [keyof typeof input, string][] = [
    ["reservationEmail", "email"],
    ["phoneNumber", "phone"],
    ["whatsappNumber", "whatsapp"],
    ["instagram", "instagram"],
    ["facebook", "facebook"],
  ];

  return contacts.flatMap(([field, channelType]) => {
    if (input[field] === undefined) return [];
    return [{ channel_type: channelType, value: nullableText(input[field]) ?? "" }];
  });
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function withoutDefaultCode(codes: readonly string[], defaultCode: string): string[] {
  return [...new Set(codes.map((code) => code.trim()).filter(Boolean))].filter(
    (code) => code !== defaultCode,
  );
}

export function createPgBookingSettingsReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingSettingsPool;
}): BookingSettingsRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Booking settings repository connectionString must not be empty");
  }

  const pool = (config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    })) as BookingSettingsPool;

  return {
    async findAddonSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingAddonSettingsRow>(
        `SELECT show_addons_step, group_addons_by_category
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        showAddonsStep: row.show_addons_step,
        groupAddonsByCategory: row.group_addons_by_category,
      };
    },
    async findGuestFormSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingGuestFormSettingsRow>(
        `SELECT special_requests_enabled,
                arrival_time_enabled,
                guest_count_enabled,
                phone_required
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        specialRequestsEnabled: row.special_requests_enabled,
        arrivalTimeEnabled: row.arrival_time_enabled,
        guestCountEnabled: row.guest_count_enabled,
        phoneRequired: row.phone_required,
        adultAgeThreshold: 18,
        childrenEnabled: true,
      };
    },
    async findBenefitsSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingBenefitsSettingsRow>(
        `SELECT benefits
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        benefits: row.benefits,
      };
    },
    async findLocalizationSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingLocalizationSettingsRow>(
        `SELECT currency, default_language, supported_currencies, supported_languages
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        defaultCurrency: row.currency,
        defaultLanguage: row.default_language,
        supportedCurrencies: row.supported_currencies,
        supportedLanguages: row.supported_languages,
      };
    },
    async findRoomFilterSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingRoomFilterSettingsRow>(
        `SELECT booking_filters, custom_filters, filter_rooms
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        bookingFilters: row.booking_filters,
        customFilters: row.custom_filters,
        filterRooms: row.filter_rooms,
      };
    },
    async findLastMinuteSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingLastMinuteSettingsRow>(
        `SELECT updated_at
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        lastMinuteDiscount: DEFAULT_LAST_MINUTE_SETTINGS,
        updatedAt: row.updated_at,
      };
    },
    async updateAddonSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingAddonSettingsRow>(
        `UPDATE booking_hotels
         SET show_addons_step = $2,
             group_addons_by_category = $3
         WHERE id = $1
         RETURNING show_addons_step, group_addons_by_category`,
        [hotelId, settings.showAddonsStep, settings.groupAddonsByCategory],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        showAddonsStep: row.show_addons_step,
        groupAddonsByCategory: row.group_addons_by_category,
      };
    },
    async updateGuestFormSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingGuestFormSettingsRow>(
        `UPDATE booking_hotels
         SET special_requests_enabled = $2,
             arrival_time_enabled = $3,
             guest_count_enabled = $4,
             phone_required = COALESCE($5, phone_required)
         WHERE id = $1
         RETURNING special_requests_enabled,
                   arrival_time_enabled,
                   guest_count_enabled,
                   phone_required`,
        [
          hotelId,
          settings.specialRequestsEnabled,
          settings.arrivalTimeEnabled,
          settings.guestCountEnabled,
          settings.phoneRequired ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        specialRequestsEnabled: row.special_requests_enabled,
        arrivalTimeEnabled: row.arrival_time_enabled,
        guestCountEnabled: row.guest_count_enabled,
        phoneRequired: row.phone_required,
        adultAgeThreshold: 18,
        childrenEnabled: true,
      };
    },
    async updateBenefitsSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingBenefitsSettingsRow>(
        `UPDATE booking_hotels
         SET benefits = $2::jsonb
         WHERE id = $1
         RETURNING benefits`,
        [hotelId, JSON.stringify(settings.benefits)],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        benefits: row.benefits,
      };
    },
    async updateLocalizationSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingLocalizationSettingsRow>(
        `UPDATE booking_hotels
         SET currency = $2,
             default_language = $3,
             supported_currencies = $4::jsonb,
             supported_languages = $5::jsonb
         WHERE id = $1
         RETURNING currency, default_language, supported_currencies, supported_languages`,
        [
          hotelId,
          settings.defaultCurrency,
          settings.defaultLanguage,
          JSON.stringify(settings.supportedCurrencies),
          JSON.stringify(settings.supportedLanguages),
        ],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        defaultCurrency: row.currency,
        defaultLanguage: row.default_language,
        supportedCurrencies: row.supported_currencies,
        supportedLanguages: row.supported_languages,
      };
    },
    async updateRoomFilterSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingRoomFilterSettingsRow>(
        `UPDATE booking_hotels
         SET booking_filters = $2::jsonb,
             custom_filters = $3::jsonb,
             filter_rooms = $4::jsonb
         WHERE id = $1
         RETURNING booking_filters, custom_filters, filter_rooms`,
        [
          hotelId,
          JSON.stringify(settings.bookingFilters),
          JSON.stringify(settings.customFilters),
          JSON.stringify(settings.filterRooms),
        ],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        bookingFilters: row.booking_filters,
        customFilters: row.custom_filters,
        filterRooms: row.filter_rooms,
      };
    },
    async updateLastMinuteSettingsByHotelId() {
      return null;
    },
    async close() {
      await pool.end();
    },
  };
}

export function createPgTargetBookingSettingsRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingSettingsPool;
}): BookingSettingsRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Target booking settings repository connectionString must not be empty");
  }

  const pool = (config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    })) as BookingSettingsPool;

  function toSingleSettingsRow(
    result: Pick<QueryResult<TargetBookingSettingsQueryRow>, "rows">,
    hotelId: string,
  ): TargetBookingSettingsRow | null {
    const row = result.rows[0];
    if (!row) return null;

    if (Number(row.source_link_count) > 1) {
      throw new Error(
        `Duplicate active canonical booking hotel source links found for booking hotel ${hotelId}`,
      );
    }

    return row.settings_property_id ? row : null;
  }

  async function findSettings(hotelId: string): Promise<TargetBookingSettingsRow | null> {
    const result = await pool.query<TargetBookingSettingsQueryRow>(TARGET_BOOKING_SETTINGS_SELECT, [
      hotelId,
    ]);
    return toSingleSettingsRow(result, hotelId);
  }

  async function findPropertyLink(
    hotelId: string,
  ): Promise<BookingHotelPropertyLinkReadModel | null> {
    const result = await pool.query<TargetBookingPropertyLinkQueryRow>(
      TARGET_BOOKING_PROPERTY_LINK_SELECT,
      [hotelId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (Number(row.source_link_count) > 1) {
      throw new Error(
        `Duplicate active canonical booking hotel source links found for booking hotel ${hotelId}`,
      );
    }
    if (!row.propertyId) return null;
    return {
      propertyId: row.propertyId,
      pmsProperty: row.pmsProperty,
      financeProperty: row.financeProperty,
    };
  }

  async function findPropertySettings(
    hotelId: string,
    executor: Pick<BookingSettingsPool, "query"> = pool,
  ): Promise<BookingPropertySettingsReadModel | null> {
    const result = await executor.query<TargetBookingPropertySettingsRow>(
      TARGET_BOOKING_PROPERTY_SETTINGS_SELECT,
      [hotelId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (Number(row.source_link_count) > 1) {
      throw new Error(
        `Duplicate active canonical booking hotel source links found for booking hotel ${hotelId}`,
      );
    }
    return toTargetPropertySettings(row);
  }

  async function updateSettings(
    hotelId: string,
    setClause: string,
    values: readonly unknown[],
  ): Promise<TargetBookingSettingsRow | null> {
    const result = await pool.query<TargetBookingSettingsQueryRow>(
      `
        ${TARGET_BOOKING_SETTINGS_SOURCE_LINK_CTE},
        updated_settings AS (
        UPDATE booking.booking_settings settings
        SET ${setClause},
            updated_at = now()
        FROM source_link_status
        WHERE source_link_status.source_link_count = 1
          AND settings.property_id = source_link_status.property_id
        RETURNING
          settings.property_id::text AS settings_property_id,
          settings.show_addons_step,
          settings.group_addons_by_category,
          settings.special_requests_enabled,
          settings.arrival_time_enabled,
          settings.guest_count_enabled,
          settings.phone_required,
          settings.adult_age_threshold,
          settings.children_enabled,
          settings.benefits,
          settings.default_currency,
          settings.default_language,
          settings.supported_currencies,
          settings.supported_languages,
          settings.booking_filters,
          settings.custom_filters,
          settings.filter_rooms,
          settings.header_logo_url,
          settings.hero_image_url,
          settings.hero_heading,
          settings.hero_subtext,
          settings.primary_color,
          settings.font_pairing,
          settings.last_minute_discount,
          settings.updated_at
        )
        SELECT
          source_link_status.source_link_count,
          updated_settings.settings_property_id,
          updated_settings.show_addons_step,
          updated_settings.group_addons_by_category,
          updated_settings.special_requests_enabled,
          updated_settings.arrival_time_enabled,
          updated_settings.guest_count_enabled,
          updated_settings.phone_required,
          updated_settings.adult_age_threshold,
          updated_settings.children_enabled,
          updated_settings.benefits,
          updated_settings.default_currency,
          updated_settings.default_language,
          updated_settings.supported_currencies,
          updated_settings.supported_languages,
          updated_settings.booking_filters,
          updated_settings.custom_filters,
          updated_settings.filter_rooms,
          updated_settings.header_logo_url,
          updated_settings.hero_image_url,
          updated_settings.hero_heading,
          updated_settings.hero_subtext,
          updated_settings.primary_color,
          updated_settings.font_pairing,
          updated_settings.last_minute_discount,
          updated_settings.updated_at
        FROM source_link_status
        LEFT JOIN updated_settings ON TRUE
        WHERE source_link_status.source_link_count > 0
      `,
      [hotelId, ...values],
    );
    return toSingleSettingsRow(result, hotelId);
  }

  return {
    async findPropertyLinkByHotelId(hotelId) {
      return findPropertyLink(hotelId);
    },
    async findPropertySettingsByHotelId(hotelId) {
      return findPropertySettings(hotelId);
    },
    async updatePropertySettingsByHotelId(hotelId, settings, organizationId) {
      if (!pool.connect) {
        throw new Error("Booking property settings writes require a transactional database pool.");
      }
      const transaction = await pool.connect();
      try {
        await transaction.query("BEGIN");
        const targetResult = await transaction.query<TargetBookingPropertyWriteTargetRow>(
          TARGET_BOOKING_PROPERTY_WRITE_TARGET,
          [hotelId],
        );
        const target = targetResult.rows[0];
        if (!target) {
          await transaction.query("ROLLBACK");
          return null;
        }
        if (Number(target.source_link_count) > 1) {
          throw new Error(
            `Duplicate active canonical booking hotel source links found for booking hotel ${hotelId}`,
          );
        }
        if (!target.propertyId) {
          await transaction.query("ROLLBACK");
          return null;
        }
        await transaction.query(
          `SELECT id
           FROM hotel_catalog.properties
           WHERE id = $1::uuid
           FOR UPDATE`,
          [target.propertyId],
        );
        await transaction.query(
          `SELECT property_id
           FROM booking.booking_settings
           WHERE property_id = $1::uuid
           FOR UPDATE`,
          [target.propertyId],
        );
        const current = await findPropertySettings(hotelId, transaction);
        if (!current) {
          await transaction.query("ROLLBACK");
          return null;
        }

        const result = await transaction.query<TargetBookingPropertySettingsUpdateRow>(
          TARGET_BOOKING_PROPERTY_SETTINGS_UPDATE,
          [hotelId, ...targetPropertySettingsWriteValues(current, settings)],
        );
        const row = result.rows[0];
        if (!row) {
          await transaction.query("ROLLBACK");
          return null;
        }
        if (Number(row.source_link_count) > 1) {
          throw new Error(
            `Duplicate active canonical booking hotel source links found for booking hotel ${hotelId}`,
          );
        }
        if (row.privateContactConflict) {
          throw new BookingContactPublicationConflictError();
        }
        if (!row.id || !row.propertyId) {
          await transaction.query("ROLLBACK");
          return null;
        }

        await syncPropertyOfferReadModels(transaction, {
          propertyId: row.propertyId,
        });
        await transaction.query("COMMIT");
      } catch (error) {
        await transaction.query("ROLLBACK");
        throw error;
      } finally {
        transaction.release();
      }

      return findPropertySettings(hotelId);
    },
    async findAddonSettingsByHotelId(hotelId) {
      const row = await findSettings(hotelId);
      return row ? toTargetAddonSettings(row) : null;
    },
    async findGuestFormSettingsByHotelId(hotelId) {
      const row = await findSettings(hotelId);
      return row ? toTargetGuestFormSettings(row) : null;
    },
    async findBenefitsSettingsByHotelId(hotelId) {
      const row = await findSettings(hotelId);
      return row ? toTargetBenefitsSettings(row) : null;
    },
    async findLocalizationSettingsByHotelId(hotelId) {
      const row = await findSettings(hotelId);
      return row ? toTargetLocalizationSettings(row) : null;
    },
    async findRoomFilterSettingsByHotelId(hotelId) {
      const row = await findSettings(hotelId);
      return row ? toTargetRoomFilterSettings(row) : null;
    },
    async findDesignSettingsByHotelId(hotelId) {
      const row = await findSettings(hotelId);
      return row ? toTargetDesignSettings(row) : null;
    },
    async findLastMinuteSettingsByHotelId(hotelId) {
      const row = await findSettings(hotelId);
      return row ? toTargetLastMinuteSettings(row) : null;
    },
    async updateAddonSettingsByHotelId(hotelId, settings) {
      const row = await updateSettings(
        hotelId,
        `show_addons_step = $2,
         group_addons_by_category = $3`,
        [settings.showAddonsStep, settings.groupAddonsByCategory],
      );
      return row ? toTargetAddonSettings(row) : null;
    },
    async updateGuestFormSettingsByHotelId(hotelId, settings) {
      const row = await updateSettings(
        hotelId,
        `special_requests_enabled = $2,
         arrival_time_enabled = $3,
         guest_count_enabled = $4,
         phone_required = COALESCE($5, phone_required),
         adult_age_threshold = $6,
         children_enabled = $7`,
        [
          settings.specialRequestsEnabled,
          settings.arrivalTimeEnabled,
          settings.guestCountEnabled,
          settings.phoneRequired ?? null,
          settings.adultAgeThreshold,
          settings.childrenEnabled,
        ],
      );
      return row ? toTargetGuestFormSettings(row) : null;
    },
    async updateBenefitsSettingsByHotelId(hotelId, settings) {
      const row = await updateSettings(hotelId, `benefits = $2::jsonb`, [
        JSON.stringify(settings.benefits),
      ]);
      return row ? toTargetBenefitsSettings(row) : null;
    },
    async updateLocalizationSettingsByHotelId(hotelId, settings) {
      const row = await updateSettings(
        hotelId,
        `default_currency = $2,
         default_language = $3,
         supported_currencies = $4::text[],
         supported_languages = $5::text[]`,
        [
          settings.defaultCurrency,
          settings.defaultLanguage,
          settings.supportedCurrencies,
          settings.supportedLanguages,
        ],
      );
      return row ? toTargetLocalizationSettings(row) : null;
    },
    async updateRoomFilterSettingsByHotelId(hotelId, settings) {
      const row = await updateSettings(
        hotelId,
        `booking_filters = $2::jsonb,
         custom_filters = $3::jsonb,
         filter_rooms = $4::jsonb`,
        [
          JSON.stringify(settings.bookingFilters),
          JSON.stringify(settings.customFilters),
          JSON.stringify(settings.filterRooms),
        ],
      );
      return row ? toTargetRoomFilterSettings(row) : null;
    },
    async updateDesignSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<TargetBookingSettingsQueryRow>(
        TARGET_BOOKING_DESIGN_SETTINGS_UPDATE,
        [hotelId, JSON.stringify(settings)],
      );
      const row = toSingleSettingsRow(result, hotelId);
      return row ? toTargetDesignSettings(row) : null;
    },
    async updateLastMinuteSettingsByHotelId(hotelId, settings) {
      const row = await updateSettings(hotelId, `last_minute_discount = $2::jsonb`, [
        JSON.stringify(settings),
      ]);
      return row ? toTargetLastMinuteSettings(row) : null;
    },
    async close() {
      await pool.end();
    },
  };
}

export async function registerBookingSettingsRoutes(
  app: FastifyInstance,
  repository: BookingSettingsReadRepository,
  writeRepository?: BookingSettingsWriteRepository,
  publicBookabilityPublisher?: PublicBookabilityPublicationCommandPort,
  inventoryPublicOfferProjector?: PmsInventoryPublicOfferProjectionPort,
): Promise<void> {
  const closeables = new Set(
    [repository, writeRepository, publicBookabilityPublisher, inventoryPublicOfferProjector].filter(
      Boolean,
    ),
  );
  app.addHook("onClose", async () => {
    await Promise.all([...closeables].map((closeable) => closeable?.close?.()));
  });

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/property-link",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingPropertyLinkError(reply, contractError);
        }
        throw error;
      }

      if (!repository.findPropertyLinkByHotelId) {
        return sendBookingPropertyLinkError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking hotel property link is unavailable.",
        });
      }

      let propertyLink: BookingHotelPropertyLinkReadModel | null;
      try {
        propertyLink = await repository.findPropertyLinkByHotelId(hotelId);
      } catch {
        return sendBookingPropertyLinkError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking hotel property link is unavailable.",
        });
      }

      if (!propertyLink) {
        return sendBookingPropertyLinkError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking hotel property link not found.",
        });
      }

      return toPropertyLinkResponse(hotelId, propertyLink);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/property",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingPropertySettingsError(reply, contractError);
        }
        throw error;
      }

      if (!repository.findPropertySettingsByHotelId) {
        return sendBookingPropertySettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking property settings are unavailable.",
        });
      }

      let settings: BookingPropertySettingsReadModel | null;
      try {
        settings = await repository.findPropertySettingsByHotelId(hotelId);
      } catch {
        return sendBookingPropertySettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking property settings are unavailable.",
        });
      }

      if (!settings) {
        return sendBookingPropertySettingsError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking property settings not found.",
        });
      }

      return toPropertySettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/addons",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingAddonSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingAddonSettingsReadModel | null;
      try {
        settings = await repository.findAddonSettingsByHotelId(hotelId);
      } catch {
        return sendBookingAddonSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking add-on settings are unavailable.",
        });
      }

      if (!settings) {
        return sendBookingAddonSettingsError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking hotel addon settings not found.",
        });
      }

      return toAddonSettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/guest-form",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingGuestFormSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingGuestFormSettingsReadModel | null;
      try {
        settings = await repository.findGuestFormSettingsByHotelId(hotelId);
      } catch {
        return sendBookingGuestFormSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking guest-form settings are unavailable.",
        });
      }

      if (!settings) {
        return sendBookingGuestFormSettingsError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking hotel guest-form settings not found.",
        });
      }

      return toGuestFormSettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/benefits",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingBenefitsSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingBenefitsSettingsReadModel | null;
      try {
        settings = await repository.findBenefitsSettingsByHotelId(hotelId);
      } catch {
        return sendBookingBenefitsSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking benefits settings are unavailable.",
        });
      }

      // Legacy `/admin/benefits` compatibility: a missing hotel row or unset
      // benefits value is an empty hotel-level list, never a 404.
      return toBenefitsSettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/localization",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingLocalizationSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingLocalizationSettingsReadModel | null;
      try {
        settings = await repository.findLocalizationSettingsByHotelId(hotelId);
      } catch {
        return sendBookingLocalizationSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking localization settings are unavailable.",
        });
      }

      if (!settings) {
        return sendBookingLocalizationSettingsError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking hotel localization settings not found.",
        });
      }

      return toLocalizationSettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/room-filters",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingRoomFilterSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingRoomFilterSettingsReadModel | null;
      try {
        settings = (await repository.findRoomFilterSettingsByHotelId?.(hotelId)) ?? null;
      } catch {
        return sendBookingRoomFilterSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking room-filter settings are unavailable.",
        });
      }

      // Legacy design-settings compatibility: missing hotel rows read as empty
      // filter settings after authorization, not as not-found errors.
      return toRoomFilterSettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/design",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) return reply.status(contractError.statusCode).send(contractError);
        throw error;
      }

      if (!repository.findDesignSettingsByHotelId) {
        return reply.status(500).send({
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking design settings are unavailable.",
        });
      }

      let settings: BookingDesignSettingsReadModel | null;
      try {
        settings = await repository.findDesignSettingsByHotelId(hotelId);
      } catch {
        return reply.status(500).send({
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking design settings are unavailable.",
        });
      }

      if (!settings) {
        return reply.status(404).send({
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking hotel design settings not found.",
        });
      }

      return toDesignSettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/last-minute",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingLastMinuteSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingLastMinuteSettingsReadModel | null;
      try {
        settings = (await repository.findLastMinuteSettingsByHotelId?.(hotelId)) ?? null;
      } catch {
        return sendBookingLastMinuteSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking last-minute settings are unavailable.",
        });
      }

      if (!settings) {
        return sendBookingLastMinuteSettingsError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking hotel last-minute settings not found.",
        });
      }

      return toLastMinuteSettingsResponse(settings);
    },
  );

  if (publicBookabilityPublisher) {
    app.post<{ Params: BookingHotelParams }>(
      "/hotels/:hotelId/public-bookability",
      async (request, reply) => {
        const { hotelId } = request.params;

        try {
          enforceBookingSettingsPolicy(request, hotelId);
        } catch (error) {
          const contractError = toBookingSettingsAccessError(error, request, hotelId);
          if (contractError) return sendBookingSettingsWriteError(reply, contractError);
          throw error;
        }

        if (!repository.findPropertyLinkByHotelId) {
          return sendBookingPropertyLinkError(reply, {
            statusCode: 500,
            code: "read_model_unavailable",
            category: "read_model",
            message: "Booking hotel property link is unavailable.",
          });
        }

        let propertyLink: BookingHotelPropertyLinkReadModel | null;
        try {
          propertyLink = await repository.findPropertyLinkByHotelId(hotelId);
        } catch (error) {
          request.log.error({ err: error, hotelId }, "Booking property link read failed");
          return sendBookingPropertyLinkError(reply, {
            statusCode: 500,
            code: "read_model_unavailable",
            category: "read_model",
            message: "Booking hotel property link is unavailable.",
          });
        }

        if (!propertyLink) {
          return sendBookingPropertyLinkError(reply, {
            statusCode: 404,
            code: "not_found",
            category: "read_model",
            message: "Booking hotel property link not found.",
          });
        }

        try {
          let publication = await publicBookabilityPublisher.publish({
            propertyId: propertyLink.propertyId,
          });
          if (!publication) {
            return sendBookingSettingsWriteError(reply, {
              statusCode: 404,
              code: "not_found",
              category: "write_model",
              message: "Canonical property was not found.",
            });
          }
          if (inventoryPublicOfferProjector) {
            const projection = await inventoryPublicOfferProjector.projectPending({
              propertyId: propertyLink.propertyId,
            });
            if (projection.projectedOfferDays > 0) {
              publication = await publicBookabilityPublisher.publish({
                propertyId: propertyLink.propertyId,
              });
              if (!publication) {
                return sendBookingSettingsWriteError(reply, {
                  statusCode: 404,
                  code: "not_found",
                  category: "write_model",
                  message: "Canonical property was not found.",
                });
              }
            }
          }
          return publication;
        } catch (error) {
          request.log.error({ err: error, hotelId }, "Public bookability publication failed");
          return sendBookingSettingsWriteError(reply, {
            statusCode: 500,
            code: "write_model_unavailable",
            category: "write_model",
            message: "Booking preview could not be published.",
          });
        }
      },
    );
  }

  if (!writeRepository) return;

  app.patch<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/property",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parsePropertySettingsWriteBody,
        write: (hotelId, settings, context) => {
          if (!writeRepository.updatePropertySettingsByHotelId) {
            throw new Error("Booking property settings write model is unavailable.");
          }
          return writeRepository.updatePropertySettingsByHotelId(
            hotelId,
            settings,
            context.selectedOrganization.organizationId,
          );
        },
        toResponse: toPropertySettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/addons",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseAddonSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateAddonSettingsByHotelId(hotelId, settings),
        toResponse: toAddonSettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/guest-form",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseGuestFormSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateGuestFormSettingsByHotelId(hotelId, settings),
        toResponse: toGuestFormSettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/benefits",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseBenefitsSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateBenefitsSettingsByHotelId(hotelId, settings),
        toResponse: toBenefitsSettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/localization",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseLocalizationSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateLocalizationSettingsByHotelId(hotelId, settings),
        toResponse: toLocalizationSettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/room-filters",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseRoomFilterSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateRoomFilterSettingsByHotelId(hotelId, settings),
        toResponse: toRoomFilterSettingsResponse,
      }),
  );

  app.patch<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/design",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseDesignSettingsWriteBody,
        write: (hotelId, settings) => {
          if (!writeRepository.updateDesignSettingsByHotelId) {
            throw new Error("Booking design settings write model is unavailable.");
          }
          return writeRepository.updateDesignSettingsByHotelId(hotelId, settings);
        },
        toResponse: toDesignSettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/last-minute",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseLastMinuteSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateLastMinuteSettingsByHotelId
            ? writeRepository.updateLastMinuteSettingsByHotelId(hotelId, settings)
            : Promise.resolve(null),
        toResponse: toLastMinuteSettingsResponse,
      }),
  );
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; details: string[] };

async function handleBookingSettingsWrite<TBody, TStored>(input: {
  request: FastifyRequest<{ Params: BookingHotelParams; Body: unknown }>;
  reply: FastifyReply;
  parseBody(body: unknown): ValidationResult<TBody>;
  write(
    hotelId: string,
    settings: TBody,
    context: ReturnType<typeof enforceRoutePolicy>,
  ): Promise<TStored | null>;
  afterWrite?(
    hotelId: string,
    settings: TBody,
    stored: TStored,
    request: FastifyRequest<{ Params: BookingHotelParams; Body: unknown }>,
  ): Promise<void>;
  toResponse(settings: TStored): unknown;
}): Promise<unknown> {
  const { hotelId } = input.request.params;

  let context: ReturnType<typeof enforceBookingSettingsPolicy>;
  try {
    context = enforceBookingSettingsPolicy(input.request, hotelId);
  } catch (error) {
    const contractError = toBookingSettingsAccessError(error, input.request, hotelId);
    if (contractError) {
      return sendBookingSettingsWriteError(input.reply, contractError);
    }
    throw error;
  }

  const parsed = input.parseBody(input.request.body);
  if (!parsed.ok) {
    return sendBookingSettingsWriteError(input.reply, {
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      message: "Booking settings payload is invalid.",
      details: parsed.details,
    });
  }

  let stored: TStored | null;
  try {
    stored = await input.write(hotelId, parsed.value, context);
  } catch (error) {
    if (error instanceof BookingContactPublicationConflictError) {
      return sendBookingSettingsWriteError(input.reply, {
        statusCode: 409,
        code: "private_contact_conflict",
        category: "validation",
        message: error.message,
      });
    }
    input.request.log.error({ err: error, hotelId }, "Booking settings write failed");
    return sendBookingSettingsWriteError(input.reply, {
      statusCode: 500,
      code: "write_model_unavailable",
      category: "write_model",
      message: "Booking settings could not be saved.",
    });
  }

  if (!stored) {
    return sendBookingSettingsWriteError(input.reply, {
      statusCode: 404,
      code: "not_found",
      category: "write_model",
      message: "Booking settings target not found.",
    });
  }

  await input.afterWrite?.(hotelId, parsed.value, stored, input.request);

  return input.toResponse(stored);
}

function parsePropertySettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingPropertySettingsBody> {
  if (!isPlainRecord(body)) {
    return { ok: false, details: ["body must be an object."] };
  }

  const details: string[] = [];
  const value: UpdateBookingPropertySettingsBody = {};
  const propertyName = expectOptionalRequiredString(body, "property_name", details);
  if (propertyName !== undefined) value.propertyName = propertyName;
  assignOptionalNullableString(value, "reservationEmail", body, "reservation_email", details);
  assignOptionalNullableString(value, "phoneNumber", body, "phone_number", details);
  assignOptionalNullableString(value, "whatsappNumber", body, "whatsapp_number", details);
  assignOptionalNullableString(value, "address", body, "address", details);
  assignOptionalNullableString(value, "city", body, "city", details);
  assignOptionalNullableString(value, "instagram", body, "instagram", details);
  assignOptionalNullableString(value, "facebook", body, "facebook", details);

  const country = expectOptionalNullableString(body, "country", details);
  if (country !== undefined) {
    const normalizedCountry = country?.toUpperCase() ?? null;
    if (normalizedCountry && !/^[A-Z]{2}$/.test(normalizedCountry)) {
      details.push("country must be a two-letter country code.");
    }
    value.country = normalizedCountry;
  }

  const defaultCurrency = expectOptionalCurrencyCode(body, "default_currency", details);
  if (defaultCurrency !== undefined) value.defaultCurrency = defaultCurrency;
  const defaultLanguage = expectOptionalLanguageCode(body, "default_language", details);
  if (defaultLanguage !== undefined) value.defaultLanguage = defaultLanguage;
  const supportedCurrencies = expectOptionalCurrencyList(body, "supported_currencies", details);
  if (supportedCurrencies !== undefined) {
    value.supportedCurrencies =
      defaultCurrency === undefined
        ? supportedCurrencies
        : withoutDefaultCode(supportedCurrencies, defaultCurrency);
  }
  const supportedLanguages = expectOptionalLanguageList(body, "supported_languages", details);
  if (supportedLanguages !== undefined) {
    value.supportedLanguages =
      defaultLanguage === undefined
        ? supportedLanguages
        : withoutDefaultCode(supportedLanguages, defaultLanguage);
  }

  const checkInTime = expectOptionalTime(body, "check_in_time", details);
  if (checkInTime !== undefined) value.checkInTime = checkInTime;
  const checkOutTime = expectOptionalTime(body, "check_out_time", details);
  if (checkOutTime !== undefined) value.checkOutTime = checkOutTime;
  assignOptionalBoolean(value, "specialRequestsEnabled", body, "special_requests_enabled", details);
  assignOptionalBoolean(value, "arrivalTimeEnabled", body, "arrival_time_enabled", details);
  assignOptionalBoolean(value, "guestCountEnabled", body, "guest_count_enabled", details);
  assignOptionalNullableString(
    value,
    "cancellationPolicyText",
    body,
    "cancellation_policy_text",
    details,
  );

  const acceptedPaymentMethods = expectOptionalAcceptedPaymentMethods(body, details);
  if (acceptedPaymentMethods !== undefined) {
    value.acceptedPaymentMethods = acceptedPaymentMethods;
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, value };
}

function parseAddonSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingAddonSettingsBody> {
  const parsed = expectStrictObject(body, ["showAddonsStep", "groupAddonsByCategory"]);
  if (!parsed.ok) return parsed;

  const details: string[] = [];
  const showAddonsStep = expectBoolean(parsed.value, "showAddonsStep", details);
  const groupAddonsByCategory = expectBoolean(parsed.value, "groupAddonsByCategory", details);

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      showAddonsStep,
      groupAddonsByCategory,
    },
  };
}

function parseGuestFormSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingGuestFormSettingsBody> {
  if (!isPlainRecord(body)) {
    return { ok: false, details: ["body must be an object."] };
  }

  const details: string[] = [];
  const expectedKeys = [
    "specialRequestsEnabled",
    "arrivalTimeEnabled",
    "guestCountEnabled",
    "phoneRequired",
    "adultAgeThreshold",
    "childrenEnabled",
  ];
  const requiredKeys = expectedKeys.filter((key) => key !== "phoneRequired");
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(body)) {
    if (!expected.has(key)) details.push(`${key} is not allowed.`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(body, key)) details.push(`${key} is required.`);
  }
  if (details.length > 0) return { ok: false, details };

  const specialRequestsEnabled = expectBoolean(body, "specialRequestsEnabled", details);
  const arrivalTimeEnabled = expectBoolean(body, "arrivalTimeEnabled", details);
  const guestCountEnabled = expectBoolean(body, "guestCountEnabled", details);
  const phoneRequired = Object.hasOwn(body, "phoneRequired")
    ? expectBoolean(body, "phoneRequired", details)
    : undefined;
  const adultAgeThreshold = expectInteger(body, "adultAgeThreshold", details, {
    min: 1,
    max: 120,
  });
  const childrenEnabled = expectBoolean(body, "childrenEnabled", details);

  if (details.length > 0) return { ok: false, details };
  const value: UpdateBookingGuestFormSettingsBody = {
    specialRequestsEnabled,
    arrivalTimeEnabled,
    guestCountEnabled,
    adultAgeThreshold,
    childrenEnabled,
  };
  if (phoneRequired !== undefined) value.phoneRequired = phoneRequired;

  return { ok: true, value };
}

function parseBenefitsSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingBenefitsSettingsBody> {
  const parsed = expectStrictObject(body, ["benefits"]);
  if (!parsed.ok) return parsed;

  const rawBenefits = parsed.value.benefits;
  if (!Array.isArray(rawBenefits)) {
    return { ok: false, details: ["benefits must be an array."] };
  }

  const benefits: string[] = [];
  const seen = new Set<string>();
  const details: string[] = [];
  rawBenefits.forEach((benefit, index) => {
    if (typeof benefit !== "string") {
      details.push(`benefits.${index} must be a string.`);
      return;
    }

    const normalized = benefit.trim();
    if (!normalized) {
      details.push(`benefits.${index} must not be empty.`);
      return;
    }
    if (seen.has(normalized)) {
      details.push(`benefits.${index} duplicates another benefit.`);
      return;
    }

    seen.add(normalized);
    benefits.push(normalized);
  });

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      benefits,
    },
  };
}

function parseLocalizationSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingLocalizationSettingsBody> {
  const parsed = expectStrictObject(body, [
    "defaultCurrency",
    "defaultLanguage",
    "supportedCurrencies",
    "supportedLanguages",
  ]);
  if (!parsed.ok) return parsed;

  const details: string[] = [];
  const defaultCurrency = normalizeCurrencyCode(
    expectString(parsed.value, "defaultCurrency", details),
    "defaultCurrency",
    details,
  );
  const defaultLanguage = normalizeLanguageCode(
    expectString(parsed.value, "defaultLanguage", details),
    "defaultLanguage",
    details,
  );
  const supportedCurrencies = normalizeCurrencyList(
    parsed.value.supportedCurrencies,
    "supportedCurrencies",
    defaultCurrency,
    details,
  );
  const supportedLanguages = normalizeLanguageList(
    parsed.value.supportedLanguages,
    "supportedLanguages",
    defaultLanguage,
    details,
  );

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      defaultCurrency,
      defaultLanguage,
      supportedCurrencies,
      supportedLanguages,
    },
  };
}

function parseRoomFilterSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingRoomFilterSettingsBody> {
  const parsed = expectStrictObject(body, ["bookingFilters", "customFilters", "filterRooms"]);
  if (!parsed.ok) return parsed;

  const details: string[] = [];
  const bookingFilters = normalizeStringArray(
    parsed.value.bookingFilters,
    "bookingFilters",
    details,
  );
  const allowedFilters = new Set(bookingFilters);
  const customFilters = normalizeStringRecord(parsed.value.customFilters, "customFilters", details);
  const filterRooms = normalizeStringArrayRecord(parsed.value.filterRooms, "filterRooms", details);

  for (const key of Object.keys(customFilters)) {
    if (!allowedFilters.has(key)) {
      details.push(`customFilters.${key} must be present in bookingFilters.`);
    }
  }
  for (const key of Object.keys(filterRooms)) {
    if (!allowedFilters.has(key)) {
      details.push(`filterRooms.${key} must be present in bookingFilters.`);
    }
  }

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      bookingFilters,
      customFilters,
      filterRooms,
    },
  };
}

function parseDesignSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingDesignSettingsBody> {
  if (!isPlainRecord(body)) {
    return { ok: false, details: ["body must be an object."] };
  }

  const allowedKeys = new Set([
    "headerLogo",
    "heroImage",
    "heroHeading",
    "heroSubtext",
    "primaryColor",
    "fontPairing",
  ]);
  const details: string[] = [];
  const keys = Object.keys(body);
  for (const key of keys) {
    if (!allowedKeys.has(key)) details.push(`${key} is not allowed.`);
  }
  if (keys.length === 0) details.push("At least one design setting is required.");

  const value: UpdateBookingDesignSettingsBody = {};
  const headerLogo = expectOptionalBoundedString(body, "headerLogo", 2048, details);
  if (headerLogo !== undefined) {
    if (headerLogo && !isHttpUrl(headerLogo)) {
      details.push("headerLogo must be an http or https URL.");
    }
    value.headerLogo = headerLogo;
  }
  const heroImage = expectOptionalBoundedString(body, "heroImage", 2048, details);
  if (heroImage !== undefined) {
    if (heroImage && !isHttpUrl(heroImage)) {
      details.push("heroImage must be an http or https URL.");
    }
    value.heroImage = heroImage;
  }
  const heroHeading = expectOptionalBoundedString(body, "heroHeading", 160, details);
  if (heroHeading !== undefined) value.heroHeading = heroHeading;
  const heroSubtext = expectOptionalBoundedString(body, "heroSubtext", 1000, details);
  if (heroSubtext !== undefined) value.heroSubtext = heroSubtext;

  const primaryColor = expectOptionalBoundedString(body, "primaryColor", 7, details);
  if (primaryColor !== undefined) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(primaryColor)) {
      details.push("primaryColor must be a six-digit hex color.");
    }
    value.primaryColor = primaryColor;
  }

  const fontPairing = expectOptionalBoundedString(body, "fontPairing", 64, details);
  if (fontPairing !== undefined) {
    if (!BOOKING_FONT_PAIRINGS.has(fontPairing)) {
      details.push("fontPairing is not supported.");
    }
    value.fontPairing = fontPairing;
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, value };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function parseLastMinuteSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingLastMinuteSettingsBody> {
  const parsed = expectStrictObject(body, ["enabled", "stackWithPromo", "tiers"]);
  if (!parsed.ok) return parsed;

  const details: string[] = [];
  const enabled = expectBoolean(parsed.value, "enabled", details);
  const stackWithPromo = expectBoolean(parsed.value, "stackWithPromo", details);
  const tiers = normalizeLastMinuteTiers(parsed.value.tiers, details);

  if (!enabled) {
    if (stackWithPromo) details.push("stackWithPromo must be false when enabled is false.");
    if (tiers.length > 0) details.push("tiers must be empty when enabled is false.");
  } else if (tiers.length === 0) {
    details.push("tiers must include at least one tier when enabled is true.");
  }

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      enabled,
      stackWithPromo,
      tiers,
    },
  };
}

export function toAddonSettingsResponse(
  settings: BookingAddonSettingsReadModel,
): BookingAddonSettingsResponse {
  return {
    showAddonsStep: settings.showAddonsStep ?? true,
    groupAddonsByCategory: settings.groupAddonsByCategory ?? true,
  };
}

export function toGuestFormSettingsResponse(
  settings: BookingGuestFormSettingsReadModel,
): BookingGuestFormSettingsResponse {
  return {
    specialRequestsEnabled: settings.specialRequestsEnabled ?? true,
    arrivalTimeEnabled: settings.arrivalTimeEnabled ?? false,
    guestCountEnabled: settings.guestCountEnabled ?? false,
    phoneRequired: settings.phoneRequired ?? true,
    adultAgeThreshold: settings.adultAgeThreshold ?? 18,
    childrenEnabled: settings.childrenEnabled ?? true,
  };
}

export function toBenefitsSettingsResponse(
  settings: BookingBenefitsSettingsReadModel | null,
): BookingBenefitsSettingsResponse {
  return {
    benefits: parseBenefitsValue(settings?.benefits),
  };
}

export function toLocalizationSettingsResponse(
  settings: BookingLocalizationSettingsReadModel,
): BookingLocalizationSettingsResponse {
  return {
    defaultCurrency: settings.defaultCurrency ?? "EUR",
    defaultLanguage: settings.defaultLanguage ?? "en",
    supportedCurrencies: parseStringList(settings.supportedCurrencies, []),
    supportedLanguages: parseStringList(settings.supportedLanguages, ["en"]),
  };
}

export function toRoomFilterSettingsResponse(
  settings: BookingRoomFilterSettingsReadModel | null,
): BookingRoomFilterSettingsResponse {
  return {
    bookingFilters: parseLooseStringList(settings?.bookingFilters),
    customFilters: parseStringRecord(settings?.customFilters),
    filterRooms: parseStringArrayRecord(settings?.filterRooms),
  };
}

export function toDesignSettingsResponse(
  settings: BookingDesignSettingsReadModel,
): BookingDesignSettingsResponse {
  return {
    headerLogo: settings.headerLogo ?? "",
    heroImage: settings.heroImage ?? "",
    heroHeading: settings.heroHeading ?? "",
    heroSubtext: settings.heroSubtext ?? "",
    primaryColor: settings.primaryColor ?? "#4F46E5",
    fontPairing: settings.fontPairing ?? "high-end-serif",
  };
}

export function toLastMinuteSettingsResponse(
  settings: BookingLastMinuteSettingsReadModel,
): BookingLastMinuteSettingsResponse {
  const parsed = parseLastMinuteSettingsValue(settings.lastMinuteDiscount);
  return {
    ...parsed,
    updatedAt: toIsoString(settings.updatedAt),
  };
}

export function toPropertyLinkResponse(
  hotelId: string,
  propertyLink: BookingHotelPropertyLinkReadModel,
): BookingHotelPropertyLinkResponse {
  return {
    hotelId,
    propertyId: propertyLink.propertyId,
    resourceLinks: {
      bookingHotel: true,
      pmsProperty: propertyLink.pmsProperty,
      financeProperty: propertyLink.financeProperty,
    },
  };
}

export function toPropertySettingsResponse(
  settings: BookingPropertySettingsReadModel,
): BookingPropertySettingsResponse {
  const localization = toLocalizationSettingsResponse(settings);
  const guestForm = toGuestFormSettingsResponse(settings);
  const acceptedMethods = parseStringList(settings.acceptedPaymentMethods, []);
  const payAtHotelMethods: string[] = [];
  if (acceptedMethods.includes("cash")) payAtHotelMethods.push("cash");
  if (acceptedMethods.includes("manual_card")) payAtHotelMethods.push("card");

  return {
    id: settings.id,
    property_id: settings.propertyId ?? settings.id,
    booking_hotel_id: settings.bookingHotelId ?? null,
    slug: settings.slug ?? "",
    property_name: settings.propertyName ?? "",
    reservation_email: settings.reservationEmail ?? "",
    phone_number: settings.phoneNumber ?? "",
    whatsapp_number: settings.whatsappNumber ?? "",
    address: settings.address ?? "",
    city: settings.city ?? "",
    country: settings.country ?? "",
    instagram: settings.instagram ?? "",
    facebook: settings.facebook ?? "",
    tiktok: "",
    youtube: "",
    default_currency: localization.defaultCurrency,
    default_language: localization.defaultLanguage,
    supported_currencies: localization.supportedCurrencies,
    supported_languages: localization.supportedLanguages,
    check_in_time: settings.checkInTime ?? "15:00",
    check_out_time: settings.checkOutTime ?? "11:00",
    check_in_from: settings.checkInTime ?? "15:00",
    check_in_until: settings.checkInTime ?? "15:00",
    check_out_from: settings.checkOutTime ?? "11:00",
    check_out_until: settings.checkOutTime ?? "11:00",
    pay_at_property_enabled: acceptedMethods.includes("pay_at_property"),
    pay_at_hotel_methods: payAtHotelMethods,
    online_card_payment: acceptedMethods.some((method) => method === "card" || method === "xendit"),
    bank_transfer: acceptedMethods.includes("bank_transfer"),
    paypal_enabled: false,
    paypal_email: "",
    paypal_payment_window_hours: 24,
    special_requests_enabled: guestForm.specialRequestsEnabled,
    arrival_time_enabled: guestForm.arrivalTimeEnabled,
    guest_count_enabled: guestForm.guestCountEnabled,
    refer_a_guest_enabled: false,
    map_view_enabled: false,
    free_cancellation_days: 7,
    email_notifications: true,
    new_booking_alerts: true,
    payment_alerts: true,
    ota_booking_alerts: false,
    billing_active_plan: "commission",
    billing_commission_rate: 5,
    billing_fixed_fee: 49,
    billing_pending_switch: null,
    billing_switch_effective_date: null,
    payout_account_holder: "",
    payout_account_type: "iban",
    payout_iban: "",
    payout_account_number: "",
    payout_bank_name: "",
    payout_swift: "",
    terms_text: "",
    cancellation_policy_text: settings.cancellationPolicyText ?? "",
    show_room_detail_map: false,
    points_of_interest: [],
  };
}

// Mirrors the legacy booking-api `parse_json` handling of
// `booking_hotels.benefits`: the JSONB value may arrive as a native array, a
// JSON-encoded string, or NULL. NULL, malformed, and non-list values all
// default to an empty list, and non-string entries are dropped rather than
// failing the read.
function parseBenefitsValue(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function parseStringList(value: unknown, fallback: string[]): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fallback;
    }
  }
  if (!Array.isArray(parsed)) return fallback;
  if (!parsed.every((entry) => typeof entry === "string")) return fallback;
  return parsed;
}

function parseLooseStringList(value: unknown): string[] {
  const parsed = parseJsonIfString(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function parseStringRecord(value: unknown): Record<string, string> {
  const parsed = parseJsonIfString(value);
  if (!isPlainRecord(parsed)) return {};

  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function parseStringArrayRecord(value: unknown): Record<string, string[]> {
  const parsed = parseJsonIfString(value);
  if (!isPlainRecord(parsed)) return {};

  return Object.fromEntries(
    Object.entries(parsed).map(([key, entry]) => [
      key,
      Array.isArray(entry)
        ? entry.filter((roomId): roomId is string => typeof roomId === "string")
        : [],
    ]),
  );
}

function parseLastMinuteSettingsValue(value: unknown): UpdateBookingLastMinuteSettingsBody {
  const parsed = parseJsonIfString(value);
  if (!isPlainRecord(parsed)) return DEFAULT_LAST_MINUTE_SETTINGS;

  const enabled = parsed.enabled === true;
  if (!enabled) return DEFAULT_LAST_MINUTE_SETTINGS;

  const stackWithPromo = parsed.stackWithPromo === true;
  const details: string[] = [];
  const tiers = normalizeLastMinuteTiers(parsed.tiers, details);
  if (details.length > 0 || tiers.length === 0) return DEFAULT_LAST_MINUTE_SETTINGS;

  return {
    enabled,
    stackWithPromo,
    tiers,
  };
}

function normalizeLastMinuteTiers(value: unknown, details: string[]): BookingLastMinuteTier[] {
  if (!Array.isArray(value)) {
    details.push("tiers must be an array.");
    return [];
  }

  const tiers: BookingLastMinuteTier[] = [];
  value.forEach((entry, index) => {
    if (!isPlainRecord(entry)) {
      details.push(`tiers.${index} must be an object.`);
      return;
    }

    const parsed = expectStrictObject(entry, ["daysBeforeMin", "daysBeforeMax", "discountPercent"]);
    if (!parsed.ok) {
      details.push(...parsed.details.map((detail) => `tiers.${index}.${detail}`));
      return;
    }

    const daysBeforeMin = expectIntegerAtLeast(
      parsed.value.daysBeforeMin,
      `tiers.${index}.daysBeforeMin`,
      0,
      details,
    );
    const daysBeforeMax =
      parsed.value.daysBeforeMax === null
        ? null
        : expectIntegerAtLeast(
            parsed.value.daysBeforeMax,
            `tiers.${index}.daysBeforeMax`,
            daysBeforeMin,
            details,
          );
    const discountPercent = expectNumberInRange(
      parsed.value.discountPercent,
      `tiers.${index}.discountPercent`,
      0,
      100,
      details,
    );

    tiers.push({
      daysBeforeMin,
      daysBeforeMax,
      discountPercent,
    });
  });

  const sorted = tiers
    .map((tier, index) => ({ tier, index }))
    .sort((left, right) => left.tier.daysBeforeMin - right.tier.daysBeforeMin);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    const previousMax = previous.tier.daysBeforeMax ?? Number.POSITIVE_INFINITY;
    if (current.tier.daysBeforeMin <= previousMax) {
      details.push(`tiers.${current.index} overlaps tiers.${previous.index}.`);
    }
  }

  return tiers;
}

type NullablePropertySettingsStringKey =
  | "reservationEmail"
  | "phoneNumber"
  | "whatsappNumber"
  | "address"
  | "city"
  | "instagram"
  | "facebook"
  | "cancellationPolicyText";

type BooleanPropertySettingsKey =
  | "specialRequestsEnabled"
  | "arrivalTimeEnabled"
  | "guestCountEnabled";

function assignOptionalNullableString(
  target: UpdateBookingPropertySettingsBody,
  targetKey: NullablePropertySettingsStringKey,
  record: Record<string, unknown>,
  sourceKey: string,
  details: string[],
): void {
  const value = expectOptionalNullableString(record, sourceKey, details);
  if (value !== undefined) target[targetKey] = value;
}

function assignOptionalBoolean(
  target: UpdateBookingPropertySettingsBody,
  targetKey: BooleanPropertySettingsKey,
  record: Record<string, unknown>,
  sourceKey: string,
  details: string[],
): void {
  const value = expectOptionalBoolean(record, sourceKey, details);
  if (value !== undefined) target[targetKey] = value;
}

function expectOptionalRequiredString(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "string") {
    details.push(`${key} must be a string.`);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    details.push(`${key} must not be empty.`);
    return undefined;
  }
  return normalized;
}

function expectOptionalNullableString(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): string | null | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    details.push(`${key} must be a string or null.`);
    return undefined;
  }
  return nullableText(value);
}

function expectOptionalBoundedString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
  details: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "string") {
    details.push(`${key} must be a string.`);
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    details.push(`${key} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function expectOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): boolean | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "boolean") {
    details.push(`${key} must be a boolean.`);
    return undefined;
  }
  return value;
}

function expectOptionalTime(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): string | null | undefined {
  const value = expectOptionalNullableString(record, key, details);
  if (value === undefined || value === null) return value;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    details.push(`${key} must be a HH:MM time.`);
  }
  return value;
}

function expectOptionalCurrencyCode(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return normalizeCurrencyCode(expectString(record, key, details), key, details);
}

function expectOptionalLanguageCode(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return normalizeLanguageCode(expectString(record, key, details), key, details);
}

function expectOptionalCurrencyList(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): string[] | undefined {
  return expectOptionalCodeList(record, key, details, normalizeCurrencyCode);
}

function expectOptionalLanguageList(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): string[] | undefined {
  return expectOptionalCodeList(record, key, details, normalizeLanguageCode);
}

function expectOptionalCodeList(
  record: Record<string, unknown>,
  key: string,
  details: string[],
  normalize: (value: string | undefined, path: string, details: string[]) => string,
): string[] | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (!Array.isArray(value)) {
    details.push(`${key} must be an array.`);
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      details.push(`${key}.${index} must be a string.`);
      return;
    }
    const normalized = normalize(entry, `${key}.${index}`, details);
    if (!normalized) return;
    if (seen.has(normalized)) {
      details.push(`${key}.${index} duplicates another code.`);
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function expectOptionalAcceptedPaymentMethods(
  record: Record<string, unknown>,
  details: string[],
): string[] | undefined {
  const paymentKeys = [
    "pay_at_property_enabled",
    "pay_at_hotel_methods",
    "online_card_payment",
    "bank_transfer",
  ];
  if (!paymentKeys.some((key) => Object.hasOwn(record, key))) return undefined;
  for (const key of paymentKeys) {
    if (!Object.hasOwn(record, key)) {
      details.push(`${key} is required when updating payment methods.`);
    }
  }

  const payAtPropertyEnabled = expectOptionalBoolean(record, "pay_at_property_enabled", details);
  const onlineCardPayment = expectOptionalBoolean(record, "online_card_payment", details);
  const bankTransfer = expectOptionalBoolean(record, "bank_transfer", details);
  const payAtHotelMethods = expectPayAtHotelMethods(record, details);
  if (payAtPropertyEnabled && payAtHotelMethods.length === 0) {
    details.push(
      "pay_at_hotel_methods must include cash or card when pay_at_property_enabled is true.",
    );
  }

  const methods: string[] = [];
  if (payAtPropertyEnabled) {
    methods.push("pay_at_property");
    if (payAtHotelMethods.includes("cash")) methods.push("cash");
    if (payAtHotelMethods.includes("card")) methods.push("manual_card");
  }
  if (onlineCardPayment) methods.push("card");
  if (bankTransfer) methods.push("bank_transfer");
  return [...new Set(methods)];
}

function expectPayAtHotelMethods(record: Record<string, unknown>, details: string[]): string[] {
  const value = record.pay_at_hotel_methods;
  if (!Array.isArray(value)) {
    details.push("pay_at_hotel_methods must be an array.");
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      details.push(`pay_at_hotel_methods.${index} must be a string.`);
      return;
    }
    const normalized = entry.trim();
    if (normalized !== "cash" && normalized !== "card") {
      details.push(`pay_at_hotel_methods.${index} must be cash or card.`);
      return;
    }
    if (seen.has(normalized)) {
      details.push(`pay_at_hotel_methods.${index} duplicates another method.`);
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function expectIntegerAtLeast(
  value: unknown,
  path: string,
  min: number,
  details: string[],
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    details.push(`${path} must be an integer greater than or equal to ${min}.`);
    return min;
  }
  return value;
}

function expectInteger(
  record: Record<string, unknown>,
  key: string,
  details: string[],
  options: { min: number; max: number },
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < options.min ||
    value > options.max
  ) {
    details.push(`${key} must be an integer between ${options.min} and ${options.max}.`);
    return options.min;
  }
  return value;
}

function expectNumberInRange(
  value: unknown,
  path: string,
  minExclusive: number,
  maxInclusive: number,
  details: string[],
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= minExclusive ||
    value > maxInclusive
  ) {
    details.push(`${path} must be greater than ${minExclusive} and no more than ${maxInclusive}.`);
    return minExclusive;
  }
  return value;
}

function expectStrictObject(
  value: unknown,
  expectedKeys: readonly string[],
): ValidationResult<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return { ok: false, details: ["body must be an object."] };
  }

  const details: string[] = [];
  const expected = new Set(expectedKeys);
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!expected.has(key)) {
      details.push(`${key} is not allowed.`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      details.push(`${key} is required.`);
    }
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, value };
}

function expectBoolean(record: Record<string, unknown>, key: string, details: string[]): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    details.push(`${key} must be a boolean.`);
    return false;
  }
  return value;
}

function expectString(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    details.push(`${key} must be a string.`);
    return undefined;
  }
  return value;
}

function normalizeCurrencyCode(value: string | undefined, path: string, details: string[]): string {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(normalized)) {
    details.push(`${path} must be a three-letter currency code.`);
  }
  return normalized;
}

function normalizeLanguageCode(value: string | undefined, path: string, details: string[]): string {
  const normalized = value?.trim() ?? "";
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(normalized)) {
    details.push(`${path} must be a non-empty language code.`);
  }
  return normalized;
}

function normalizeCurrencyList(
  value: unknown,
  path: string,
  defaultCurrency: string,
  details: string[],
): string[] {
  return normalizeUniqueCodeList(value, path, defaultCurrency, details, (entry, entryPath) =>
    normalizeCurrencyCode(entry, entryPath, details),
  );
}

function normalizeLanguageList(
  value: unknown,
  path: string,
  defaultLanguage: string,
  details: string[],
): string[] {
  return normalizeUniqueCodeList(value, path, defaultLanguage, details, (entry, entryPath) =>
    normalizeLanguageCode(entry, entryPath, details),
  );
}

function normalizeUniqueCodeList(
  value: unknown,
  path: string,
  defaultValue: string,
  details: string[],
  normalize: (value: string | undefined, path: string) => string,
): string[] {
  if (!Array.isArray(value)) {
    details.push(`${path} must be an array.`);
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      details.push(`${path}.${index} must be a string.`);
      return;
    }

    const normalized = normalize(entry, `${path}.${index}`);
    if (!normalized || normalized === defaultValue) return;
    if (seen.has(normalized)) {
      details.push(`${path}.${index} duplicates another code.`);
      return;
    }

    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function normalizeStringArray(value: unknown, path: string, details: string[]): string[] {
  if (!Array.isArray(value)) {
    details.push(`${path} must be an array.`);
    return [];
  }

  const result: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      details.push(`${path}.${index} must be a string.`);
      return;
    }

    const normalized = entry.trim();
    if (!normalized) {
      details.push(`${path}.${index} must not be empty.`);
      return;
    }
    result.push(normalized);
  });
  return result;
}

function normalizeStringRecord(
  value: unknown,
  path: string,
  details: string[],
): Record<string, string> {
  if (!isPlainRecord(value)) {
    details.push(`${path} must be an object.`);
    return {};
  }

  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) {
      details.push(`${path} contains an empty key.`);
      continue;
    }
    if (Object.hasOwn(result, key)) {
      details.push(`${path}.${key} duplicates another key after trimming.`);
      continue;
    }
    if (typeof rawValue !== "string") {
      details.push(`${path}.${key} must be a string.`);
      continue;
    }

    const normalizedValue = rawValue.trim();
    if (!normalizedValue) {
      details.push(`${path}.${key} must not be empty.`);
      continue;
    }
    result[key] = normalizedValue;
  }
  return result;
}

function normalizeStringArrayRecord(
  value: unknown,
  path: string,
  details: string[],
): Record<string, string[]> {
  if (!isPlainRecord(value)) {
    details.push(`${path} must be an object.`);
    return {};
  }

  const result: Record<string, string[]> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) {
      details.push(`${path} contains an empty key.`);
      continue;
    }
    if (Object.hasOwn(result, key)) {
      details.push(`${path}.${key} duplicates another key after trimming.`);
      continue;
    }
    result[key] = normalizeStringArray(rawValue, `${path}.${key}`, details);
  }
  return result;
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toIsoString(value: string | Date | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return new Date(0).toISOString();
}

function sendBookingAddonSettingsError(
  reply: FastifyReply,
  error: BookingAddonSettingsError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingGuestFormSettingsError(
  reply: FastifyReply,
  error: BookingGuestFormSettingsError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingBenefitsSettingsError(
  reply: FastifyReply,
  error: BookingBenefitsSettingsError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingLocalizationSettingsError(
  reply: FastifyReply,
  error: BookingLocalizationSettingsError | BookingSettingsAccessError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingRoomFilterSettingsError(
  reply: FastifyReply,
  error: BookingRoomFilterSettingsError | BookingSettingsAccessError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingLastMinuteSettingsError(
  reply: FastifyReply,
  error: BookingLastMinuteSettingsError | BookingSettingsAccessError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingPropertyLinkError(
  reply: FastifyReply,
  error: BookingHotelPropertyLinkError | BookingSettingsAccessError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingPropertySettingsError(
  reply: FastifyReply,
  error: BookingHotelPropertyLinkError | BookingSettingsAccessError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingSettingsWriteError(
  reply: FastifyReply,
  error: BookingSettingsWriteError | BookingSettingsAccessError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

type BookingSettingsAccessError = {
  statusCode: 401 | 403;
  code: BookingSettingsAuthorizationErrorCode | "unauthenticated";
  category: "authentication" | "authorization";
  message: string;
};

type BookingSettingsAuthorizationErrorCode =
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access";

function enforceBookingSettingsPolicy(
  request: FastifyRequest,
  hotelId: string,
): ReturnType<typeof enforceRoutePolicy> {
  return enforceRoutePolicy(request, {
    permission: "booking.settings.manage",
    entitlement: {
      product: "booking",
      key: "booking-engine",
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: hotelId,
      },
    },
    resource: {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: hotelId,
      allowedRelationships: ["owner", "operator"],
    },
  });
}

function toBookingSettingsAccessError(
  error: unknown,
  request: FastifyRequest,
  hotelId: string,
): BookingSettingsAccessError | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toBookingSettingsAuthorizationErrorCode(error.message, request, hotelId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toBookingSettingsAuthorizationMessage(code),
  };
}

function toBookingSettingsAuthorizationErrorCode(
  message: string,
  request: FastifyRequest,
  hotelId: string,
): BookingSettingsAuthorizationErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactiveBookingSettingsEntitlement(request, hotelId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function toBookingSettingsAuthorizationMessage(
  code: BookingSettingsAuthorizationErrorCode,
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required booking settings permission.";
    case "inactive_entitlement":
      return "Booking engine entitlement is not active.";
    case "missing_entitlement":
      return "Missing active booking engine entitlement.";
    case "missing_resource_access":
      return "Missing booking hotel access.";
  }
}

function hasInactiveBookingSettingsEntitlement(request: FastifyRequest, hotelId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (entitlement.product !== "booking" || entitlement.key !== "booking-engine") {
        return false;
      }
      if (entitlement.status === "active") return false;
      if (!entitlement.resource) return true;
      return (
        entitlement.resource.product === "booking" &&
        entitlement.resource.resourceType === "booking_hotel" &&
        entitlement.resource.resourceId === hotelId
      );
    }) ?? false
  );
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}
