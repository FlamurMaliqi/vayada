import type {
  HotelCatalogStep1ReadModel,
  PropertyMediaAssignment,
  ReadinessErrorSource,
  ResolvedPublicHotelMedia,
  SourceEntityRevision,
} from "@vayada/domain-hotels";

export const BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION = "booking-design-renderer.v1" as const;
export const BOOKING_DESIGN_COVER_FALLBACK_PATH = "/vayada-logo.png" as const;

export type BookingDesignCatalogEvidencePortKey = "profile" | "cover_assignment" | "safe_media";
export type BookingDesignCatalogSourceRevision = Readonly<
  SourceEntityRevision & { ownerDomain: "hotel_catalog" }
>;
export type BookingDesignCatalogEvidenceFailure<
  Port extends BookingDesignCatalogEvidencePortKey = BookingDesignCatalogEvidencePortKey,
> =
  | Readonly<{ outcome: "missing"; evidencePort: Port; code: string }>
  | Readonly<{ outcome: "stale"; evidencePort: Port; code: string }>
  | Readonly<{
      outcome: "unavailable";
      evidencePort: Port;
      code: string;
      errorSource: ReadinessErrorSource;
    }>;
export type BookingDesignCatalogProfileEvidence = Readonly<{
  outcome: "evidence";
  evidencePort: "profile";
  organizationId: string;
  propertyId: string;
  source: BookingDesignCatalogSourceRevision;
  profile: Readonly<{
    contractVersion: HotelCatalogStep1ReadModel["contractVersion"];
    profileRevision: HotelCatalogStep1ReadModel["profileRevision"];
    displayName: HotelCatalogStep1ReadModel["displayName"];
    contentLocale: HotelCatalogStep1ReadModel["profile"]["locale"];
    shortDescription: NonNullable<HotelCatalogStep1ReadModel["profile"]["shortDescription"]>;
  }>;
}>;
export type BookingDesignCatalogCoverAssignmentEvidence = Readonly<{
  outcome: "evidence";
  evidencePort: "cover_assignment";
  organizationId: string;
  propertyId: string;
  source: BookingDesignCatalogSourceRevision;
  /** Null is explicit current no-assignment evidence, never a missing-evidence fallback. */
  cover: null | Readonly<Pick<PropertyMediaAssignment, "mediaObjectId" | "altText">>;
}>;
export type BookingDesignCatalogSafeMediaEvidence = Readonly<{
  outcome: "evidence";
  evidencePort: "safe_media";
  organizationId: string;
  propertyId: string;
  source: BookingDesignCatalogSourceRevision;
  media: ResolvedPublicHotelMedia;
}>;

type EvidenceRequest = Readonly<{ organizationId: string; propertyId: string }>;
export interface BookingDesignCatalogProfileEvidencePort {
  readonly bookingDesignCatalogEvidencePort: "profile";
  getBookingDesignProfileEvidence(
    input: EvidenceRequest,
  ): Promise<BookingDesignCatalogProfileEvidence | BookingDesignCatalogEvidenceFailure<"profile">>;
}
export interface BookingDesignCatalogCoverAssignmentEvidencePort {
  readonly bookingDesignCatalogEvidencePort: "cover_assignment";
  getBookingDesignCoverAssignmentEvidence(
    input: EvidenceRequest,
  ): Promise<
    | BookingDesignCatalogCoverAssignmentEvidence
    | BookingDesignCatalogEvidenceFailure<"cover_assignment">
  >;
}
export interface BookingDesignCatalogSafeMediaEvidencePort {
  readonly bookingDesignCatalogEvidencePort: "safe_media";
  getBookingDesignSafeMediaEvidence(
    input: EvidenceRequest & Readonly<{ mediaObjectId: string }>,
  ): Promise<
    BookingDesignCatalogSafeMediaEvidence | BookingDesignCatalogEvidenceFailure<"safe_media">
  >;
}
