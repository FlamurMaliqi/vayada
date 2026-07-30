import type {
  ProductReadinessResult,
  ReadinessProduct,
} from "./onboardingReadiness.js";

export const MARKETPLACE_MODERATION_STATUSES = [
  "pending",
  "changes_requested",
  "approved",
  "rejected",
  "withdrawn",
] as const;

export const MARKETPLACE_ACTIVATION_STATUSES = ["active", "suspended", "deactivated"] as const;

export type MarketplaceModerationStatus = (typeof MARKETPLACE_MODERATION_STATUSES)[number];
export type MarketplaceActivationStatus = (typeof MARKETPLACE_ACTIVATION_STATUSES)[number];

declare const marketplaceSubmissionRevisionId: unique symbol;
declare const bookingContentRevisionId: unique symbol;

export type MarketplaceSubmissionRevisionId = string & {
  readonly [marketplaceSubmissionRevisionId]: true;
};
export type BookingContentRevisionId = string & {
  readonly [bookingContentRevisionId]: true;
};

export type OnboardingLifecycleJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OnboardingLifecycleJsonValue[]
  | { readonly [key: string]: OnboardingLifecycleJsonValue };

export type OnboardingLifecycleJsonObject = {
  readonly [key: string]: OnboardingLifecycleJsonValue;
};

type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

export type ReadyProductReadinessEvidence<TProduct extends ReadinessProduct> = DeepReadonly<
  Pick<
    ProductReadinessResult,
    | "contractVersion"
    | "propertyId"
    | "sourceManifest"
    | "sourceManifestHash"
    | "readinessHash"
  > & {
    product: TProduct;
    status: "ready";
  }
>;

type ImmutableRevision<TProduct extends ReadinessProduct> = Readonly<{
  propertyId: string;
  revisionNumber: number;
  readiness: ReadyProductReadinessEvidence<TProduct>;
}>;

export type MarketplaceSubmissionRevision = ImmutableRevision<"marketplace"> &
  Readonly<{
    revisionId: MarketplaceSubmissionRevisionId;
    organizationId: string;
    submissionSnapshot: OnboardingLifecycleJsonObject;
    submittedByUserId: string;
    submittedAt: string;
  }>;

export type MarketplaceSubmissionModeration = {
  revisionId: MarketplaceSubmissionRevisionId;
  propertyId: string;
  status: MarketplaceModerationStatus;
  decidedByUserId: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
};

export type MarketplaceSubmissionActivation = {
  propertyId: string;
  revisionId: MarketplaceSubmissionRevisionId;
  status: MarketplaceActivationStatus;
  activatedByUserId: string;
  activatedAt: string;
  statusChangedByUserId: string;
  statusReason: string | null;
  updatedAt: string;
};

/** Marketplace owns submission snapshots, moderation, and its active pointer. */
export interface MarketplaceSubmissionLifecyclePort {
  appendRevision(
    input: Omit<MarketplaceSubmissionRevision, "revisionId" | "revisionNumber">,
  ): Promise<MarketplaceSubmissionRevision>;
  recordModeration(input: {
    revisionId: MarketplaceSubmissionRevisionId;
    propertyId: string;
    expectedStatus: "pending";
    status: Exclude<MarketplaceModerationStatus, "pending">;
    decidedByUserId: string;
    decisionReason?: string;
  }): Promise<MarketplaceSubmissionModeration>;
  activateApproved(input: {
    propertyId: string;
    revisionId: MarketplaceSubmissionRevisionId;
    expectedActiveRevisionId: MarketplaceSubmissionRevisionId | null;
    activatedByUserId: string;
  }): Promise<MarketplaceSubmissionActivation>;
  setActivationStatus(input: {
    propertyId: string;
    expectedStatus: MarketplaceActivationStatus;
    status: MarketplaceActivationStatus;
    changedByUserId: string;
    reason: string;
  }): Promise<MarketplaceSubmissionActivation>;
  getActivation(propertyId: string): Promise<MarketplaceSubmissionActivation | null>;
}

export type BookingContentRevision = ImmutableRevision<"booking"> &
  Readonly<{
    revisionId: BookingContentRevisionId;
    publicContent: OnboardingLifecycleJsonObject;
    builtByUserId: string;
    builtAt: string;
  }>;

export type BookingActiveContentPointer = {
  propertyId: string;
  revisionId: BookingContentRevisionId;
  activatedByUserId: string;
  activatedAt: string;
};

/**
 * Distribution owns immutable Booking content and its independently moved pointer.
 * A revision is unpublished until this pointer references it; publication
 * attempt/recovery state belongs to the later publication-command slice.
 */
export interface BookingContentLifecyclePort {
  appendRevision(
    input: Omit<BookingContentRevision, "revisionId" | "revisionNumber">,
  ): Promise<BookingContentRevision>;
  activate(input: {
    propertyId: string;
    revisionId: BookingContentRevisionId;
    expectedActiveRevisionId: BookingContentRevisionId | null;
    activatedByUserId: string;
  }): Promise<BookingActiveContentPointer>;
  getActive(propertyId: string): Promise<BookingActiveContentPointer | null>;
}

export type LiveAriWatermark = {
  propertyId: string;
  watermarkRevision: number;
  sourceRevision: string;
  materializedThrough: string | null;
  observedAt: string;
  projectedAt: string;
};

/** Live ARI advances independently of immutable Booking content publication. */
export interface LiveAriWatermarkPort {
  get(propertyId: string): Promise<LiveAriWatermark | null>;
  advance(input: {
    propertyId: string;
    expectedWatermarkRevision: number;
    sourceRevision: string;
    materializedThrough: string | null;
    observedAt: string;
    projectedAt: string;
  }): Promise<LiveAriWatermark>;
}
