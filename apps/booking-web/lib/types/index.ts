export interface HotelContact {
  address: string;
  phone: string;
  email: string;
  whatsapp?: string;
  website?: string;
}

export interface HotelSocialLinks {
  facebook?: string;
  instagram?: string;
  tiktok?: string;
  youtube?: string;
}

export interface HotelBranding {
  heroImage?: string;
  heroHeading?: string;
  heroSubtext?: string;
  primaryColor?: string;
  accentColor?: string;
  fontPairing?: string;
  logoUrl?: string;
  faviconUrl?: string;
}

export interface HotelHeaderSettings {
  showContactButton: boolean;
  showReferAGuestButton: boolean;
  showLanguageSelector: boolean;
  showCurrencySelector: boolean;
}

export interface GuestTypeSettings {
  adultAgeThreshold: number;
  childrenEnabled: boolean;
}

export interface Hotel {
  id: string;
  name: string;
  slug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  customDomainUrl?: string | null;
  description: string;
  location: string;
  country: string;
  starRating: number;
  currency: string;
  supportedCurrencies: string[];
  heroImage: string;
  images: string[];
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  timezone?: string;
  contact: HotelContact;
  bookingFilters: string[];
  customFilters?: Record<string, string>;
  filterRooms?: Record<string, string[]>;
  socialLinks?: HotelSocialLinks;
  branding?: HotelBranding;
  headerSettings?: HotelHeaderSettings;
  defaultLanguage: string;
  supportedLanguages: string[];
  guestTypeSettings?: GuestTypeSettings;
  referAGuestEnabled?: boolean;
  instantBook?: boolean;
}

export interface RoomType {
  id: string;
  name: string;
  category?: string;
  description: string;
  shortDescription: string;
  maxOccupancy: number;
  maxAdults?: number | null;
  maxChildren?: number | null;
  size: number;
  baseRate: number;
  nonRefundableRate: number | null;
  nightlyRates?: number[];
  nonRefundableNightlyRates?: number[];
  originalNightlyRates?: number[];
  currency: string;
  locationAddress?: string;
  latitude?: number | null;
  longitude?: number | null;
  amenities: string[];
  images: string[];
  bedType: string;
  remainingRooms: number;
  features: string[];
  benefits: string[];
  flexibleRateEnabled: boolean;
  cancellationPolicy?: string;
  flexibleCancellationType?: "free" | "partial_refund";
  partialRefundCancelWindowDays?: number;
  partialRefundAmountPercent?: number;
  partialRefundTiers?: { minDaysBeforeCheckIn: number; refundPercent: number }[];
  originalRate?: number | null;
  promotion?: { name: string; discountAmount: number; discountPercent: number };
  nonRefundablePromotion?: { name: string; discountAmount: number; discountPercent: number };
  lastMinuteDiscountPercent?: number | null;
  ratePaymentMethods?: Record<string, string[]> | null;
  rateDepositSettings?: Record<
    string,
    {
      enabled: boolean;
      percentage: number | null;
    }
  > | null;
}

export interface SearchParams {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
}

export interface Booking {
  canEditRequest?: boolean;
  id: string;
  bookingReference: string;
  hotelName: string;
  roomName: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  nightlyRate: number;
  // VAY-403: rooms booked in this reservation. Optional for backward
  // compatibility with cached/legacy booking shapes; treat missing as 1.
  numberOfRooms?: number;
  totalAmount: number;
  depositRequired?: boolean;
  depositPercentage?: number | null;
  depositAmount?: number;
  balanceAmount?: number;
  addonTotal?: number;
  // Selected add-ons snapshot from booking creation. Names are cached at
  // booking time so historical bookings still show the correct name even
  // if the addon is later renamed or removed.
  addonIds?: string[];
  addonNames?: string[];
  addonQuantities?: Record<string, number>;
  addonPackageQuantities?: Record<string, number>;
  addonDates?: Record<string, string[]>;
  currency: string;
  // 'draft' is the placeholder shape returned for the card-payment flow
  // before the booking row is materialized (VAY-388).
  status:
    | "confirmed"
    | "pending"
    | "cancelled"
    | "declined"
    | "expired"
    | "draft"
    | "checked_in"
    | "checked_out";
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  paymentDeadline?: string | null;
  bankTransferDetails?: string | null;
  unitNames?: string[];
  cancelledAt?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  hostResponseDeadline?: string | null;
  createdAt: string;
}

export interface Addon {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  image: string;
  images?: string[];
  maxQuantity?: number;
  leadTime?: string;
  duration?: string;
  perPerson?: boolean;
  perNight?: boolean;
  location?: string;
  maxGuests?: string;
  highlights?: string[];
  includedItems?: string[];
}
